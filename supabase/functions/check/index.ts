// Roblox Alt Checker - Supabase Edge Function (Deno).
//
// GET  ?q=<username|userId>[&fresh=1]  -> lookup JSON
// GET  ?health=1                       -> {ok, badgeCheck}
//
// Secrets (set with `supabase secrets set` or in the dashboard):
//   ROBLOX_COOKIE       optional .ROBLOSECURITY; enables the player-badge check
//   CACHE_TTL           seconds to cache a lookup (default 600)
//   RATE_LIMIT_PER_MIN  lookups per client IP per minute (default 20)
//   ALLOWED_ORIGIN      CORS origin (default "*")
//
// This is a line-for-line port of checker.py; keep the two in sync.

const ROBLOX_COOKIE = (Deno.env.get("ROBLOX_COOKIE") ?? "").trim();
const CACHE_TTL = Number(Deno.env.get("CACHE_TTL") ?? "600");
const RATE_LIMIT_PER_MIN = Number(Deno.env.get("RATE_LIMIT_PER_MIN") ?? "20");
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";

const WEARABLE_TYPES =
  "Hat,HairAccessory,FaceAccessory,NeckAccessory,ShoulderAccessory," +
  "FrontAccessory,BackAccessory,WaistAccessory,Shirt,Pants,TShirt,Face,Gear";

// ---------------------------------------------------------------------------
// Roblox HTTP helpers
// ---------------------------------------------------------------------------
class RobloxError extends Error {}
class NotFound extends RobloxError {}

// deno-lint-ignore no-explicit-any
type Json = any;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let csrfToken = "";

interface CallOpts {
  method?: string;
  body?: Json;
  auth?: boolean;
  csrf?: boolean;
  retries?: number;
}

/** Call a Roblox API. Retries on 429/network errors; csrf=true handles X-CSRF-TOKEN. */
async function roblox(url: string, opts: CallOpts = {}): Promise<Json> {
  const { method = "GET", body, auth = false, csrf = false, retries = 4 } = opts;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "RobloxAltChecker/1.0",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth && ROBLOX_COOKIE) headers["Cookie"] = `.ROBLOSECURITY=${ROBLOX_COOKIE}`;

  for (let attempt = 0; attempt < retries; attempt++) {
    if (csrf) headers["X-CSRF-TOKEN"] = csrfToken;
    let resp: Response;
    try {
      resp = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      if (attempt < retries - 1) {
        await sleep(1000);
        continue;
      }
      throw new RobloxError(`network error: ${e}`);
    }
    if (resp.ok) {
      const text = await resp.text();
      return text ? JSON.parse(text) : null;
    }
    if (resp.status === 429 && attempt < retries - 1) {
      await resp.body?.cancel();
      await sleep(2000 * (attempt + 1));
      continue;
    }
    const fresh = resp.headers.get("x-csrf-token");
    if (csrf && resp.status === 403 && fresh && attempt < retries - 1) {
      csrfToken = fresh;
      await resp.body?.cancel();
      continue;
    }
    const payload = await resp.text();
    let msg = "";
    try {
      msg = JSON.parse(payload)?.errors?.[0]?.message ?? "";
    } catch {
      msg = payload.slice(0, 200);
    }
    if (resp.status === 404) throw new NotFound(msg || "not found");
    throw new RobloxError(`HTTP ${resp.status}: ${msg || "error"}`);
  }
  throw new RobloxError("retries exhausted");
}

/** Follow Roblox cursor pagination. Returns [items, truncated]. */
async function pageAll(
  url: string,
  params: Record<string, string> = {},
  opts: { auth?: boolean; maxPages?: number; limit?: number } = {},
): Promise<[Json[], boolean]> {
  const { auth = false, maxPages = 3, limit = 100 } = opts;
  const items: Json[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < maxPages; i++) {
    const qs = new URLSearchParams({ ...params, limit: String(limit) });
    if (cursor) qs.set("cursor", cursor);
    const page = await roblox(`${url}?${qs}`, { auth });
    items.push(...(page?.data ?? []));
    cursor = page?.nextPageCursor ?? null;
    if (!cursor) return [items, false];
  }
  return [items, true];
}

/** Turn a username or numeric id into a users.roblox.com profile. */
async function resolveUser(query: string): Promise<Json> {
  query = query.trim().replace(/^@/, "");
  if (!query) throw new NotFound("Enter a username or user ID.");
  if (/^\d+$/.test(query)) {
    try {
      return await roblox(`https://users.roblox.com/v1/users/${query}`);
    } catch (e) {
      if (!(e instanceof NotFound)) throw e;
    }
  }
  const res = await roblox("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    body: { usernames: [query], excludeBannedUsers: false },
  });
  const match = res?.data?.[0];
  if (!match) throw new NotFound(`No Roblox user named '${query}'.`);
  return await roblox(`https://users.roblox.com/v1/users/${match.id}`);
}

/**
 * Split catalog assets into [paid, free] counts. Paid = known price > 0, a
 * resale price > 0, or a Limited item. Free, off-sale-at-zero and unknown
 * items all count as free.
 */
async function itemPrices(assetIds: number[]): Promise<[number, number]> {
  let paid = 0, free = 0;
  const ids = [...new Set(assetIds)];
  for (let start = 0; start < ids.length; start += 100) {
    const chunk = ids.slice(start, start + 100);
    const res = await roblox("https://catalog.roblox.com/v1/catalog/items/details", {
      method: "POST",
      body: { items: chunk.map((id) => ({ itemType: "Asset", id })) },
      csrf: true,
    });
    let seen = 0;
    for (const d of res?.data ?? []) {
      seen++;
      if ((d.price ?? 0) > 0 || (d.lowestPrice ?? 0) > 0 ||
        (d.itemRestrictions ?? []).includes("Limited")) paid++;
      else free++;
    }
    free += chunk.length - seen;
  }
  return [paid, free];
}

// ---------------------------------------------------------------------------
// Data collection
// ---------------------------------------------------------------------------
type Result = { ok: true; data: Json } | { ok: false; error: string };

async function collect(uid: number, username: string): Promise<Record<string, Result>> {
  const U = `https://users.roblox.com/v1/users/${uid}`;
  const F = `https://friends.roblox.com/v1/users/${uid}`;

  /** A 403 on inventory means it's private: that's data, not an error. */
  const privateOk = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof RobloxError && String(e.message).includes("HTTP 403")) return null;
      throw e;
    }
  };

  const tasks: Record<string, () => Promise<Json>> = {
    previousNames: async () => {
      const [items] = await pageAll(`${U}/username-history`, { sortOrder: "Asc" }, { maxPages: 2 });
      return items.map((i) => i.name);
    },
    friends: async () => (await roblox(`${F}/friends/count`)).count,
    followers: async () => (await roblox(`${F}/followers/count`)).count,
    following: async () => (await roblox(`${F}/followings/count`)).count,
    robloxBadges: async () =>
      (await roblox(`https://accountinformation.roblox.com/v1/users/${uid}/roblox-badges`)).map(
        (b: Json) => b.name,
      ),
    playerBadges: async () => {
      if (!ROBLOX_COOKIE) throw new RobloxError("not checked: server has no ROBLOX_COOKIE configured");
      const [items, truncated] = await pageAll(
        `https://badges.roblox.com/v1/users/${uid}/badges`,
        { sortOrder: "Asc" },
        { auth: true, maxPages: 5 },
      );
      let earliest: string | null = null;
      for (const b of items) {
        const d = b.awardedDate || b.created || "";
        if (d && (earliest === null || d < earliest)) earliest = d;
      }
      return { count: items.length, truncated, earliest, sample: items.slice(0, 8).map((b) => b.name) };
    },
    favorites: async () => {
      const [items, truncated] = await pageAll(
        `https://games.roblox.com/v2/users/${uid}/favorite/games`, {}, { maxPages: 2, limit: 50 },
      );
      return { count: items.length, truncated, sample: items.slice(0, 6).map((g) => g.name) };
    },
    inventoryVisible: async () =>
      (await roblox(`https://inventory.roblox.com/v1/users/${uid}/can-view-inventory`)).canView,
    collectibles: async () => {
      const res = await privateOk(() =>
        pageAll(`https://inventory.roblox.com/v1/users/${uid}/assets/collectibles`, {}, { maxPages: 2 })
      );
      if (res === null) return null;
      const [items, truncated] = res;
      const rap = items.reduce((s, i) => s + (i.recentAveragePrice ?? 0), 0);
      return { count: items.length, truncated, rap, sample: items.slice(0, 6).map((i) => i.name) };
    },
    wearables: async () => {
      const res = await privateOk(() =>
        pageAll(`https://inventory.roblox.com/v2/users/${uid}/inventory`, { assetTypes: WEARABLE_TYPES }, { maxPages: 1 })
      );
      if (res === null) return null;
      const [items, truncated] = res;
      let oldest: string | null = null;
      for (const i of items) {
        const d = i.created || "";
        if (d && (oldest === null || d < oldest)) oldest = d;
      }
      const [paid, free] = await itemPrices(items.map((i) => i.assetId));
      return { count: items.length, paid, free, truncated, oldest };
    },
    groups: async () => {
      const data = (await roblox(`https://groups.roblox.com/v1/users/${uid}/groups/roles`)).data ?? [];
      return {
        count: data.length,
        sample: data.slice(0, 6).map((g: Json) => g.group.name),
        owned: data.filter((g: Json) => g.role?.rank === 255).length,
      };
    },
    createdGames: async () => {
      let [items, truncated] = await pageAll(
        `https://games.roblox.com/v2/users/${uid}/games`, {}, { maxPages: 1, limit: 50 },
      );
      // Roblox auto-names new places "<user>'s Place" or "<user>'s Place Number: N".
      const esc = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const defaultName = new RegExp(`^${esc}'s place( number: ?\\d+)?$`, "i");
      items = items.filter((g) => !defaultName.test((g.name ?? "").replace(/’/g, "'").trim()));
      return {
        count: items.length,
        truncated,
        visits: items.reduce((s, g) => s + (g.placeVisits ?? 0), 0),
        sample: items.slice(0, 4).map((g) => g.name),
      };
    },
    avatar: async () => {
      const a = await roblox(`https://avatar.roblox.com/v1/users/${uid}/avatar`);
      return { type: a.playerAvatarType ?? null, assetCount: (a.assets ?? []).length };
    },
    headshot: async () => {
      const r = await roblox(
        `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${uid}&size=150x150&format=Png&isCircular=false`,
      );
      return r?.data?.[0]?.imageUrl ?? null;
    },
    presence: async () => {
      const r = await roblox("https://presence.roblox.com/v1/presence/users", {
        method: "POST",
        body: { userIds: [uid] },
      });
      const p = r?.userPresences?.[0] ?? {};
      const kind = ({ 0: "Offline", 1: "Online", 2: "In game", 3: "In Studio" } as Record<number, string>)[
        p.userPresenceType
      ] ?? "Unknown";
      return { status: kind, lastLocation: p.lastLocation ?? null };
    },
  };

  // Run with at most 4 in flight to stay under Roblox's burst limits.
  const keys = Object.keys(tasks);
  const out: Record<string, Result> = {};
  let next = 0;
  const worker = async () => {
    while (next < keys.length) {
      const k = keys[next++];
      try {
        out[k] = { ok: true, data: await tasks[k]() };
      } catch (e) {
        const msg = e instanceof RobloxError ? e.message : `unexpected: ${e}`;
        out[k] = { ok: false, error: msg };
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return out;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------
interface Signal {
  points: number;
  label: string;
  detail: string;
  category: string;
}

const fmt = (n: number) => n.toLocaleString("en-US");

function score(user: Json, d: Record<string, Result>) {
  const signals: Signal[] = [];
  const sig = (points: number, label: string, detail: string, category: string) =>
    signals.push({ points, label, detail, category });
  const get = (key: string): Json => {
    const v = d[key];
    return v && v.ok ? v.data : null;
  };

  const name: string = user.name ?? "";
  const display: string = user.displayName ?? "";
  const created = user.created ? Date.parse(user.created) : NaN;
  const ageDays = Number.isNaN(created) ? null : Math.floor((Date.now() - created) / 86_400_000);

  // Account age
  if (ageDays !== null) {
    if (ageDays < 7) sig(30, "Brand-new account", `Created ${ageDays} day(s) ago.`, "age");
    else if (ageDays < 30) sig(22, "Very young account", `Created ${ageDays} days ago.`, "age");
    else if (ageDays < 90) sig(14, "Young account", `Created ${ageDays} days ago.`, "age");
    else if (ageDays < 365) sig(6, "Under a year old", `Created ${ageDays} days ago.`, "age");
    else if (ageDays < 3 * 365) sig(-4, "Established account", `About ${Math.floor(ageDays / 365)} year(s) old.`, "age");
    else sig(-12, "Long-standing account", `About ${Math.floor(ageDays / 365)} years old.`, "age");
  }

  // Verification / ban
  if (user.hasVerifiedBadge) sig(-30, "Verified badge", "Roblox-verified accounts are essentially never throwaway alts.", "identity");
  if (user.isBanned) sig(0, "Account is banned", "Ban status is informational; it does not change the score.", "identity");

  // Social
  const friends = get("friends");
  if (friends !== null) {
    if (friends === 0) sig(12, "No friends", "Zero friends on the account.", "social");
    else if (friends < 5) sig(7, "Very few friends", `${friends} friend(s).`, "social");
    else if (friends >= 50) sig(-10, "Large friend list", `${fmt(friends)} friends.`, "social");
    else if (friends >= 15) sig(-6, "Healthy friend list", `${fmt(friends)} friends.`, "social");
    else sig(0, "Some friends", `${fmt(friends)} friends.`, "social");
  }
  const followers = get("followers");
  if (followers !== null) {
    if (followers === 0) sig(5, "No followers", "Nobody follows this account.", "social");
    else if (followers >= 100) sig(-8, "Many followers", `${fmt(followers)} followers.`, "social");
    else if (followers >= 20) sig(-4, "Some followers", `${followers} followers.`, "social");
  }
  const following = get("following");
  if (following !== null) {
    if (following === 0) sig(3, "Follows nobody", "Not following anyone.", "social");
    else if (following >= 10) sig(-2, "Follows others", `Following ${fmt(following)} accounts.`, "social");
  }
  const groups = get("groups");
  if (groups) {
    if (groups.count === 0) sig(6, "No groups", "Not a member of any group.", "social");
    else if (groups.count >= 10) sig(-6, "Many groups", `Member of ${groups.count} groups.`, "social");
    else if (groups.count >= 3) sig(-3, "In a few groups", `Member of ${groups.count} groups.`, "social");
    if (groups.owned) sig(-4, "Owns a group", `Owner of ${groups.owned} group(s).`, "social");
  }

  // Activity
  const rb = get("robloxBadges");
  if (rb !== null) {
    if (rb.length === 0) sig(8, "No Roblox badges", "None of the official Roblox badges (Welcome to the Club, Friendship, etc).", "activity");
    else if (rb.length >= 3) sig(-6, "Several Roblox badges", rb.slice(0, 4).join(", ") + (rb.length > 4 ? "…" : ""), "activity");
    else sig(-2, "Has a Roblox badge", rb.join(", "), "activity");
  }
  const pb = get("playerBadges");
  if (pb) {
    const c = pb.count;
    if (c === 0) sig(12, "No player badges", "Has never earned a badge in any game.", "activity");
    else if (c < 10) sig(6, "Few player badges", `${c} game badges.`, "activity");
    else if (c >= 100) sig(-12, "Lots of player badges", `${c}${pb.truncated ? "+" : ""} game badges.`, "activity");
    else if (c >= 30) sig(-7, "Plenty of player badges", `${c} game badges.`, "activity");
    else sig(-3, "Some player badges", `${c} game badges.`, "activity");
  }
  const fav = get("favorites");
  if (fav) {
    if (fav.count === 0) sig(6, "No favorite games", "Never favorited a game.", "activity");
    else if (fav.count >= 15) sig(-5, "Many favorite games", `${fav.count}${fav.truncated ? "+" : ""} favorites.`, "activity");
    else sig(-2, "Some favorite games", `${fav.count} favorites.`, "activity");
  }
  const cg = get("createdGames");
  if (cg && cg.count > 0) {
    sig(cg.visits >= 1000 ? -10 : -5, "Has created games", `${cg.count} public place(s), ${fmt(cg.visits)} visits.`, "activity");
  }

  // Inventory / avatar
  const visible = get("inventoryVisible");
  const col = get("collectibles");
  if (visible === false && !(col && col.count)) {
    sig(4, "Inventory is private", "Cannot count items; alts often hide or have empty inventories, but so do many mains.", "inventory");
  }
  if (col) {
    if (col.count > 0) {
      const pts = col.rap >= 50_000 ? -14 : col.rap >= 5_000 ? -9 : -6;
      sig(pts, "Owns limited items", `${col.count}${col.truncated ? "+" : ""} collectibles, RAP ${fmt(col.rap)}.`, "inventory");
    } else if (visible) sig(3, "No limited items", "Owns no collectibles.", "inventory");
  }
  const wear = get("wearables");
  if (wear) {
    const { paid, free } = wear;
    const more = wear.truncated ? "+" : "";
    if (wear.count === 0) sig(6, "Empty wardrobe", "No hats, accessories, or clothing in inventory.", "inventory");
    else if (paid === 0) sig(5, "Only free items", `${free}${more} wearables, none of them paid.`, "inventory");
    else if (paid >= 40) sig(-6, "Large paid wardrobe", `${paid}${more} paid wearables (${free} free ignored).`, "inventory");
    else if (paid >= 10) sig(-3, "Decent paid wardrobe", `${paid} paid wearables (${free} free ignored).`, "inventory");
    else sig(2, "Few paid items", `${paid} paid wearable(s) (${free} free ignored).`, "inventory");
  }
  const av = get("avatar");
  if (av) {
    if (av.assetCount === 0) sig(6, "Default avatar", "Wearing nothing at all.", "inventory");
    else if (av.assetCount <= 2) sig(3, "Barely customized avatar", `Wearing ${av.assetCount} item(s).`, "inventory");
    else if (av.assetCount >= 6) sig(-3, "Customized avatar", `Wearing ${av.assetCount} items.`, "inventory");
  }

  // Naming / profile
  const prev = get("previousNames");
  if (prev && prev.length) sig(-4, "Changed username before", `Previously: ${prev.slice(0, 4).join(", ")}.`, "identity");
  if (display && display.toLowerCase() === name.toLowerCase()) sig(2, "Display name never set", "Display name still matches the username.", "identity");
  const m = name.match(/(\d{3,})$/);
  if (m) sig(4, "Username ends in digits", `Ends in ${m[1].length} digits, typical of auto-generated or bulk-made names.`, "identity");
  if (/(alt|alt\d|_alt|2nd|second|backup|spare|temp)/i.test(name)) sig(15, "Username says it's an alt", `'${name}' contains an alt-style keyword.`, "identity");
  const desc = (user.description ?? "").trim();
  if (!desc) sig(3, "Empty profile description", "No 'About' text.", "identity");
  else if (/\b(alt|alt account|main is|my main|main acc)\b/i.test(desc)) sig(20, "Description mentions an alt/main", "The profile text talks about a main or alt account.", "identity");
  else sig(-2, "Has a profile description", "Wrote something in 'About'.", "identity");

  let total = Math.max(0, Math.min(100, 35 + signals.reduce((s, x) => s + x.points, 0)));
  if (user.hasVerifiedBadge) total = Math.min(total, 10);

  let verdict: string, summary: string;
  if (total >= 70) [verdict, summary] = ["Likely alt", "Most signals point to a throwaway or secondary account."];
  else if (total >= 50) [verdict, summary] = ["Possibly alt", "Mixed signals; leans toward an alt or a very inactive account."];
  else if (total >= 30) [verdict, summary] = ["Probably main", "Looks like a real, moderately active account."];
  else [verdict, summary] = ["Likely main", "Strong history and activity for a primary account."];

  signals.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  return { total, verdict, summary, signals, ageDays };
}

async function lookup(query: string) {
  const user = await resolveUser(query);
  const uid: number = user.id;
  const data = await collect(uid, user.name ?? "");
  const { total, verdict, summary, signals, ageDays } = score(user, data);
  const val = (k: string) => (data[k].ok ? (data[k] as { data: Json }).data : null);
  const notes = Object.entries(data)
    .filter(([, v]) => !v.ok)
    .map(([k, v]) => {
      const err = (v as { error: string }).error;
      return `${k}: ${err.includes("HTTP 429") ? "rate limited by Roblox (HTTP 429), try again in a minute" : err}`;
    });
  return {
    user: {
      id: uid,
      name: user.name,
      displayName: user.displayName,
      description: user.description ?? "",
      created: user.created,
      accountAgeDays: ageDays,
      isBanned: Boolean(user.isBanned),
      hasVerifiedBadge: Boolean(user.hasVerifiedBadge),
      avatarUrl: val("headshot"),
      profileUrl: `https://www.roblox.com/users/${uid}/profile`,
    },
    stats: {
      friends: val("friends"),
      followers: val("followers"),
      following: val("following"),
      robloxBadges: val("robloxBadges"),
      playerBadges: val("playerBadges"),
      favorites: val("favorites"),
      inventoryVisible: val("inventoryVisible"),
      collectibles: val("collectibles"),
      wearables: val("wearables"),
      groups: val("groups"),
      createdGames: val("createdGames"),
      avatar: val("avatar"),
      presence: val("presence"),
      previousNames: val("previousNames"),
    },
    score: total,
    verdict,
    summary,
    signals,
    notes,
    checkedAt: new Date().toISOString().slice(0, 19) + "+00:00",
  };
}

// ---------------------------------------------------------------------------
// Cache + rate limit (per warm isolate; best-effort, resets on cold start)
// ---------------------------------------------------------------------------
const cache = new Map<string, [number, Json]>();
const hits = new Map<string, number[]>();

async function cachedLookup(query: string, fresh: boolean) {
  const key = query.trim().toLowerCase().replace(/^@/, "");
  const now = Date.now() / 1000;
  if (!fresh) {
    const hit = cache.get(key);
    if (hit && now - hit[0] < CACHE_TTL) return { ...hit[1], cached: true };
  }
  const result = await lookup(query);
  // A partly rate-limited result is cached only briefly so a re-check can fill it in.
  const stamp = result.notes.some((n: string) => n.includes("429")) ? now - CACHE_TTL + 30 : now;
  cache.set(key, [stamp, result]);
  cache.set(String(result.user.id), [stamp, result]);
  cache.set((result.user.name ?? "").toLowerCase(), [stamp, result]);
  if (cache.size > 2000) {
    for (const k of [...cache.keys()].slice(0, 500)) cache.delete(k);
  }
  return { ...result, cached: false };
}

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const q = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (q.length >= RATE_LIMIT_PER_MIN) {
    hits.set(ip, q);
    return true;
  }
  q.push(now);
  hits.set(ip, q);
  return false;
}

// ---------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------
const CORS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (status: number, payload: Json) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return json(405, { error: "GET only" });
  const url = new URL(req.url);
  if (url.searchParams.has("health")) return json(200, { ok: true, badgeCheck: Boolean(ROBLOX_COOKIE) });

  const q = url.searchParams.get("q") ?? "";
  const fresh = url.searchParams.get("fresh") === "1";
  if (!q.trim()) return json(400, { error: "Missing ?q=username-or-id" });
  if (q.length > 40) return json(400, { error: "Query too long" });
  const ip = (req.headers.get("x-forwarded-for") ?? req.headers.get("cf-connecting-ip") ?? "unknown")
    .split(",")[0].trim();
  if (rateLimited(ip)) return json(429, { error: "Slow down: too many lookups this minute." });

  try {
    return json(200, await cachedLookup(q, fresh));
  } catch (e) {
    if (e instanceof NotFound) return json(404, { error: e.message });
    if (e instanceof RobloxError) return json(502, { error: `Roblox API error: ${e.message}` });
    console.error("lookup failed", q, e);
    return json(500, { error: "Internal error" });
  }
});
