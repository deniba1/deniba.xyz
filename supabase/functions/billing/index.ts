// Roblox Alt Checker - accounts & billing Edge Function (Deno).
//
// GET  /billing/price           -> public: the Pro price, read from Stripe
// POST /billing/checkout        -> signed in: Stripe Checkout URL for Pro
// POST /billing/portal          -> signed in: Stripe Billing Portal URL
// POST /billing/delete-account  -> signed in: cancel Pro and delete the account
// POST /billing/webhook         -> Stripe: keeps profiles.plan in sync
//
// Secrets (set with `supabase secrets set` or in the dashboard):
//   STRIPE_SECRET_KEY      sk_test_... / sk_live_... (a restricted key works too)
//   STRIPE_PRICE_ID        price_... of the recurring Pro price
//   STRIPE_WEBHOOK_SECRET  whsec_... of the webhook endpoint pointing at /billing/webhook
//   SITE_URL               where the site lives, e.g. https://checker.example.com
//   ALLOWED_ORIGIN         CORS origin (default "*")
//   STRIPE_AUTOMATIC_TAX   "1" to have Stripe Tax calculate tax at checkout
//
// Signed-in routes expect `Authorization: Bearer <Supabase access token>`.

const STRIPE_SECRET_KEY = (Deno.env.get("STRIPE_SECRET_KEY") ?? "").trim();
const STRIPE_PRICE_ID = (Deno.env.get("STRIPE_PRICE_ID") ?? "").trim();
const STRIPE_WEBHOOK_SECRET = (Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "").trim();
const STRIPE_AUTOMATIC_TAX = Deno.env.get("STRIPE_AUTOMATIC_TAX") === "1";
const STRIPE_API = (Deno.env.get("STRIPE_API_BASE") ?? "https://api.stripe.com").replace(/\/+$/, ""); // tests only
const SITE_URL = (Deno.env.get("SITE_URL") ?? "").replace(/\/+$/, "");
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SERVICE_HEADERS = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

// deno-lint-ignore no-explicit-any
type Json = any;

/** An error whose message is safe to show to the person using the site. */
class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Statuses that keep Pro switched on. past_due stays on while Stripe retries the card.
const PAID_STATUSES = ["active", "trialing", "past_due"];

// ---------------------------------------------------------------------------
// Supabase helpers (service role)
// ---------------------------------------------------------------------------
async function db(path: string, init: { method?: string; body?: Json; prefer?: string } = {}): Promise<Json> {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...SERVICE_HEADERS,
      "Content-Type": "application/json",
      ...(init.prefer ? { Prefer: init.prefer } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`database ${resp.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

interface User {
  id: string;
  email: string;
}

async function requireUser(req: Request): Promise<User> {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new HttpError(401, "Sign in first.", "auth");
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (resp.status === 401 || resp.status === 403) {
    await resp.body?.cancel();
    throw new HttpError(401, "Your session has expired. Sign in again.", "auth");
  }
  if (!resp.ok) throw new Error(`auth ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const user = await resp.json();
  if (!UUID.test(user?.id ?? "")) throw new HttpError(401, "Sign in first.", "auth");
  return { id: user.id, email: user.email ?? "" };
}

const PROFILE_COLUMNS = "id,plan,stripe_customer_id,stripe_subscription_id";

async function profileById(userId: string): Promise<Json | null> {
  return (await db(`profiles?id=eq.${userId}&select=${PROFILE_COLUMNS}`))?.[0] ?? null;
}

async function profileByCustomer(customerId: string): Promise<Json | null> {
  return (await db(`profiles?stripe_customer_id=eq.${encodeURIComponent(customerId)}&select=${PROFILE_COLUMNS}`))?.[0] ?? null;
}

/** Create or update a profile row. */
const saveProfile = (userId: string, fields: Json) =>
  db("profiles?on_conflict=id", {
    method: "POST",
    body: { id: userId, ...fields, updated_at: new Date().toISOString() },
    prefer: "resolution=merge-duplicates,return=minimal",
  });

// ---------------------------------------------------------------------------
// Stripe helpers (plain REST; no SDK)
// ---------------------------------------------------------------------------
class StripeError extends Error {
  constructor(public status: number, message: string, public code: string, public param: string) {
    super(message);
  }
}

/** Flatten {a: {b: [1]}} into Stripe's form encoding: a[b][0]=1. */
function formEncode(params: Json, prefix = "", out = new URLSearchParams()): URLSearchParams {
  for (const [k, v] of Object.entries(params)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (typeof v === "object") formEncode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function stripe(method: string, path: string, params?: Json, idempotencyKey?: string): Promise<Json> {
  const headers: Record<string, string> = { Authorization: `Bearer ${STRIPE_SECRET_KEY}` };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  let url = `${STRIPE_API}/v1/${path}`;
  let body: string | undefined;
  if (params && method === "GET") url += `?${formEncode(params)}`;
  else if (params) {
    body = formEncode(params).toString();
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  const resp = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(20000) });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    const err = data?.error ?? {};
    throw new StripeError(resp.status, err.message ?? `Stripe HTTP ${resp.status}`, err.code ?? "", err.param ?? "");
  }
  return data;
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Check a Stripe-Signature header: HMAC-SHA256 of "<t>.<raw body>", at most 5 minutes old. */
async function validSignature(payload: string, header: string): Promise<boolean> {
  let t = "";
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.trim().split("=");
    if (k === "t") t = v ?? "";
    else if (k === "v1" && v) v1.push(v);
  }
  if (!/^\d+$/.test(t) || !v1.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(STRIPE_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)));
  return v1.some((sig) => timingSafeEqual(mac, sig));
}

// ---------------------------------------------------------------------------
// Subscription sync
// ---------------------------------------------------------------------------
async function listSubscriptions(customerId: string): Promise<Json[]> {
  return (await stripe("GET", "subscriptions", { customer: customerId, status: "all", limit: 20 })).data ?? [];
}

/**
 * Copy a subscription's current state from Stripe into the owner's profile.
 * Events can arrive late or out of order, so this always re-reads the
 * subscription instead of trusting the event payload.
 */
async function syncSubscription(subscriptionId: string, userIdHint?: string): Promise<void> {
  const sub = await stripe("GET", `subscriptions/${encodeURIComponent(subscriptionId)}`);
  const customerId: string = typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? "";
  const hinted = [sub.metadata?.user_id, userIdHint].find((id) => UUID.test(id ?? ""));
  const profile = (hinted && await profileById(hinted)) || (customerId && await profileByCustomer(customerId));
  if (!profile) {
    // Normal after an account deletion: the cancellation event outlives the account.
    console.warn("subscription has no matching account", sub.id, customerId);
    return;
  }

  const paid = PAID_STATUSES.includes(sub.status);
  // An old subscription ending must not downgrade someone who has since started a new one.
  if (!paid && profile.stripe_subscription_id && profile.stripe_subscription_id !== sub.id) return;

  // Newer Stripe API versions report the period on the subscription item.
  const periodEnd: number | undefined = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end;
  await saveProfile(profile.id, {
    plan: paid ? "pro" : "free",
    stripe_customer_id: customerId || profile.stripe_customer_id,
    stripe_subscription_id: sub.id,
    subscription_status: sub.status,
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    cancel_at_period_end: Boolean(sub.cancel_at_period_end || sub.cancel_at),
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
function requireBilling() {
  if (!STRIPE_SECRET_KEY || !STRIPE_PRICE_ID || !SITE_URL) {
    throw new HttpError(503, "Payments aren't set up on this site yet.", "unconfigured");
  }
}

let priceCache: [number, Json] | null = null;

async function getPrice(): Promise<Json> {
  if (!STRIPE_SECRET_KEY || !STRIPE_PRICE_ID) return { configured: false };
  if (priceCache && Date.now() - priceCache[0] < 600_000) return priceCache[1];
  const p = await stripe("GET", `prices/${encodeURIComponent(STRIPE_PRICE_ID)}`);
  const price = {
    configured: true,
    amount: p.unit_amount,
    currency: p.currency,
    interval: p.recurring?.interval ?? null,
    intervalCount: p.recurring?.interval_count ?? 1,
  };
  priceCache = [Date.now(), price];
  return price;
}

async function createCustomer(user: User): Promise<string> {
  const customer = await stripe("POST", "customers", { email: user.email, metadata: { user_id: user.id } });
  await saveProfile(user.id, { stripe_customer_id: customer.id });
  return customer.id;
}

// The saved customer can belong to another Stripe account or mode (test vs live), or be deleted.
const customerGone = (e: unknown) => e instanceof StripeError && e.code === "resource_missing";

async function checkout(user: User): Promise<Json> {
  requireBilling();
  const profile = await profileById(user.id);
  let customerId: string = profile?.stripe_customer_id ?? "";

  // Never sell a second subscription: ask Stripe, since the webhook may lag.
  if (customerId) {
    let subs: Json[] = [];
    try {
      subs = await listSubscriptions(customerId);
    } catch (e) {
      if (!customerGone(e)) throw e;
      customerId = "";
    }
    const current = subs.find((s) => PAID_STATUSES.includes(s.status));
    if (current) {
      await syncSubscription(current.id, user.id);
      throw new HttpError(409, "You already have Pro. Manage it from your account page.", "already_pro");
    }
  }
  if (!customerId) customerId = await createCustomer(user);

  const createSession = (customer: string) =>
    stripe("POST", "checkout/sessions", {
      mode: "subscription",
      customer,
      client_reference_id: user.id,
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      subscription_data: { metadata: { user_id: user.id } },
      allow_promotion_codes: true,
      success_url: `${SITE_URL}/account.html?checkout=success`,
      cancel_url: `${SITE_URL}/pricing.html?checkout=cancelled`,
      ...(STRIPE_AUTOMATIC_TAX ? { automatic_tax: { enabled: true }, customer_update: { address: "auto" } } : {}),
    });
  let session: Json;
  try {
    session = await createSession(customerId);
  } catch (e) {
    if (!(customerGone(e) && (e as StripeError).param === "customer")) throw e;
    session = await createSession(await createCustomer(user));
  }
  return { url: session.url };
}

async function portal(user: User): Promise<Json> {
  requireBilling();
  const customerId = (await profileById(user.id))?.stripe_customer_id;
  if (!customerId) throw new HttpError(400, "There's no billing history on this account yet.", "no_customer");
  const session = await stripe("POST", "billing_portal/sessions", {
    customer: customerId,
    return_url: `${SITE_URL}/account.html`,
  });
  return { url: session.url };
}

async function deleteAccount(user: User): Promise<Json> {
  const customerId = (await profileById(user.id))?.stripe_customer_id;
  if (customerId && STRIPE_SECRET_KEY) {
    let subs: Json[] = [];
    try {
      subs = await listSubscriptions(customerId);
    } catch (e) {
      if (!customerGone(e)) throw e;
    }
    // Stop billing before the account goes; a failure here aborts the deletion.
    for (const s of subs) {
      if (!["canceled", "incomplete_expired"].includes(s.status)) await stripe("DELETE", `subscriptions/${s.id}`);
    }
  }
  await db(`usage?subject=eq.${encodeURIComponent(`u:${user.id}`)}`, { method: "DELETE" });
  // Deleting the auth user cascades to the profile row.
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user.id}`, {
    method: "DELETE",
    headers: SERVICE_HEADERS,
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`delete user ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  await resp.body?.cancel();
  return { deleted: true };
}

async function webhook(req: Request): Promise<Response> {
  if (!STRIPE_WEBHOOK_SECRET || !STRIPE_SECRET_KEY) return json(503, { error: "Webhook isn't configured." });
  const payload = await req.text();
  if (!(await validSignature(payload, req.headers.get("stripe-signature") ?? ""))) {
    return json(400, { error: "Bad signature" });
  }
  const event = JSON.parse(payload);
  const obj = event?.data?.object ?? {};
  try {
    if (event.type === "checkout.session.completed") {
      if (obj.mode === "subscription" && obj.subscription) {
        await syncSubscription(String(obj.subscription), obj.client_reference_id ?? undefined);
      }
    } else if (String(event.type).startsWith("customer.subscription.")) {
      await syncSubscription(obj.id);
    }
  } catch (e) {
    // A non-2xx makes Stripe retry the event later.
    console.error("webhook failed", event.type, event.id, e);
    return json(500, { error: "Webhook handler failed" });
  }
  return json(200, { received: true });
}

// ---------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------
const CORS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (status: number, payload: Json) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const route = new URL(req.url).pathname.replace(/\/+$/, "").split("/").pop() ?? "";

  try {
    if (route === "price" && req.method === "GET") return json(200, await getPrice());
    if (req.method !== "POST") return json(404, { error: "not found" });
    if (route === "webhook") return await webhook(req);
    if (route === "checkout") return json(200, await checkout(await requireUser(req)));
    if (route === "portal") return json(200, await portal(await requireUser(req)));
    if (route === "delete-account") return json(200, await deleteAccount(await requireUser(req)));
    return json(404, { error: "not found" });
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message, code: e.code });
    console.error("billing request failed", route, e);
    if (e instanceof StripeError) return json(502, { error: "The payment provider returned an error. Try again in a minute." });
    return json(500, { error: "Internal error" });
  }
});
