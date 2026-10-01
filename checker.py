"""Roblox Alt Checker - core logic (no web server in here).

Pulls public data from Roblox's APIs for a username or user ID, scores it, and
returns a JSON-ready dict. Used by server.py (local/Render/Docker). The Supabase
Edge Function in supabase/functions/check/index.ts is a port of this file.

Environment variables:
  ROBLOX_COOKIE        optional .ROBLOSECURITY value; enables the player-badge check
  CACHE_TTL            seconds to cache a lookup (default 600)
  RATE_LIMIT_PER_MIN   lookups allowed per client IP per minute (default 20)
  DEEP_SAMPLE          friends profiled one by one in a deep check (default 20)
"""
import json
import os
import re
import time
import threading
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

ROBLOX_COOKIE = os.environ.get("ROBLOX_COOKIE", "").strip()
CACHE_TTL = int(os.environ.get("CACHE_TTL", "600"))
RATE_LIMIT_PER_MIN = int(os.environ.get("RATE_LIMIT_PER_MIN", "20"))
DEEP_SAMPLE = int(os.environ.get("DEEP_SAMPLE", "20"))

WEARABLE_TYPES = (
    "Hat,HairAccessory,FaceAccessory,NeckAccessory,ShoulderAccessory,"
    "FrontAccessory,BackAccessory,WaistAccessory,Shirt,Pants,TShirt,Face,Gear"
)


# ---------------------------------------------------------------------------
# Roblox HTTP helpers
# ---------------------------------------------------------------------------
class RobloxError(Exception):
    pass


class NotFound(RobloxError):
    pass


_csrf = {"token": ""}


def roblox(url, method="GET", body=None, auth=False, csrf=False, retries=4):
    """Call a Roblox API. Retries on 429/network errors with backoff.

    csrf=True: send Roblox's X-CSRF-TOKEN (some POST endpoints demand one even
    anonymously); a 403 carrying a fresh token updates it and retries.
    """
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Accept": "application/json", "User-Agent": "RobloxAltChecker/1.0"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if auth and ROBLOX_COOKIE:
        headers["Cookie"] = f".ROBLOSECURITY={ROBLOX_COOKIE}"

    for attempt in range(retries):
        if csrf:
            headers["X-CSRF-TOKEN"] = _csrf["token"]
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < retries - 1:
                time.sleep(2.0 * (attempt + 1))
                continue
            if csrf and e.code == 403 and e.headers.get("x-csrf-token") and attempt < retries - 1:
                _csrf["token"] = e.headers["x-csrf-token"]
                continue
            payload = e.read()
            try:
                msg = json.loads(payload)["errors"][0]["message"]
            except Exception:
                msg = payload[:200].decode(errors="replace")
            if e.code == 404:
                raise NotFound(msg or "not found") from None
            raise RobloxError(f"HTTP {e.code}: {msg or 'error'}") from None
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            if attempt < retries - 1:
                time.sleep(1.0)
                continue
            raise RobloxError(f"network error: {e}") from None
    raise RobloxError("retries exhausted")


def page_all(url, params=None, auth=False, max_pages=3, limit=100):
    """Follow Roblox cursor pagination. Returns (items, truncated)."""
    params = dict(params or {})
    params["limit"] = limit
    items, cursor = [], None
    for _ in range(max_pages):
        if cursor:
            params["cursor"] = cursor
        page = roblox(f"{url}?{urllib.parse.urlencode(params)}", auth=auth)
        items.extend(page.get("data") or [])
        cursor = page.get("nextPageCursor")
        if not cursor:
            return items, False
    return items, True


def resolve_user(query):
    """Turn a username or numeric id into a users.roblox.com profile dict."""
    query = query.strip().lstrip("@")
    if not query:
        raise NotFound("Enter a username or user ID.")
    if query.isdigit():
        try:
            return roblox(f"https://users.roblox.com/v1/users/{query}")
        except NotFound:
            pass  # fall through: maybe it's a username made of digits
    res = roblox(
        "https://users.roblox.com/v1/usernames/users",
        method="POST",
        body={"usernames": [query], "excludeBannedUsers": False},
    )
    matches = res.get("data") or []
    if not matches:
        raise NotFound(f"No Roblox user named '{query}'.")
    return roblox(f"https://users.roblox.com/v1/users/{matches[0]['id']}")


def item_prices(asset_ids):
    """Split catalog assets into (paid, free) counts.

    Paid = a known price above 0, a resale price above 0, or a Limited item.
    Free, off-sale-at-zero, and unknown-priced items all count as free so that
    only items someone actually spent Robux on count toward the wardrobe.
    """
    paid = free = 0
    ids = list(dict.fromkeys(asset_ids))
    for start in range(0, len(ids), 100):
        chunk = ids[start:start + 100]
        res = roblox("https://catalog.roblox.com/v1/catalog/items/details", method="POST",
                     body={"items": [{"itemType": "Asset", "id": i} for i in chunk]}, csrf=True)
        seen = 0
        for d in res.get("data") or []:
            seen += 1
            if (d.get("price") or 0) > 0 or (d.get("lowestPrice") or 0) > 0 \
                    or "Limited" in (d.get("itemRestrictions") or []):
                paid += 1
            else:
                free += 1
        free += len(chunk) - seen  # items the catalog didn't return: unknown, treat as free
    return paid, free


# ---------------------------------------------------------------------------
# Data collection
# ---------------------------------------------------------------------------
def collect(uid, username=""):
    """Fetch every public signal in parallel. Each entry is {'ok', 'data'|'error'}."""
    U = f"https://users.roblox.com/v1/users/{uid}"
    F = f"https://friends.roblox.com/v1/users/{uid}"

    def name_history():
        items, _ = page_all(f"{U}/username-history", {"sortOrder": "Asc"}, max_pages=2)
        return [i["name"] for i in items]

    def player_badges():
        if not ROBLOX_COOKIE:
            raise RobloxError("not checked: server has no ROBLOX_COOKIE configured")
        items, truncated = page_all(
            f"https://badges.roblox.com/v1/users/{uid}/badges",
            {"sortOrder": "Asc"}, auth=True, max_pages=5,
        )
        # The list says which badges, not when: award dates come 100 at a time.
        dates = []
        try:
            for start in range(0, len(items), 100):
                ids = ",".join(str(b["id"]) for b in items[start:start + 100])
                res = roblox(f"https://badges.roblox.com/v1/users/{uid}/badges/awarded-dates?badgeIds={ids}", auth=True)
                dates.extend(d.get("awardedDate") for d in res.get("data") or [])
        except RobloxError:
            dates = []  # timing is a refinement; the count still stands without it
        timing = badge_timing(dates)
        return {"count": len(items), "truncated": truncated,
                "earliest": timing["earliest"] if timing else None,
                "sample": [b["name"] for b in items[:8]],
                "games": len({(b.get("awarder") or {}).get("id") for b in items} - {None}),
                "timing": timing}

    def favorites():
        items, truncated = page_all(
            f"https://games.roblox.com/v2/users/{uid}/favorite/games", max_pages=2, limit=50)
        return {"count": len(items), "truncated": truncated,
                "sample": [g["name"] for g in items[:6]]}

    def private_ok(fn):
        """Run fn; a 403 means the inventory is private, which is data, not an error."""
        try:
            return fn()
        except RobloxError as e:
            if "HTTP 403" in str(e):
                return None
            raise

    def collectibles():
        res = private_ok(lambda: page_all(
            f"https://inventory.roblox.com/v1/users/{uid}/assets/collectibles", max_pages=2))
        if res is None:
            return None
        items, truncated = res
        rap = sum((i.get("recentAveragePrice") or 0) for i in items)
        return {"count": len(items), "truncated": truncated, "rap": rap,
                "sample": [i["name"] for i in items[:6]]}

    def wearables():
        res = private_ok(lambda: page_all(
            f"https://inventory.roblox.com/v2/users/{uid}/inventory",
            {"assetTypes": WEARABLE_TYPES}, max_pages=1))
        if res is None:
            return None
        items, truncated = res
        oldest = None
        for i in items:
            d = i.get("created") or ""
            if d and (oldest is None or d < oldest):
                oldest = d
        paid, free = item_prices([i["assetId"] for i in items])
        return {"count": len(items), "paid": paid, "free": free,
                "truncated": truncated, "oldest": oldest}

    def groups():
        data = roblox(f"https://groups.roblox.com/v1/users/{uid}/groups/roles").get("data") or []
        return {"count": len(data),
                "sample": [g["group"]["name"] for g in data[:6]],
                "owned": sum(1 for g in data if g["role"].get("rank") == 255)}

    def created_games():
        items, truncated = page_all(
            f"https://games.roblox.com/v2/users/{uid}/games", max_pages=1, limit=50)
        # Roblox auto-names new places "<user>'s Place" or "<user>'s Place Number: N".
        default_name = re.compile(rf"^{re.escape(username)}'s place( number: ?\d+)?$", re.I)
        items = [g for g in items
                 if not default_name.match((g.get("name") or "").replace("\u2019", "'").strip())]
        return {"count": len(items), "truncated": truncated,
                "visits": sum(g.get("placeVisits") or 0 for g in items),
                "sample": [g["name"] for g in items[:4]]}

    def avatar():
        a = roblox(f"https://avatar.roblox.com/v1/users/{uid}/avatar")
        return {"type": a.get("playerAvatarType"), "assetCount": len(a.get("assets") or [])}

    def headshot():
        r = roblox("https://thumbnails.roblox.com/v1/users/avatar-headshot"
                   f"?userIds={uid}&size=150x150&format=Png&isCircular=false")
        return (r.get("data") or [{}])[0].get("imageUrl")

    def presence():
        r = roblox("https://presence.roblox.com/v1/presence/users",
                   method="POST", body={"userIds": [int(uid)]})
        p = (r.get("userPresences") or [{}])[0]
        kind = {0: "Offline", 1: "Online", 2: "In game", 3: "In Studio"}.get(
            p.get("userPresenceType"), "Unknown")
        return {"status": kind, "lastLocation": p.get("lastLocation")}

    tasks = {
        "previousNames": name_history,
        "friends": lambda: roblox(f"{F}/friends/count")["count"],
        "followers": lambda: roblox(f"{F}/followers/count")["count"],
        "following": lambda: roblox(f"{F}/followings/count")["count"],
        "robloxBadges": lambda: [b["name"] for b in roblox(
            f"https://accountinformation.roblox.com/v1/users/{uid}/roblox-badges")],
        "playerBadges": player_badges,
        "favorites": favorites,
        "inventoryVisible": lambda: roblox(
            f"https://inventory.roblox.com/v1/users/{uid}/can-view-inventory")["canView"],
        "collectibles": collectibles,
        "wearables": wearables,
        "groups": groups,
        "createdGames": created_games,
        "avatar": avatar,
        "headshot": headshot,
        "presence": presence,
    }

    def run(fn):
        began = time.time()
        ms = lambda: int((time.time() - began) * 1000)
        try:
            return {"ok": True, "data": fn(), "ms": ms()}
        except RobloxError as e:
            return {"ok": False, "error": str(e), "ms": ms()}
        except Exception as e:  # malformed response etc.
            return {"ok": False, "error": f"unexpected: {e.__class__.__name__}: {e}", "ms": ms()}

    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {k: pool.submit(run, fn) for k, fn in tasks.items()}
        return {k: f.result() for k, f in futures.items()}


# ---------------------------------------------------------------------------
# Badge timing
# ---------------------------------------------------------------------------
# "Badge walk" games hand out hundreds of badges in minutes. Badges that arrive
# this fast say nothing about how much an account has really been played.
BURST_COUNT = 10      # this many badges...
BURST_WINDOW = 600    # ...within this many seconds count as farmed


def badge_timing(dates):
    """Summarise when badges were awarded. dates: ISO strings. None if there are none."""
    times = sorted(t.timestamp() for t in (parse_date(d) for d in dates) if t)
    if not times:
        return None
    farmed = [False] * len(times)
    biggest, start = 1, 0
    for end in range(len(times)):
        while times[end] - times[start] > BURST_WINDOW:
            start += 1
        size = end - start + 1
        biggest = max(biggest, size)
        if size >= BURST_COUNT:
            for i in range(start, end + 1):
                farmed[i] = True
    iso = lambda t: datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "dated": len(times),
        "farmed": sum(farmed),
        "days": len({int(t // 86400) for t in times}),
        "biggestBurst": biggest,
        "earliest": iso(times[0]),
        "latest": iso(times[-1]),
    }


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------
def parse_date(s):
    if not s:
        return None
    s = re.sub(r"(\.\d{1,6})\d*", r"\1", s).replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        return None


def score(user, d):
    """Returns (score 0-100, verdict, signals list). Positive points = more alt-like."""
    signals = []

    def sig(points, label, detail, category):
        signals.append({"points": points, "label": label, "detail": detail, "category": category})

    def get(key):
        v = d.get(key)
        return v["data"] if v and v["ok"] else None

    name = user.get("name") or ""
    display = user.get("displayName") or ""
    now = datetime.now(timezone.utc)
    created = parse_date(user.get("created"))
    age_days = (now - created).days if created else None

    # Account age -----------------------------------------------------------
    if age_days is not None:
        if age_days < 7:
            sig(30, "Brand-new account", f"Created {age_days} day(s) ago.", "age")
        elif age_days < 30:
            sig(22, "Very young account", f"Created {age_days} days ago.", "age")
        elif age_days < 90:
            sig(14, "Young account", f"Created {age_days} days ago.", "age")
        elif age_days < 365:
            sig(6, "Under a year old", f"Created {age_days} days ago.", "age")
        elif age_days < 3 * 365:
            sig(-4, "Established account", f"About {age_days // 365} year(s) old.", "age")
        else:
            sig(-12, "Long-standing account", f"About {age_days // 365} years old.", "age")

    # Verification / ban -------------------------------------------------------
    if user.get("hasVerifiedBadge"):
        sig(-30, "Verified badge", "Roblox-verified accounts are essentially never throwaway alts.", "identity")
    if user.get("isBanned"):
        sig(0, "Account is banned", "Ban status is informational; it does not change the score.", "identity")

    # Social ----------------------------------------------------------------
    friends = get("friends")
    if friends is not None:
        if friends == 0:
            sig(12, "No friends", "Zero friends on the account.", "social")
        elif friends < 5:
            sig(7, "Very few friends", f"{friends} friend(s).", "social")
        elif friends >= 50:
            sig(-10, "Large friend list", f"{friends:,} friends.", "social")
        elif friends >= 15:
            sig(-6, "Healthy friend list", f"{friends:,} friends.", "social")
        else:
            sig(0, "Some friends", f"{friends:,} friends.", "social")

    followers = get("followers")
    if followers is not None:
        if followers == 0:
            sig(5, "No followers", "Nobody follows this account.", "social")
        elif followers >= 100:
            sig(-8, "Many followers", f"{followers:,} followers.", "social")
        elif followers >= 20:
            sig(-4, "Some followers", f"{followers} followers.", "social")

    following = get("following")
    if following is not None:
        if following == 0:
            sig(3, "Follows nobody", "Not following anyone.", "social")
        elif following >= 10:
            sig(-2, "Follows others", f"Following {following:,} accounts.", "social")

    groups = get("groups")
    if groups:
        if groups["count"] == 0:
            sig(6, "No groups", "Not a member of any group.", "social")
        elif groups["count"] >= 10:
            sig(-6, "Many groups", f"Member of {groups['count']} groups.", "social")
        elif groups["count"] >= 3:
            sig(-3, "In a few groups", f"Member of {groups['count']} groups.", "social")
        if groups.get("owned"):
            sig(-4, "Owns a group", f"Owner of {groups['owned']} group(s).", "social")

    # Activity ----------------------------------------------------------------
    rb = get("robloxBadges")
    if rb is not None:
        if len(rb) == 0:
            sig(8, "No Roblox badges", "None of the official Roblox badges (Welcome to the Club, Friendship, etc).", "activity")
        elif len(rb) >= 3:
            sig(-6, "Several Roblox badges", ", ".join(rb[:4]) + ("…" if len(rb) > 4 else ""), "activity")
        else:
            sig(-2, "Has a Roblox badge", ", ".join(rb), "activity")

    pb = get("playerBadges")
    if pb:
        count, timing = pb["count"], pb.get("timing")
        farmed = timing["farmed"] if timing else 0
        # Only badges earned at a human pace count toward "this account gets played".
        real = count - farmed
        more = "+" if pb["truncated"] else ""
        what = f"{real}{more} game badges" + (f" earned at a normal pace ({farmed} more came in bursts)" if farmed else "") + "."
        if count == 0:
            sig(12, "No player badges", "Has never earned a badge in any game.", "activity")
        elif real < 10:
            sig(6, "Few player badges", what, "activity")
        elif real >= 100:
            sig(-12, "Lots of player badges", what, "activity")
        elif real >= 30:
            sig(-7, "Plenty of player badges", what, "activity")
        else:
            sig(-3, "Some player badges", what, "activity")
        if farmed >= 20 and farmed * 2 >= count:
            sig(8, "Badges look farmed",
                f"{farmed} of {count}{more} badges arrived in bursts of {BURST_COUNT} or more within {BURST_WINDOW // 60} minutes, "
                f"the pattern of a badge-walk game (up to {timing['biggestBurst']} in one burst).", "activity")
        if timing and real >= 10 and timing["days"] >= 15:
            sig(-4, "Badges earned over many days", f"Badges were earned on {timing['days']} different days.", "activity")

    fav = get("favorites")
    if fav:
        if fav["count"] == 0:
            sig(6, "No favorite games", "Never favorited a game.", "activity")
        elif fav["count"] >= 15:
            sig(-5, "Many favorite games", f"{fav['count']}{'+' if fav['truncated'] else ''} favorites.", "activity")
        else:
            sig(-2, "Some favorite games", f"{fav['count']} favorites.", "activity")

    cg = get("createdGames")
    if cg and cg["count"] > 0:
        pts = -10 if cg["visits"] >= 1000 else -5
        sig(pts, "Has created games", f"{cg['count']} public place(s), {cg['visits']:,} visits.", "activity")

    # Inventory / avatar -------------------------------------------------------
    visible = get("inventoryVisible")
    col = get("collectibles")
    if visible is False and not (col and col["count"]):
        sig(4, "Inventory is private", "Cannot count items; alts often hide or have empty inventories, but so do many mains.", "inventory")

    if col:
        if col["count"] > 0:
            pts = -14 if col["rap"] >= 50_000 else -9 if col["rap"] >= 5_000 else -6
            sig(pts, "Owns limited items", f"{col['count']}{'+' if col['truncated'] else ''} collectibles, RAP {col['rap']:,}.", "inventory")
        elif visible:
            sig(3, "No limited items", "Owns no collectibles.", "inventory")

    wear = get("wearables")
    if wear:
        paid, free, more = wear["paid"], wear["free"], "+" if wear["truncated"] else ""
        if wear["count"] == 0:
            sig(6, "Empty wardrobe", "No hats, accessories, or clothing in inventory.", "inventory")
        elif paid == 0:
            sig(5, "Only free items", f"{free}{more} wearables, none of them paid.", "inventory")
        elif paid >= 40:
            sig(-6, "Large paid wardrobe", f"{paid}{more} paid wearables ({free} free ignored).", "inventory")
        elif paid >= 10:
            sig(-3, "Decent paid wardrobe", f"{paid} paid wearables ({free} free ignored).", "inventory")
        else:
            sig(2, "Few paid items", f"{paid} paid wearable(s) ({free} free ignored).", "inventory")

    av = get("avatar")
    if av:
        if av["assetCount"] == 0:
            sig(6, "Default avatar", "Wearing nothing at all.", "inventory")
        elif av["assetCount"] <= 2:
            sig(3, "Barely customized avatar", f"Wearing {av['assetCount']} item(s).", "inventory")
        elif av["assetCount"] >= 6:
            sig(-3, "Customized avatar", f"Wearing {av['assetCount']} items.", "inventory")

    # Naming / profile ---------------------------------------------------------
    prev = get("previousNames")
    if prev:
        sig(-4, "Changed username before", f"Previously: {', '.join(prev[:4])}.", "identity")
    if display and display.lower() == name.lower():
        sig(2, "Display name never set", "Display name still matches the username.", "identity")
    m = re.search(r"(\d{3,})$", name)
    if m:
        sig(4, "Username ends in digits", f"Ends in {len(m.group(1))} digits, typical of auto-generated or bulk-made names.", "identity")
    if re.search(r"(alt|alt\d|_alt|2nd|second|backup|spare|temp)", name, re.I):
        sig(15, "Username says it's an alt", f"'{name}' contains an alt-style keyword.", "identity")
    desc = (user.get("description") or "").strip()
    if not desc:
        sig(3, "Empty profile description", "No 'About' text.", "identity")
    elif re.search(r"\b(alt|alt account|main is|my main|main acc)\b", desc, re.I):
        sig(20, "Description mentions an alt/main", "The profile text talks about a main or alt account.", "identity")
    else:
        sig(-2, "Has a profile description", "Wrote something in 'About'.", "identity")

    total = max(0, min(100, 35 + sum(s["points"] for s in signals)))
    if user.get("hasVerifiedBadge"):
        total = min(total, 10)

    verdict, summary = verdict_of(total)
    signals.sort(key=lambda s: -abs(s["points"]))
    return total, verdict, summary, signals


def verdict_of(total):
    if total >= 70:
        return "Likely alt", "Most signals point to a throwaway or secondary account."
    if total >= 50:
        return "Possibly alt", "Mixed signals; leans toward an alt or a very inactive account."
    if total >= 30:
        return "Probably main", "Looks like a real, moderately active account."
    return "Likely main", "Strong history and activity for a primary account."


# How the last run for each account went: timings and failures per Roblox call.
# Kept beside the cache, never inside a result; /api/lookup?debug=1 shows it.
_diagnostics = {}


def lookup(query):
    began = time.time()
    user = resolve_user(query)
    uid = user["id"]
    resolve_ms = int((time.time() - began) * 1000)
    data = collect(uid, user.get("name") or "")
    if len(_diagnostics) > 2000:
        _diagnostics.clear()
    _diagnostics[str(uid)] = {
        "ranAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "tookMs": int((time.time() - began) * 1000),
        "resolveMs": resolve_ms,
        "calls": [{"key": k, "ok": v["ok"], "ms": v["ms"], "error": None if v["ok"] else v["error"]} for k, v in data.items()],
    }
    total, verdict, summary, signals = score(user, data)
    created = parse_date(user.get("created"))
    age_days = (datetime.now(timezone.utc) - created).days if created else None

    def val(key):
        v = data[key]
        return v["data"] if v["ok"] else None

    notes = [f"{k}: {'rate limited by Roblox (HTTP 429), try again in a minute' if 'HTTP 429' in v['error'] else v['error']}"
             for k, v in data.items() if not v["ok"]]
    return {
        "user": {
            "id": uid,
            "name": user.get("name"),
            "displayName": user.get("displayName"),
            "description": user.get("description") or "",
            "created": user.get("created"),
            "accountAgeDays": age_days,
            "isBanned": bool(user.get("isBanned")),
            "hasVerifiedBadge": bool(user.get("hasVerifiedBadge")),
            "avatarUrl": val("headshot"),
            "profileUrl": f"https://www.roblox.com/users/{uid}/profile",
        },
        "stats": {
            "friends": val("friends"),
            "followers": val("followers"),
            "following": val("following"),
            "robloxBadges": val("robloxBadges"),
            "playerBadges": val("playerBadges"),
            "favorites": val("favorites"),
            "inventoryVisible": val("inventoryVisible"),
            "collectibles": val("collectibles"),
            "wearables": val("wearables"),
            "groups": val("groups"),
            "createdGames": val("createdGames"),
            "avatar": val("avatar"),
            "presence": val("presence"),
            "previousNames": val("previousNames"),
        },
        "score": total,
        "verdict": verdict,
        "summary": summary,
        "signals": signals,
        "notes": notes,
        "checkedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


# ---------------------------------------------------------------------------
# Deep check: the account's friends as a web
# ---------------------------------------------------------------------------
# Roblox only allows about 30 profile reads a minute, far too few to open every
# friend's profile. But user IDs are handed out in order, so an ID alone places
# an account's creation date to within a few weeks. Sampled 1 October 2026;
# IDs past the last row are extrapolated.
ID_ANCHORS = [(i, datetime.fromisoformat(d).replace(tzinfo=timezone.utc).timestamp()) for i, d in [
    (1, "2006-02-27"), (1000, "2006-08-11"), (100000, "2007-11-20"),
    (1000000, "2008-09-06"), (5000000, "2009-10-26"), (10000000, "2010-08-31"),
    (25000000, "2012-03-20"), (50000000, "2013-10-16"), (100000000, "2015-11-28"),
    (200000000, "2016-12-24"), (350000000, "2017-07-24"), (500000000, "2018-01-26"),
    (750000000, "2018-09-05"), (1000000000, "2019-03-12"), (1500000000, "2020-03-11"),
    (2000000000, "2020-11-06"), (2500000000, "2021-04-11"), (3000000000, "2021-10-22"),
    (3500000000, "2022-04-26"), (4000000000, "2022-10-25"), (4500000000, "2023-04-07"),
    (5000000000, "2023-09-03"), (5500000000, "2024-01-27"), (6000000000, "2024-05-07"),
    (7000000000, "2024-06-13"), (7500000000, "2024-10-25"), (8000000000, "2025-02-10"),
    (8500000000, "2025-05-19"), (9000000000, "2025-07-23"), (9500000000, "2025-09-16"),
    (10000000000, "2025-11-22"), (10500000000, "2026-02-12"), (11000000000, "2026-05-24"),
    (11500000000, "2026-08-14"),
]]
NAMED_MAX = 200     # friends whose names and ban status are read (in batches)
MUTUAL_PAGES = 2    # pages of 50 read from each profiled friend's own friends list
DAY = 86400


def estimate_created(uid, known=None):
    """Estimate when account `uid` was created, as a Unix time. `known` is an
    exact (id, time) pair, used as an extra anchor when it fits between its neighbours."""
    pts = list(ID_ANCHORS)
    if known:
        before = [p for p in pts if p[0] < known[0]]
        after = [p for p in pts if p[0] > known[0]]
        if (not before or before[-1][1] <= known[1]) and (not after or known[1] <= after[0][1]):
            pts = before + [known] + after
    if uid <= pts[0][0]:
        return pts[0][1]
    for (a, ta), (b, tb) in zip(pts, pts[1:]):
        if uid <= b:
            return ta + (tb - ta) * (uid - a) / (b - a)
    (a, ta), (b, tb) = pts[-2], pts[-1]
    return min(time.time(), tb + (tb - ta) * (uid - b) / (b - a))


def spread(items, n):
    """Up to n items taken evenly across the list, always the same ones for the same list."""
    if len(items) <= n:
        return list(items)
    return [items[round(i * (len(items) - 1) / (n - 1))] for i in range(n)]


def name_stem(name):
    """A username with its decoration removed: case, separators, trailing digits, alt-style tags."""
    stem = re.sub(r"[^a-z0-9]", "", name.lower())
    stem = re.sub(r"\d+$", "", stem)
    return re.sub(r"^(alt|the|its|im)+|(alt|backup|spare|temp|second|yt)+$", "", stem)


def similar_names(a, b):
    x, y = name_stem(a), name_stem(b)
    if len(x) < 4 or len(y) < 4:
        return False
    short, long = (x, y) if len(x) <= len(y) else (y, x)
    return x == y or (len(short) >= 5 and long.startswith(short))


def deep_collect(user):
    """Read the account's friends list and profile a spread of the friends on it.
    Returns None when the list can't be seen."""
    uid = user["id"]
    quiet = lambda fn: _quiet(fn)
    try:
        listed = roblox(f"https://friends.roblox.com/v1/users/{uid}/friends").get("data") or []
    except RobloxError as e:
        if "HTTP 403" in str(e):
            return None
        raise
    ids = sorted({f["id"] for f in listed if f.get("id", 0) > 0})
    hidden = sum(1 for f in listed if f.get("id", 0) <= 0)
    friend_set = set(ids)

    # Names, verified and banned for up to NAMED_MAX friends: two cheap batch calls per 100.
    named = spread(ids, NAMED_MAX)
    info, live = {}, set()
    for start in range(0, len(named), 100):
        chunk = named[start:start + 100]
        url = "https://users.roblox.com/v1/users"
        for u in roblox(url, method="POST", body={"userIds": chunk, "excludeBannedUsers": False}).get("data") or []:
            info[u["id"]] = u
        got = quiet(lambda: roblox(url, method="POST", body={"userIds": chunk, "excludeBannedUsers": True}))
        live |= {u["id"] for u in (got or {}).get("data") or []} if got else set(chunk)

    # A closer look at a spread of them, 4 requests at a time.
    sample = spread([i for i in named if i in info], DEEP_SAMPLE)

    def profile(fid):
        own = set()
        cursor, complete = None, False
        for _ in range(MUTUAL_PAGES):
            page = quiet(lambda: roblox(f"https://friends.roblox.com/v1/users/{fid}/friends/find?limit=50"
                                        + (f"&cursor={urllib.parse.quote(cursor)}" if cursor else ""), retries=2))
            if page is None:
                own = None
                break
            own |= {p["id"] for p in page.get("PageItems") or []}
            cursor = page.get("NextCursor")
            if not cursor:
                complete = True
                break
        badges = quiet(lambda: roblox(f"https://accountinformation.roblox.com/v1/users/{fid}/roblox-badges", retries=2))
        groups = quiet(lambda: roblox(f"https://groups.roblox.com/v1/users/{fid}/groups/roles", retries=2))
        count = len(own) if own is not None and complete else \
            quiet(lambda: roblox(f"https://friends.roblox.com/v1/users/{fid}/friends/count", retries=2)["count"])
        return {
            "friends": count,
            "robloxBadges": len(badges) if badges is not None else None,
            "groups": len(groups.get("data") or []) if groups is not None else None,
            "links": sorted((own & friend_set) - {fid}) if own is not None else None,
        }

    with ThreadPoolExecutor(max_workers=4) as pool:
        profiles = dict(zip(sample, pool.map(profile, sample)))
    shots = quiet(lambda: roblox("https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds="
                                 + ",".join(map(str, sample)) + "&size=48x48&format=Png&isCircular=false")) if sample else None
    avatars = {t["targetId"]: t.get("imageUrl") for t in (shots or {}).get("data") or []}
    return {"ids": ids, "hidden": hidden, "named": named, "info": info, "live": live,
            "sample": sample, "profiles": profiles, "avatars": avatars}


def _quiet(fn):
    """Run one optional Roblox call; a failure just means that detail is unknown."""
    try:
        return fn()
    except RobloxError:
        return None


def web_signals(user, raw, now=None):
    """Turn the friends data into per-friend rows, the links between them, and
    signals that move the score. Pure: no network."""
    now = now or time.time()
    signals = []

    def sig(points, label, detail):
        signals.append({"points": points, "label": label, "detail": detail, "category": "web"})

    created = parse_date(user.get("created"))
    known = (user["id"], created.timestamp()) if created else None
    born = known[1] if known else estimate_created(user["id"])
    ids, info, profiles = raw["ids"], raw["info"], raw["profiles"]
    age = {i: max(0, int((now - estimate_created(i, known)) // DAY)) for i in ids}
    same_week = [i for i in ids if abs(estimate_created(i, known) - born) <= 7 * DAY]
    banned = [i for i in raw["named"] if i in info and i not in raw["live"]]
    alike = [i for i in raw["named"] if i in info and similar_names(info[i].get("name") or "", user.get("name") or "")]

    friends = []
    for i in raw["sample"]:
        p, u = profiles[i], info[i]
        # "Thin": little on the profile beyond having been created.
        thin = sum([age[i] < 180, p["friends"] is not None and p["friends"] < 5,
                    p["robloxBadges"] == 0, p["groups"] == 0]) >= 3
        friends.append({
            "id": i, "name": u.get("name"), "displayName": u.get("displayName"),
            "verified": bool(u.get("hasVerifiedBadge")), "banned": i in banned, "similarName": i in alike,
            "estCreated": datetime.fromtimestamp(estimate_created(i, known), timezone.utc).strftime("%Y-%m"),
            "estAgeDays": age[i], "friends": p["friends"], "robloxBadges": p["robloxBadges"], "groups": p["groups"],
            "mutuals": len(p["links"]) if p["links"] is not None else None, "thin": thin,
            "avatarUrl": raw["avatars"].get(i), "profileUrl": f"https://www.roblox.com/users/{i}/profile",
        })
    in_sample = set(raw["sample"])
    links = sorted({(min(a, b), max(a, b)) for a in raw["sample"] for b in (profiles[a]["links"] or []) if b in in_sample})

    n = len(ids)
    if n < 3:
        sig(0, "Too few friends to read much into", f"{n} friend(s) on the list.")
    else:
        ages = sorted(age.values())
        median, young = ages[n // 2], sum(1 for a in ages if a < 90)
        if young * 10 >= n * 6:
            sig(12, "Friends are mostly new accounts", f"{young} of {n} friends look less than three months old.")
        elif median >= 730:
            sig(-8, "Friends are long-standing accounts", f"Half of the {n} friends are over {median // 365} years old.")
        elif median >= 365:
            sig(-4, "Friends are established accounts", f"Half of the {n} friends are over a year old.")
        if len(same_week) >= 3 and len(same_week) * 10 >= n * 3:
            sig(10, "Friends made alongside this account", f"{len(same_week)} of {n} friends were created within a week of it.")

        seen = [f for f in friends if f["friends"] is not None]
        thin = sum(1 for f in seen if f["thin"])
        if len(seen) >= 4 and thin * 10 >= len(seen) * 6:
            sig(8, "Friends' own profiles are empty", f"{thin} of {len(seen)} friends looked at have almost nothing on their profile.")
        elif len(seen) >= 4 and thin * 10 <= len(seen) * 2:
            sig(-4, "Friends have real profiles", f"{len(seen) - thin} of {len(seen)} friends looked at have friends, groups or badges of their own.")

        linked = [f for f in friends if f["mutuals"] is not None]
        tied = sum(1 for f in linked if f["mutuals"] >= 1)
        if len(linked) >= 4 and tied * 10 >= len(linked) * 6:
            sig(-8, "Friends know each other", f"{tied} of {len(linked)} friends looked at are also friends with others on the list.")
        elif len(linked) >= 4 and tied == 0:
            sig(6, "Friends don't know each other", f"None of the {len(linked)} friends looked at are friends with anyone else on the list.")

    if len(banned) >= 2 and len(banned) * 4 >= len(raw["named"]):
        sig(6, "Many banned friends", f"{len(banned)} of {len(raw['named'])} friends are banned accounts.")
    if alike:
        names = ", ".join(info[i]["name"] for i in alike[:3])
        sig(8, "Friends with near-identical usernames", f"{names}{' and others' if len(alike) > 3 else ''}.")

    signals.sort(key=lambda s: -abs(s["points"]))
    return {
        "friendCount": n, "hidden": raw["hidden"], "named": len(raw["named"]), "profiled": len(friends),
        "medianAgeDays": sorted(age.values())[n // 2] if n else None,
        "signals": signals, "friends": friends, "links": [list(l) for l in links],
    }


def deep_lookup(query):
    """A normal lookup plus the friends analysis. The deep score is the normal
    score moved by the web signals."""
    result = dict(cached_lookup(query))
    result.pop("cached", None)
    user = dict(result["user"])
    began = time.time()
    raw = deep_collect(user)
    run = _diagnostics.get(str(user["id"]))
    if run:
        unknown = sum(1 for p in raw["profiles"].values() for k in ("friends", "robloxBadges", "groups", "links") if p[k] is None) if raw else 0
        _diagnostics[str(user["id"])] = dict(run, deepMs=int((time.time() - began) * 1000), deepUnknownFields=unknown)
    if raw is None:
        result["deep"] = {"friendCount": None, "note": "This account's friends list isn't visible."}
        return result
    if not raw["ids"]:
        result["deep"] = {"friendCount": 0, "hidden": raw["hidden"], "note": "This account has no friends to look at."}
        return result
    deep = web_signals(user, raw)
    total = max(0, min(100, result["score"] + sum(s["points"] for s in deep["signals"])))
    if user.get("hasVerifiedBadge"):
        total = min(total, 10)
    deep["score"] = total
    deep["verdict"], deep["summary"] = verdict_of(total)
    result["deep"] = deep
    return result


# ---------------------------------------------------------------------------
# HTTP server: cache, rate limit, routing
# ---------------------------------------------------------------------------
_cache = {}
_cache_lock = threading.Lock()
_hits = {}
_hits_lock = threading.Lock()


def cached_lookup(query, fresh=False):
    key = query.strip().lower().lstrip("@")
    now = time.time()
    if not fresh:
        with _cache_lock:
            hit = _cache.get(key)
            if hit and now - hit[0] < CACHE_TTL:
                return dict(hit[1], cached=True)
    result = lookup(query)
    # A result that was partly rate-limited is only cached briefly so a re-check can fill it in.
    stamp = now if not any("429" in n for n in result["notes"]) else now - CACHE_TTL + 30
    with _cache_lock:
        _cache[key] = (stamp, result)
        _cache[str(result["user"]["id"])] = (stamp, result)
        _cache[(result["user"]["name"] or "").lower()] = (stamp, result)
        if len(_cache) > 2000:
            for k in sorted(_cache, key=lambda k: _cache[k][0])[:500]:
                _cache.pop(k, None)
    return dict(result, cached=False)


def cached_deep(query):
    key = "deep:" + query.strip().lower().lstrip("@")
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < CACHE_TTL:
            return dict(hit[1], cached=True)
    result = deep_lookup(query)
    with _cache_lock:
        for k in (key, f"deep:{result['user']['id']}", "deep:" + (result["user"]["name"] or "").lower()):
            _cache[k] = (now, result)
    return dict(result, cached=False)


def rate_limited(ip):
    now = time.time()
    with _hits_lock:
        q = _hits.setdefault(ip, deque())
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= RATE_LIMIT_PER_MIN:
            return True
        q.append(now)
        return False




# ---------------------------------------------------------------------------
# API routing shared by every host
# ---------------------------------------------------------------------------
def handle_api(path, query_string, ip):
    """Route an /api/* request. Returns (http_status, json_payload)."""
    if path.rstrip("/") == "/api/health":
        return 200, {"ok": True, "badgeCheck": bool(ROBLOX_COOKIE)}
    route = path.rstrip("/")
    if route not in ("/api/lookup", "/api/deep"):
        return 404, {"error": "not found"}
    qs = urllib.parse.parse_qs(query_string)
    q = qs.get("q", [""])[0]
    fresh = qs.get("fresh", ["0"])[0] == "1"
    if not q.strip():
        return 400, {"error": "Missing ?q=username-or-id"}
    if len(q) > 40:
        return 400, {"error": "Query too long"}
    if rate_limited(ip):
        return 429, {"error": "Slow down: too many lookups this minute."}
    try:
        result = cached_deep(q) if route == "/api/deep" else cached_lookup(q, fresh)
        if qs.get("debug", ["0"])[0] == "1":
            result["debug"] = {"cache": "hit" if result["cached"] else "miss",
                               "run": _diagnostics.get(str(result["user"]["id"]))}
        return 200, result
    except NotFound as e:
        return 404, {"error": str(e)}
    except RobloxError as e:
        return 502, {"error": f"Roblox API error: {e}"}
    except Exception as e:  # keep the stack trace out of the response
        print(f"lookup failed for {q!r}: {e!r}", flush=True)
        return 500, {"error": "Internal error"}
