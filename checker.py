"""Roblox Alt Checker - core logic (no web server in here).

Pulls public data from Roblox's APIs for a username or user ID, scores it, and
returns a JSON-ready dict. Used by server.py (local/Render/Docker). The Supabase
Edge Function in supabase/functions/check/index.ts is a port of this file.

Environment variables:
  ROBLOX_COOKIE        optional .ROBLOSECURITY value; enables the player-badge check
  CACHE_TTL            seconds to cache a lookup (default 600)
  RATE_LIMIT_PER_MIN   lookups allowed per client IP per minute (default 20)
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
        earliest = None
        for b in items:
            d = (b.get("awardedDate") or b.get("created") or "")
            if d and (earliest is None or d < earliest):
                earliest = d
        return {"count": len(items), "truncated": truncated,
                "earliest": earliest, "sample": [b["name"] for b in items[:8]]}

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
        try:
            return {"ok": True, "data": fn()}
        except RobloxError as e:
            return {"ok": False, "error": str(e)}
        except Exception as e:  # malformed response etc.
            return {"ok": False, "error": f"unexpected: {e.__class__.__name__}: {e}"}

    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {k: pool.submit(run, fn) for k, fn in tasks.items()}
        return {k: f.result() for k, f in futures.items()}


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
        count = pb["count"]
        if count == 0:
            sig(12, "No player badges", "Has never earned a badge in any game.", "activity")
        elif count < 10:
            sig(6, "Few player badges", f"{count} game badges.", "activity")
        elif count >= 100:
            sig(-12, "Lots of player badges", f"{count}{'+' if pb['truncated'] else ''} game badges.", "activity")
        elif count >= 30:
            sig(-7, "Plenty of player badges", f"{count} game badges.", "activity")
        else:
            sig(-3, "Some player badges", f"{count} game badges.", "activity")

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

    if total >= 70:
        verdict, summary = "Likely alt", "Most signals point to a throwaway or secondary account."
    elif total >= 50:
        verdict, summary = "Possibly alt", "Mixed signals; leans toward an alt or a very inactive account."
    elif total >= 30:
        verdict, summary = "Probably main", "Looks like a real, moderately active account."
    else:
        verdict, summary = "Likely main", "Strong history and activity for a primary account."

    signals.sort(key=lambda s: -abs(s["points"]))
    return total, verdict, summary, signals


def lookup(query):
    user = resolve_user(query)
    uid = user["id"]
    data = collect(uid, user.get("name") or "")
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
    if path.rstrip("/") != "/api/lookup":
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
        return 200, cached_lookup(q, fresh)
    except NotFound as e:
        return 404, {"error": str(e)}
    except RobloxError as e:
        return 502, {"error": f"Roblox API error: {e}"}
    except Exception as e:  # keep the stack trace out of the response
        print(f"lookup failed for {q!r}: {e!r}", flush=True)
        return 500, {"error": "Internal error"}
