// Roblox Alt Checker - Supabase Edge Function (Deno).
//
// GET  ?q=<username|userId>[&fresh=1]  -> lookup JSON (+ quota when accounts are on)
// GET  ?q=<username|userId>&deep=1     -> lookup JSON + "deep": the friends analysis
// GET  ?quota=1                        -> the caller's plan and today's allowance
// GET  ?health=1                       -> {ok, badgeCheck, accounts}
//
// Send `Authorization: Bearer <Supabase access token>` to be counted as that
// account; without it the caller is a guest, counted by network address.
//
// Secrets (set with `supabase secrets set` or in the dashboard):
//   ROBLOX_COOKIE       optional .ROBLOSECURITY; enables the player-badge check
//   CACHE_TTL           seconds to cache a lookup (default 600)
//   ALLOWED_ORIGIN      CORS origin (default "*")
//   GUEST_DAILY_LIMIT   lookups per day without an account (default 3)
//   FREE_DAILY_LIMIT    lookups per day on a free account (default 10)
//   PRO_DAILY_LIMIT     lookups per day on Pro (default 500)
//   DEEP_GUEST_DAILY_LIMIT / DEEP_FREE_DAILY_LIMIT / DEEP_PRO_DAILY_LIMIT
//                       deep checks per day (defaults 0 / 1 / 10)
//   DEEP_GLOBAL_PER_MIN deep checks per minute across the whole site, Pro
//                       included: Roblox caps how fast friends can be read (default 3)
//   DEEP_SAMPLE         friends profiled one by one in a deep check (default 20)
//   IP_DAILY_LIMIT      non-Pro lookups per day from one network, across all
//                       its guests and free accounts (default 40)
//   GLOBAL_DAILY_LIMIT  non-Pro lookups per day across the whole site (default 5000)
//   RATE_LIMIT_PER_MIN  new lookups per minute per network and per account (default 20)
//   GLOBAL_PER_MIN      non-Pro new lookups per minute across the whole site (default 60)
//   REQUESTS_PER_MIN    requests of any kind per minute per network (default 120)
//   IP_HASH_SALT        optional salt for the network-address hash
//
// The Roblox and scoring sections are a line-for-line port of checker.py; keep
// the two in sync. Accounts and quotas exist only here.

const ROBLOX_COOKIE = (Deno.env.get("ROBLOX_COOKIE") ?? "").trim();
const CACHE_TTL = Number(Deno.env.get("CACHE_TTL") ?? "600");
const RATE_LIMIT_PER_MIN = Number(Deno.env.get("RATE_LIMIT_PER_MIN") ?? "20");
const GLOBAL_PER_MIN = Number(Deno.env.get("GLOBAL_PER_MIN") ?? "60");
const REQUESTS_PER_MIN = Number(Deno.env.get("REQUESTS_PER_MIN") ?? "120");
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";

// Supabase injects these into every Edge Function. Without them (a bare
// `deno run`) accounts are off and lookups are only burst-limited.
const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const ACCOUNTS = Boolean(SUPABASE_URL && SERVICE_KEY);
const LIMITS = {
  guest: Number(Deno.env.get("GUEST_DAILY_LIMIT") ?? "3"),
  free: Number(Deno.env.get("FREE_DAILY_LIMIT") ?? "10"),
  pro: Number(Deno.env.get("PRO_DAILY_LIMIT") ?? "500"),
};
const DEEP_LIMITS = {
  guest: Number(Deno.env.get("DEEP_GUEST_DAILY_LIMIT") ?? "0"),
  free: Number(Deno.env.get("DEEP_FREE_DAILY_LIMIT") ?? "1"),
  pro: Number(Deno.env.get("DEEP_PRO_DAILY_LIMIT") ?? "10"),
};
const DEEP_GLOBAL_PER_MIN = Number(Deno.env.get("DEEP_GLOBAL_PER_MIN") ?? "3");
const DEEP_PER_MIN = 3; // per account
const DEEP_SAMPLE = Number(Deno.env.get("DEEP_SAMPLE") ?? "20");
const IP_DAILY_LIMIT = Number(Deno.env.get("IP_DAILY_LIMIT") ?? "40");
const GLOBAL_DAILY_LIMIT = Number(Deno.env.get("GLOBAL_DAILY_LIMIT") ?? "5000");
// Failed lookups are given back, but only this many times a day per caller, so
// misses can't be used to reach Roblox for free.
const REFUNDS_PER_DAY = 10;
const IP_HASH_SALT = Deno.env.get("IP_HASH_SALT") ?? SERVICE_KEY;

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
      // The list says which badges, not when: award dates come 100 at a time.
      let dates: string[] = [];
      try {
        for (let start = 0; start < items.length; start += 100) {
          const ids = items.slice(start, start + 100).map((b) => b.id).join(",");
          const res = await roblox(`https://badges.roblox.com/v1/users/${uid}/badges/awarded-dates?badgeIds=${ids}`, { auth: true });
          dates.push(...(res?.data ?? []).map((d: Json) => d.awardedDate));
        }
      } catch (e) {
        if (!(e instanceof RobloxError)) throw e;
        dates = []; // timing is a refinement; the count still stands without it
      }
      const timing = badgeTiming(dates);
      return {
        count: items.length,
        truncated,
        earliest: timing ? timing.earliest : null,
        sample: items.slice(0, 8).map((b) => b.name),
        games: new Set(items.map((b) => b.awarder?.id).filter((id) => id != null)).size,
        timing,
      };
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
// Badge timing
// ---------------------------------------------------------------------------
// "Badge walk" games hand out hundreds of badges in minutes. Badges that arrive
// this fast say nothing about how much an account has really been played.
const BURST_COUNT = 10; // this many badges...
const BURST_WINDOW = 600; // ...within this many seconds count as farmed

/** Roblox timestamps carry up to 7 fractional digits; Date.parse wants at most 3. */
const parseDate = (s: unknown): number => typeof s === "string" ? Date.parse(s.replace(/(\.\d{3})\d+/, "$1")) : NaN;

/** Summarise when badges were awarded. Null if there are no usable dates. */
function badgeTiming(dates: unknown[]) {
  const times = dates.map(parseDate).filter((t) => !Number.isNaN(t)).map((t) => t / 1000).sort((a, b) => a - b);
  if (!times.length) return null;
  const farmed: boolean[] = new Array(times.length).fill(false);
  let biggest = 1, start = 0;
  for (let end = 0; end < times.length; end++) {
    while (times[end] - times[start] > BURST_WINDOW) start++;
    const size = end - start + 1;
    biggest = Math.max(biggest, size);
    if (size >= BURST_COUNT) for (let i = start; i <= end; i++) farmed[i] = true;
  }
  const iso = (t: number) => new Date(Math.floor(t) * 1000).toISOString().slice(0, 19) + "Z";
  return {
    dated: times.length,
    farmed: farmed.filter(Boolean).length,
    days: new Set(times.map((t) => Math.floor(t / 86400))).size,
    biggestBurst: biggest,
    earliest: iso(times[0]),
    latest: iso(times[times.length - 1]),
  };
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
    const count: number = pb.count, timing = pb.timing;
    const farmed: number = timing ? timing.farmed : 0;
    // Only badges earned at a human pace count toward "this account gets played".
    const real = count - farmed;
    const more = pb.truncated ? "+" : "";
    const what = `${real}${more} game badges` + (farmed ? ` earned at a normal pace (${farmed} more came in bursts)` : "") + ".";
    if (count === 0) sig(12, "No player badges", "Has never earned a badge in any game.", "activity");
    else if (real < 10) sig(6, "Few player badges", what, "activity");
    else if (real >= 100) sig(-12, "Lots of player badges", what, "activity");
    else if (real >= 30) sig(-7, "Plenty of player badges", what, "activity");
    else sig(-3, "Some player badges", what, "activity");
    if (farmed >= 20 && farmed * 2 >= count) {
      sig(
        8,
        "Badges look farmed",
        `${farmed} of ${count}${more} badges arrived in bursts of ${BURST_COUNT} or more within ${BURST_WINDOW / 60} minutes, ` +
          `the pattern of a badge-walk game (up to ${timing.biggestBurst} in one burst).`,
        "activity",
      );
    }
    if (timing && real >= 10 && timing.days >= 15) {
      sig(-4, "Badges earned over many days", `Badges were earned on ${timing.days} different days.`, "activity");
    }
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

  const [verdict, summary] = verdictOf(total);
  signals.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  return { total, verdict, summary, signals, ageDays };
}

function verdictOf(total: number): [string, string] {
  if (total >= 70) return ["Likely alt", "Most signals point to a throwaway or secondary account."];
  if (total >= 50) return ["Possibly alt", "Mixed signals; leans toward an alt or a very inactive account."];
  if (total >= 30) return ["Probably main", "Looks like a real, moderately active account."];
  return ["Likely main", "Strong history and activity for a primary account."];
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
// Deep check: the account's friends as a web
// ---------------------------------------------------------------------------
// Roblox only allows about 30 profile reads a minute, far too few to open every
// friend's profile. But user IDs are handed out in order, so an ID alone places
// an account's creation date to within a few weeks. Sampled 1 October 2026;
// IDs past the last row are extrapolated.
const ID_ANCHORS: [number, number][] = ([
  [1, "2006-02-27"], [1000, "2006-08-11"], [100000, "2007-11-20"],
  [1000000, "2008-09-06"], [5000000, "2009-10-26"], [10000000, "2010-08-31"],
  [25000000, "2012-03-20"], [50000000, "2013-10-16"], [100000000, "2015-11-28"],
  [200000000, "2016-12-24"], [350000000, "2017-07-24"], [500000000, "2018-01-26"],
  [750000000, "2018-09-05"], [1000000000, "2019-03-12"], [1500000000, "2020-03-11"],
  [2000000000, "2020-11-06"], [2500000000, "2021-04-11"], [3000000000, "2021-10-22"],
  [3500000000, "2022-04-26"], [4000000000, "2022-10-25"], [4500000000, "2023-04-07"],
  [5000000000, "2023-09-03"], [5500000000, "2024-01-27"], [6000000000, "2024-05-07"],
  [7000000000, "2024-06-13"], [7500000000, "2024-10-25"], [8000000000, "2025-02-10"],
  [8500000000, "2025-05-19"], [9000000000, "2025-07-23"], [9500000000, "2025-09-16"],
  [10000000000, "2025-11-22"], [10500000000, "2026-02-12"], [11000000000, "2026-05-24"],
  [11500000000, "2026-08-14"],
] as [number, string][]).map(([id, day]) => [id, Date.parse(`${day}T00:00:00Z`) / 1000]);
const NAMED_MAX = 200; // friends whose names and ban status are read (in batches)
const MUTUAL_PAGES = 2; // pages of 50 read from each profiled friend's own friends list
const DAY = 86400;

/**
 * Estimate when account `uid` was created, as a Unix time. `known` is an exact
 * [id, time] pair, used as an extra anchor when it fits between its neighbours.
 */
function estimateCreated(uid: number, known: [number, number] | null = null): number {
  let pts = ID_ANCHORS;
  if (known) {
    const before = pts.filter((p) => p[0] < known[0]), after = pts.filter((p) => p[0] > known[0]);
    if ((!before.length || before[before.length - 1][1] <= known[1]) && (!after.length || known[1] <= after[0][1])) {
      pts = [...before, known, ...after];
    }
  }
  if (uid <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [a, ta] = pts[i - 1], [b, tb] = pts[i];
    if (uid <= b) return ta + (tb - ta) * (uid - a) / (b - a);
  }
  const [a, ta] = pts[pts.length - 2], [b, tb] = pts[pts.length - 1];
  return Math.min(Date.now() / 1000, tb + (tb - ta) * (uid - b) / (b - a));
}

/** Up to n items taken evenly across the list, always the same ones for the same list. */
function spread<T>(items: T[], n: number): T[] {
  if (items.length <= n) return [...items];
  return Array.from({ length: n }, (_, i) => items[pyRound(i * (items.length - 1) / (n - 1))]);
}

/** Round half to even, as Python's round() does, so both ports pick the same friends. */
function pyRound(x: number): number {
  const f = Math.floor(x);
  return x - f === 0.5 ? (f % 2 === 0 ? f : f + 1) : Math.round(x);
}

/** A username with its decoration removed: case, separators, trailing digits, alt-style tags. */
const nameStem = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/\d+$/, "").replace(/^(alt|the|its|im)+|(alt|backup|spare|temp|second|yt)+$/g, "");

function similarNames(a: string, b: string): boolean {
  const x = nameStem(a), y = nameStem(b);
  if (x.length < 4 || y.length < 4) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return x === y || (short.length >= 5 && long.startsWith(short));
}

/** Run one optional Roblox call; a failure just means that detail is unknown. */
async function quiet<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof RobloxError) return null;
    throw e;
  }
}

interface FriendProfile {
  friends: number | null;
  robloxBadges: number | null;
  groups: number | null;
  links: number[] | null;
}
interface DeepRaw {
  ids: number[];
  hidden: number;
  named: number[];
  info: Map<number, Json>;
  live: Set<number>;
  sample: number[];
  profiles: Map<number, FriendProfile>;
  avatars: Map<number, string | null>;
}

/**
 * Read the account's friends list and profile a spread of the friends on it.
 * Returns null when the list can't be seen.
 */
async function deepCollect(user: Json): Promise<DeepRaw | null> {
  const uid: number = user.id;
  let listed: Json[];
  try {
    listed = (await roblox(`https://friends.roblox.com/v1/users/${uid}/friends`))?.data ?? [];
  } catch (e) {
    if (e instanceof RobloxError && e.message.includes("HTTP 403")) return null;
    throw e;
  }
  const ids = [...new Set(listed.map((f) => f.id as number).filter((id) => id > 0))].sort((a, b) => a - b);
  const hidden = listed.filter((f) => !(f.id > 0)).length;
  const friendSet = new Set(ids);

  // Names, verified and banned for up to NAMED_MAX friends: two cheap batch calls per 100.
  const named = spread(ids, NAMED_MAX);
  const info = new Map<number, Json>(), live = new Set<number>();
  for (let start = 0; start < named.length; start += 100) {
    const chunk = named.slice(start, start + 100);
    const url = "https://users.roblox.com/v1/users";
    const all = await roblox(url, { method: "POST", body: { userIds: chunk, excludeBannedUsers: false } });
    for (const u of all?.data ?? []) info.set(u.id, u);
    const got = await quiet(() => roblox(url, { method: "POST", body: { userIds: chunk, excludeBannedUsers: true } }));
    for (const id of got ? (got.data ?? []).map((u: Json) => u.id) : chunk) live.add(id);
  }

  // A closer look at a spread of them, 4 requests at a time.
  const sample = spread(named.filter((id) => info.has(id)), DEEP_SAMPLE);

  const profile = async (fid: number): Promise<FriendProfile> => {
    let own: Set<number> | null = new Set<number>();
    let cursor: string | null = null, complete = false;
    for (let page = 0; page < MUTUAL_PAGES; page++) {
      const res: Json = await quiet(() =>
        roblox(
          `https://friends.roblox.com/v1/users/${fid}/friends/find?limit=50` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""),
          { retries: 2 },
        )
      );
      if (res === null) {
        own = null;
        break;
      }
      for (const p of res.PageItems ?? []) own.add(p.id);
      cursor = res.NextCursor ?? null;
      if (!cursor) {
        complete = true;
        break;
      }
    }
    const badges = await quiet(() => roblox(`https://accountinformation.roblox.com/v1/users/${fid}/roblox-badges`, { retries: 2 }));
    const groups = await quiet(() => roblox(`https://groups.roblox.com/v1/users/${fid}/groups/roles`, { retries: 2 }));
    const count = own !== null && complete
      ? own.size
      : (await quiet(() => roblox(`https://friends.roblox.com/v1/users/${fid}/friends/count`, { retries: 2 })))?.count ?? null;
    return {
      friends: count,
      robloxBadges: badges !== null ? badges.length : null,
      groups: groups !== null ? (groups.data ?? []).length : null,
      links: own !== null ? [...own].filter((id) => friendSet.has(id) && id !== fid).sort((a, b) => a - b) : null,
    };
  };

  const profiles = new Map<number, FriendProfile>();
  let next = 0;
  const worker = async () => {
    while (next < sample.length) {
      const fid = sample[next++];
      profiles.set(fid, await profile(fid));
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  const shots = sample.length
    ? await quiet(() =>
      roblox(
        `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${sample.join(",")}&size=48x48&format=Png&isCircular=false`,
      )
    )
    : null;
  const avatars = new Map<number, string | null>((shots?.data ?? []).map((t: Json) => [t.targetId, t.imageUrl ?? null]));
  return { ids, hidden, named, info, live, sample, profiles, avatars };
}

/**
 * Turn the friends data into per-friend rows, the links between them, and
 * signals that move the score. Pure: no network.
 */
function webSignals(user: Json, raw: DeepRaw, now = Date.now() / 1000) {
  const signals: Signal[] = [];
  const sig = (points: number, label: string, detail: string) => signals.push({ points, label, detail, category: "web" });

  const createdAt = parseDate(user.created);
  const known: [number, number] | null = Number.isNaN(createdAt) ? null : [user.id, createdAt / 1000];
  const born = known ? known[1] : estimateCreated(user.id);
  const { ids, info, profiles } = raw;
  const age = new Map(ids.map((i) => [i, Math.max(0, Math.floor((now - estimateCreated(i, known)) / DAY))]));
  const sameWeek = ids.filter((i) => Math.abs(estimateCreated(i, known) - born) <= 7 * DAY);
  const banned = raw.named.filter((i) => info.has(i) && !raw.live.has(i));
  const alike = raw.named.filter((i) => info.has(i) && similarNames(info.get(i).name ?? "", user.name ?? ""));

  const friends = raw.sample.map((i) => {
    const p = profiles.get(i)!, u = info.get(i);
    // "Thin": little on the profile beyond having been created.
    const thin = [age.get(i)! < 180, p.friends !== null && p.friends < 5, p.robloxBadges === 0, p.groups === 0]
      .filter(Boolean).length >= 3;
    return {
      id: i,
      name: u.name ?? null,
      displayName: u.displayName ?? null,
      verified: Boolean(u.hasVerifiedBadge),
      banned: banned.includes(i),
      similarName: alike.includes(i),
      estCreated: new Date(estimateCreated(i, known) * 1000).toISOString().slice(0, 7),
      estAgeDays: age.get(i)!,
      friends: p.friends,
      robloxBadges: p.robloxBadges,
      groups: p.groups,
      mutuals: p.links !== null ? p.links.length : null,
      thin,
      avatarUrl: raw.avatars.get(i) ?? null,
      profileUrl: `https://www.roblox.com/users/${i}/profile`,
    };
  });
  const inSample = new Set(raw.sample);
  const pairs = new Map<string, [number, number]>();
  for (const a of raw.sample) {
    for (const b of profiles.get(a)!.links ?? []) {
      if (inSample.has(b)) pairs.set(`${Math.min(a, b)}-${Math.max(a, b)}`, [Math.min(a, b), Math.max(a, b)]);
    }
  }
  const links = [...pairs.values()].sort((x, y) => x[0] - y[0] || x[1] - y[1]);

  const n = ids.length;
  const ages = [...age.values()].sort((a, b) => a - b);
  if (n < 3) {
    sig(0, "Too few friends to read much into", `${n} friend(s) on the list.`);
  } else {
    const median = ages[Math.floor(n / 2)], young = ages.filter((a) => a < 90).length;
    if (young * 10 >= n * 6) {
      sig(12, "Friends are mostly new accounts", `${young} of ${n} friends look less than three months old.`);
    } else if (median >= 730) {
      sig(-8, "Friends are long-standing accounts", `Half of the ${n} friends are over ${Math.floor(median / 365)} years old.`);
    } else if (median >= 365) {
      sig(-4, "Friends are established accounts", `Half of the ${n} friends are over a year old.`);
    }
    if (sameWeek.length >= 3 && sameWeek.length * 10 >= n * 3) {
      sig(10, "Friends made alongside this account", `${sameWeek.length} of ${n} friends were created within a week of it.`);
    }

    const seen = friends.filter((f) => f.friends !== null);
    const thin = seen.filter((f) => f.thin).length;
    if (seen.length >= 4 && thin * 10 >= seen.length * 6) {
      sig(8, "Friends' own profiles are empty", `${thin} of ${seen.length} friends looked at have almost nothing on their profile.`);
    } else if (seen.length >= 4 && thin * 10 <= seen.length * 2) {
      sig(-4, "Friends have real profiles", `${seen.length - thin} of ${seen.length} friends looked at have friends, groups or badges of their own.`);
    }

    const linked = friends.filter((f) => f.mutuals !== null);
    const tied = linked.filter((f) => f.mutuals! >= 1).length;
    if (linked.length >= 4 && tied * 10 >= linked.length * 6) {
      sig(-8, "Friends know each other", `${tied} of ${linked.length} friends looked at are also friends with others on the list.`);
    } else if (linked.length >= 4 && tied === 0) {
      sig(6, "Friends don't know each other", `None of the ${linked.length} friends looked at are friends with anyone else on the list.`);
    }
  }

  if (banned.length >= 2 && banned.length * 4 >= raw.named.length) {
    sig(6, "Many banned friends", `${banned.length} of ${raw.named.length} friends are banned accounts.`);
  }
  if (alike.length) {
    const names = alike.slice(0, 3).map((i) => info.get(i).name).join(", ");
    sig(8, "Friends with near-identical usernames", `${names}${alike.length > 3 ? " and others" : ""}.`);
  }

  signals.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  return {
    friendCount: n,
    hidden: raw.hidden,
    named: raw.named.length,
    profiled: friends.length,
    medianAgeDays: n ? ages[Math.floor(n / 2)] : null,
    signals,
    friends,
    links,
  };
}

/**
 * A normal lookup plus the friends analysis. The deep score is the normal
 * score moved by the web signals.
 */
async function deepLookup(query: string) {
  const { cached: _cached, ...result } = await cachedLookup(query, false);
  const user = result.user;
  const raw = await deepCollect(user);
  if (raw === null) return { ...result, deep: { friendCount: null, note: "This account's friends list isn't visible." } };
  if (!raw.ids.length) {
    return { ...result, deep: { friendCount: 0, hidden: raw.hidden, note: "This account has no friends to look at." } };
  }
  const web = webSignals(user, raw);
  let total = Math.max(0, Math.min(100, result.score + web.signals.reduce((s, x) => s + x.points, 0)));
  if (user.hasVerifiedBadge) total = Math.min(total, 10);
  const [verdict, summary] = verdictOf(total);
  return { ...result, deep: { ...web, score: total, verdict, summary } };
}

// ---------------------------------------------------------------------------
// Cache + first-line rate limit (per warm isolate; best-effort, resets on cold
// start). The limits that must hold live in Postgres: see admit() below.
// ---------------------------------------------------------------------------
const cache = new Map<string, [number, Json]>();
const hits = new Map<string, number[]>();

const cacheKey = (query: string) => query.trim().toLowerCase().replace(/^@/, "");
const isPartial = (result: Json) => result.notes.some((n: string) => n.includes("429"));

/** A cached result that hasn't expired. Deep checks live under their own prefix. */
function cacheGet(query: string, prefix = ""): Json | null {
  const hit = cache.get(prefix + cacheKey(query));
  return hit && Date.now() / 1000 - hit[0] < CACHE_TTL ? hit[1] : null;
}

async function cachedDeep(query: string) {
  const hit = cacheGet(query, "deep:");
  if (hit) return { ...hit, cached: true };
  const result = await deepLookup(query);
  const now = Date.now() / 1000;
  for (const k of [cacheKey(query), String(result.user.id), (result.user.name ?? "").toLowerCase()]) {
    cache.set(`deep:${k}`, [now, result]);
  }
  return { ...result, cached: false };
}

async function cachedLookup(query: string, fresh: boolean) {
  const key = cacheKey(query);
  const now = Date.now() / 1000;
  if (!fresh) {
    const hit = cacheGet(query);
    if (hit) return { ...hit, cached: true };
  }
  const result = await lookup(query);
  // A partly rate-limited result is cached only briefly so a re-check can fill it in.
  const stamp = isPartial(result) ? now - CACHE_TTL + 30 : now;
  cache.set(key, [stamp, result]);
  cache.set(String(result.user.id), [stamp, result]);
  cache.set((result.user.name ?? "").toLowerCase(), [stamp, result]);
  if (cache.size > 2000) {
    for (const k of [...cache.keys()].slice(0, 500)) cache.delete(k);
  }
  return { ...result, cached: false };
}

function rateLimited(key: string, perMinute: number): boolean {
  const now = Date.now();
  if (hits.size > 5000) {
    for (const [k, times] of hits) if (now - times[times.length - 1] >= 60_000) hits.delete(k);
  }
  const q = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
  if (q.length >= perMinute) {
    hits.set(key, q);
    return true;
  }
  q.push(now);
  hits.set(key, q);
  return false;
}

// ---------------------------------------------------------------------------
// Accounts + daily quotas (tables and RPCs: supabase/migrations)
// ---------------------------------------------------------------------------
type Plan = "guest" | "free" | "pro";
interface Caller {
  plan: Plan;
  subject: string; // usage key: "u:<user id>" or "ip:<network hash>"
  network: string; // salted hash of the caller's network address
}

class AuthError extends Error {}

const SERVICE_HEADERS = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
// A missed cancellation webhook must not mean Pro forever.
const PERIOD_GRACE_MS = 3 * 86_400_000;

/** Call the project's PostgREST API as the service role. */
async function db(path: string, init: { method?: string; body?: Json } = {}): Promise<Json> {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: init.method ?? "GET",
    headers: { ...SERVICE_HEADERS, "Content-Type": "application/json" },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`database ${resp.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/**
 * The unit a visitor is counted by. An IPv6 customer controls a whole /64 and
 * can hop between its addresses at will, so those count as one; IPv4 is used
 * as is.
 */
function networkOf(ip: string): string {
  const addr = ip.trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  if (!addr.includes(":")) return addr;
  const [head, tail] = addr.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups = tail === undefined ? front : [...front, ...Array(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back];
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

async function hashNetwork(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${IP_HASH_SALT}:${networkOf(ip)}`));
  return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Work out who is calling: a signed-in account (free or pro) or a guest. */
async function identify(req: Request, network: string): Promise<Caller> {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  // supabase-js sends the project's public key as the bearer when nobody is signed in.
  if (!token || token === ANON_KEY || token.startsWith("sb_publishable_")) {
    return { plan: "guest", subject: `ip:${network}`, network };
  }
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (resp.status === 401 || resp.status === 403) {
    await resp.body?.cancel();
    throw new AuthError("Your session has expired. Sign in again.");
  }
  if (!resp.ok) throw new Error(`auth ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const user = await resp.json();
  const rows = await db(`profiles?id=eq.${encodeURIComponent(user.id)}&select=plan,current_period_end`);
  const p = rows?.[0];
  const lapsed = p?.current_period_end && Date.parse(p.current_period_end) + PERIOD_GRACE_MS < Date.now();
  return { plan: p?.plan === "pro" && !lapsed ? "pro" : "free", subject: `u:${user.id}`, network };
}

type Admission = { ok: true; used: number; taken: string[] } | { ok: false; code: string; error: string };

/** PostgREST's answer when a function from the rate-limit migration doesn't exist yet. */
const migrationMissing = (e: unknown) => e instanceof Error && e.message.startsWith("database 404");

/**
 * Decide whether this caller may run one new lookup, and count it. Everything
 * is checked and counted in one database call (admit_lookup), so the limits
 * hold across parallel requests and across copies of this function:
 *
 *   per minute  the caller's network, the account, and (non-Pro) the whole site
 *   per day     the caller's own allowance, then for non-Pro the network's
 *               total across all its guests and accounts, and the site's total
 *
 * Pro is exempt from the shared limits: one abusive network or a busy day
 * can't take a paying customer's lookups away.
 */
async function admit(c: Caller, kind: "lookup" | "deep" = "lookup"): Promise<Admission> {
  const pro = c.plan === "pro", deep = kind === "deep";
  const burst = [{ key: `ip:${c.network}`, limit: RATE_LIMIT_PER_MIN, window: 60 }];
  if (deep) {
    // A deep check costs Roblox as much as several lookups, and Roblox's own
    // limits don't care who is paying, so the site-wide brake covers Pro too.
    burst.push({ key: `deep:${c.subject}`, limit: DEEP_PER_MIN, window: 60 });
    burst.push({ key: "global:deep", limit: DEEP_GLOBAL_PER_MIN, window: 60 });
  } else {
    if (c.plan !== "guest") burst.push({ key: c.subject, limit: RATE_LIMIT_PER_MIN, window: 60 });
    if (!pro) burst.push({ key: "global", limit: GLOBAL_PER_MIN, window: 60 });
  }
  const own = deep ? { key: `deep:${c.subject}`, limit: DEEP_LIMITS[c.plan] } : { key: c.subject, limit: LIMITS[c.plan] };
  const tooMany = { ok: false as const, code: "quota", error: deep ? deepQuotaMessage(c.plan) : quotaMessage(c.plan) };
  const daily = [own];
  if (!pro) {
    daily.push({ key: `net:${c.network}`, limit: IP_DAILY_LIMIT });
    daily.push({ key: "global", limit: GLOBAL_DAILY_LIMIT });
  }

  let res: Json;
  try {
    res = await db("rpc/admit_lookup", { method: "POST", body: { p_burst: burst, p_daily: daily } });
  } catch (e) {
    if (!migrationMissing(e)) throw e;
    // Deployed ahead of the migration: keep working on the caller's own allowance.
    console.error("admit_lookup is missing: run supabase/migrations/20261001000000_rate_limits.sql");
    if (rateLimited(`lookup:${c.network}`, RATE_LIMIT_PER_MIN)) {
      return { ok: false, code: "rate", error: "Slow down: too many lookups this minute." };
    }
    const used = await db("rpc/consume_lookup", { method: "POST", body: { p_subject: own.key, p_limit: own.limit } });
    return used === null ? tooMany : { ok: true, used, taken: [own.key] };
  }
  if (res.ok) return { ok: true, used: res.used, taken: daily.map((d) => d.key) };
  if (res.reason === "burst") {
    return burst[res.index].key.startsWith("global")
      ? { ok: false, code: "busy", error: "The checker is busy right now. Try again in a minute." }
      : { ok: false, code: "rate", error: "Slow down: too many lookups this minute." };
  }
  const full = daily[res.index].key;
  if (full === own.key) return tooMany;
  if (full === "global") {
    return { ok: false, code: "global", error: "Today's free lookups are used up across the site. Pro accounts aren't affected, or come back tomorrow." };
  }
  return { ok: false, code: "network", error: `Your network has used today's ${IP_DAILY_LIMIT} free lookups. Pro accounts aren't affected, or come back tomorrow.` };
}

/** Give a failed lookup back, a limited number of times a day. */
async function refund(c: Caller, taken: string[]): Promise<void> {
  try {
    const allowed = await db("rpc/take_token", {
      method: "POST",
      body: { p_key: `refund:${c.subject}`, p_limit: REFUNDS_PER_DAY, p_window_seconds: 86400 },
    });
    if (allowed) await db("rpc/refund_lookups", { method: "POST", body: { p_subjects: taken } });
  } catch (e) {
    if (!migrationMissing(e)) throw e;
    await db("rpc/refund_lookup", { method: "POST", body: { p_subject: taken[0] } });
  }
}

async function usedToday(subject: string): Promise<number> {
  const day = new Date().toISOString().slice(0, 10);
  const rows = await db(`usage?subject=eq.${encodeURIComponent(subject)}&day=eq.${day}&select=count`);
  return rows?.[0]?.count ?? 0;
}

function deepQuota(c: Caller, used: number) {
  const limit = DEEP_LIMITS[c.plan];
  return { limit, used: Math.min(used, limit), remaining: Math.max(0, limit - used) };
}

function deepQuotaMessage(plan: Plan): string {
  const n = DEEP_LIMITS[plan];
  if (plan === "pro") return `You've used today's ${n} deep checks. They reset at 00:00 UTC.`;
  return `You've used today's ${n === 1 ? "deep check" : `${n} deep checks`}. Pro gets ${DEEP_LIMITS.pro} a day, or come back tomorrow.`;
}

function quota(c: Caller, used: number) {
  const limit = LIMITS[c.plan];
  const reset = new Date();
  reset.setUTCHours(24, 0, 0, 0);
  return { plan: c.plan, limit, used: Math.min(used, limit), remaining: Math.max(0, limit - used), resetsAt: reset.toISOString() };
}

function quotaMessage(plan: Plan): string {
  const n = LIMITS[plan];
  if (plan === "guest") return `You've used today's ${n} guest lookups. Create a free account for ${LIMITS.free} a day.`;
  if (plan === "free") return `You've used today's ${n} free lookups. Upgrade to Pro for ${LIMITS.pro} a day, or come back tomorrow.`;
  return `You've reached today's ${n}-lookup Pro limit. It resets at 00:00 UTC.`;
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
  if (url.searchParams.has("health")) {
    return json(200, { ok: true, badgeCheck: Boolean(ROBLOX_COOKIE), accounts: ACCOUNTS });
  }
  // Prefer cf-connecting-ip when the platform passes it: the first
  // x-forwarded-for entry can be supplied by the client.
  const ip = (req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "unknown")
    .split(",")[0].trim();

  try {
    // First line, before anything that costs a call elsewhere.
    const network = await hashNetwork(ip);
    if (rateLimited(network, REQUESTS_PER_MIN)) {
      return json(429, { error: "Slow down: too many requests this minute.", code: "rate" });
    }
    const caller = ACCOUNTS ? await identify(req, network) : null;
    if (url.searchParams.has("quota")) {
      if (!caller) return json(200, { accounts: false });
      const [used, deepUsed] = await Promise.all([usedToday(caller.subject), usedToday(`deep:${caller.subject}`)]);
      return json(200, {
        accounts: true,
        ...quota(caller, used),
        deep: deepQuota(caller, deepUsed),
        limits: LIMITS,
        deepLimits: DEEP_LIMITS,
      });
    }

    const q = url.searchParams.get("q") ?? "";
    const fresh = url.searchParams.get("fresh") === "1";
    const deep = url.searchParams.get("deep") === "1";
    if (!q.trim()) return json(400, { error: "Missing ?q=username-or-id" });
    if (q.length > 40) return json(400, { error: "Query too long" });
    if (!caller) {
      if (rateLimited(`lookup:${network}`, RATE_LIMIT_PER_MIN)) {
        return json(429, { error: "Slow down: too many lookups this minute.", code: "rate" });
      }
      return json(200, deep ? await cachedDeep(q) : await cachedLookup(q, fresh));
    }

    if (deep) {
      const deepKey = `deep:${caller.subject}`;
      const both = async () => ({
        quota: quota(caller, await usedToday(caller.subject)),
        deepQuota: deepQuota(caller, await usedToday(deepKey)),
      });
      if (DEEP_LIMITS[caller.plan] < 1) {
        const error = caller.plan === "guest" ? "Deep check needs an account. A free one gets " +
          `${DEEP_LIMITS.free} a day.` : "Deep check isn't part of this plan.";
        return json(403, { error, code: "deep_plan", ...(await both()) });
      }
      // Like lookups: a cached deep check is free.
      const hit = cacheGet(q, "deep:");
      if (hit) return json(200, { ...hit, cached: true, ...(await both()) });
      const pass = await admit(caller, "deep");
      if (!pass.ok) return json(429, { error: pass.error, code: pass.code, ...(await both()) });
      try {
        const result = await cachedDeep(q);
        // No friends, or a hidden list: there was nothing to analyse, so it isn't counted.
        if (!result.deep.friendCount) await refund(caller, pass.taken);
        return json(200, { ...result, ...(await both()) });
      } catch (e) {
        await refund(caller, pass.taken).catch((err) => console.error("refund failed", err));
        throw e;
      }
    }

    // Cached results are free. Skipping the cache is a Pro feature, except that
    // anyone may re-run a result Roblox rate-limited part of.
    const hit = cacheGet(q);
    if (hit && !(fresh && (caller.plan === "pro" || isPartial(hit)))) {
      return json(200, { ...hit, cached: true, quota: quota(caller, await usedToday(caller.subject)) });
    }
    const pass = await admit(caller);
    if (!pass.ok) {
      const used = pass.code === "quota" ? LIMITS[caller.plan] : await usedToday(caller.subject);
      return json(429, { error: pass.error, code: pass.code, quota: quota(caller, used) });
    }
    try {
      return json(200, { ...(await cachedLookup(q, true)), quota: quota(caller, pass.used) });
    } catch (e) {
      // Nothing was delivered, so don't charge for it.
      await refund(caller, pass.taken).catch((err) => console.error("refund failed", err));
      throw e;
    }
  } catch (e) {
    if (e instanceof AuthError) return json(401, { error: e.message, code: "auth" });
    if (e instanceof NotFound) return json(404, { error: e.message });
    if (e instanceof RobloxError) return json(502, { error: `Roblox API error: ${e.message}` });
    console.error("request failed", e);
    return json(500, { error: "Internal error" });
  }
});
