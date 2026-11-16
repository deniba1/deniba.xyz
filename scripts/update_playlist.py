"""Refresh docs/assets/playlist.json from a public Spotify playlist.

Reads the playlist's public embed page (no API key needed), takes each track's
title, artist, length and 30-second preview, looks up cover art through
Spotify's oEmbed endpoint and finds full-length YouTube uploads for the player.
Covers and YouTube matches already in the existing file are reused, so a
run only makes new requests for newly added songs. The file is rewritten only
when the track list changes, which keeps the GitHub Action from committing
when nothing happened.

Usage: python scripts/update_playlist.py <playlist id> [output path]
"""
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"


def get(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "en"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8")


def playlist_entity(playlist_id: str) -> dict:
    html = get(f"https://open.spotify.com/embed/playlist/{playlist_id}")
    m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html, re.S)
    if not m:
        raise SystemExit("could not find playlist data in the embed page (did Spotify change it?)")
    return json.loads(m.group(1))["props"]["pageProps"]["state"]["data"]["entity"]


def cover_for(track_id: str) -> str:
    q = urllib.parse.quote(f"https://open.spotify.com/track/{track_id}", safe="")
    try:
        return json.loads(get(f"https://open.spotify.com/oembed?url={q}")).get("thumbnail_url", "")
    except Exception as e:  # a missing cover should not fail the whole run
        print(f"  no cover for {track_id}: {e}", file=sys.stderr)
        return ""


VARIANTS = ("slowed", "reverb", "sped up", "speed up", "nightcore", "remix", "live", "cover",
            "instrumental", "karaoke", "8d", "bass boosted", "lyrics", "1 hour", "loop")


def _secs(text: str) -> int:
    n = 0
    for part in text.split(":"):
        n = n * 60 + int(part or 0)
    return n


def _norm(s: str) -> str:
    s = re.sub(r"[^a-z0-9 ]+", " ", s.lower())
    s = re.sub(r"\bsp(?:ee|e)d ?up\b", "sped up", s)   # spedup, speedup, speed up
    return re.sub(r"\breverb(?:ed)?\b", "reverb", s)


def youtube_matches(title: str, artist: str, duration_ms: int, limit: int = 3) -> list:
    """Video ids for full-length versions of a track, best match first.

    Scrapes YouTube's public search page (no key). Candidates are ranked by how
    close their length is to Spotify's, then by signs of an official upload
    ("- Topic" channels, "official audio"). Versions such as slowed or sped-up
    edits are pushed down unless the Spotify title is that version itself.
    """
    first_artist = artist.split(",")[0]
    for query in (f"{artist} {title} audio", f"{first_artist} {title}"):
        ids = _rank(_search(query), title, first_artist, duration_ms)
        if ids:
            return ids[:limit]
    return []


def _search(query: str) -> list:
    q = urllib.parse.quote_plus(query)
    try:
        html = get(f"https://www.youtube.com/results?search_query={q}&sp=EgIQAQ%253D%253D")  # videos only
    except Exception as e:
        print(f"  youtube search failed for {query!r}: {e}", file=sys.stderr)
        return []
    m = re.search(r"var ytInitialData = (\{.*?\});</script>", html, re.S)
    if not m:
        return []
    found = []

    def walk(o):
        if isinstance(o, dict):
            if "videoRenderer" in o:
                found.append(o["videoRenderer"])
            else:
                for v in o.values():
                    walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(json.loads(m.group(1)))
    return found


def _rank(found: list, title: str, artist: str, duration_ms: int) -> list:
    want = duration_ms / 1000
    t_norm, a_norm = _norm(title), _norm(artist.split(",")[0])
    scored = []
    for v in found[:15]:
        try:
            vid = v["videoId"]
            vtitle = "".join(r.get("text", "") for r in v["title"]["runs"])
            channel = "".join(r.get("text", "") for r in v.get("ownerText", {}).get("runs", []))
            length = _secs(v["lengthText"]["simpleText"])
        except (KeyError, ValueError, TypeError):
            continue  # live streams and shorts have no length
        vt = _norm(vtitle)
        diff = abs(length - want)
        if diff > 25:
            continue
        score = diff
        if channel.endswith("- Topic"):
            score -= 8
        if "official audio" in vt or "official video" in vt or "official music video" in vt:
            score -= 4
        if a_norm and a_norm.strip() in _norm(channel + " " + vtitle):
            score -= 3
        main_words = [w for w in _norm(title.split(" - ")[0]).split() if len(w) > 1]
        if main_words and not all(w in vt for w in main_words):
            score += 12
        for word in VARIANTS:
            if (word in vt) != (word in t_norm):   # an edit the track isn't, or a missing edit it is
                score += 15
        scored.append((score, vid))
    scored.sort()
    return [vid for _, vid in scored]


def main() -> None:
    playlist_id = sys.argv[1]
    out = Path(sys.argv[2] if len(sys.argv) > 2 else "docs/assets/playlist.json")

    old = {}
    if out.exists():
        try:
            old = json.loads(out.read_text(encoding="utf-8"))
        except ValueError:
            pass
    known_covers = {t["id"]: t.get("cover", "") for t in old.get("tracks", [])}
    known_yt = {t["id"]: t.get("youtube", []) for t in old.get("tracks", [])}

    e = playlist_entity(playlist_id)
    tracks = []
    for t in e.get("trackList", []):
        uri = t.get("uri", "")
        if not uri.startswith("spotify:track:"):
            continue  # skip podcast episodes and local files
        tid = uri.rsplit(":", 1)[1]
        cover = known_covers.get(tid) or cover_for(tid)
        title, artist, duration = t.get("title", ""), t.get("subtitle", "").replace(" ", " "), t.get("duration", 0)
        yt = known_yt.get(tid) or youtube_matches(title, artist, duration)
        tracks.append({
            "id": tid,
            "title": title,
            "artist": artist,
            "duration": duration,
            "explicit": bool(t.get("isExplicit")),
            "preview": (t.get("audioPreview") or {}).get("url", ""),
            "cover": cover,
            "youtube": yt,
        })

    images = (e.get("coverArt") or {}).get("sources") or []
    data = {
        "id": playlist_id,
        "name": e.get("name", ""),
        "owner": e.get("subtitle", ""),
        "url": f"https://open.spotify.com/playlist/{playlist_id}",
        "cover": images[0]["url"] if images else "",
        "tracks": tracks,
    }

    if data == old:
        print(f"no change ({len(tracks)} tracks)")
        return
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {out}: {len(tracks)} tracks")


if __name__ == "__main__":
    main()
