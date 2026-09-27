# Roblox Alt Checker

A web app that looks up a Roblox username or user ID, pulls the account's
public data, and scores how likely it is to be an alt account.

It checks: account age, friends, followers/following, Roblox badges, player
badges (optional), favorite games, inventory (limited items + paid wearables),
groups, created games, avatar customization, username history, and naming
patterns. Every signal is shown with the points it added or removed, so you can
see *why* an account got its score.

Free and off-sale-at-zero items are excluded from the wardrobe count (only
items with a real price, resale value, or Limited status count), and the
auto-generated "username's Place" places are excluded from created games.

## Layout

```
docs/index.html                     the website (GitHub Pages serves this folder)
supabase/functions/check/index.ts   the backend: a Supabase Edge Function (Deno)
supabase/config.toml                marks the function as public (no login needed)
checker.py + server.py              same backend in Python, for running it yourself
Dockerfile                          container for the Python version
```

Why a backend at all? Roblox's APIs don't send CORS headers, so a browser page
on GitHub Pages can't call them directly. The Edge Function does the Roblox
calls and returns one JSON result. The TypeScript and Python versions are
line-for-line ports of each other; use whichever host you like.

## Deploy: GitHub Pages + Supabase (recommended)

### 1. Push to GitHub

```bash
cd roblox-checker
git remote add origin git@github.com:<you>/roblox-checker.git   # or the https URL
git push -u origin main
```

### 2. Deploy the Edge Function to Supabase

Option A, from the dashboard (no CLI): open your project → **Edge Functions** →
**Deploy a new function** → **Via Editor**. Name it `check`, paste the contents of
`supabase/functions/check/index.ts`, and deploy. Then open the function's
settings and turn **Verify JWT** off (the page calls it without logging in).

Option B, with the Supabase CLI:

```bash
supabase login
supabase link --project-ref <your-project-ref>
supabase functions deploy check
```

`supabase/config.toml` already sets `verify_jwt = false` for it.

Either way you end up with a URL like
`https://<project-ref>.supabase.co/functions/v1/check`. Test it in the browser:
`.../check?q=builderman` should return JSON.

Optional secrets (dashboard → Edge Functions → Secrets, or `supabase secrets set`):

| Secret               | Default | What it does                                                 |
|----------------------|---------|--------------------------------------------------------------|
| `ROBLOX_COOKIE`      | *(off)* | `.ROBLOSECURITY` of a spare account; enables the badge check |
| `CACHE_TTL`          | `600`   | Seconds a lookup is cached                                   |
| `RATE_LIMIT_PER_MIN` | `20`    | Lookups allowed per visitor IP per minute                    |
| `ALLOWED_ORIGIN`     | `*`     | Lock CORS to your site, e.g. `https://checker.example.com`   |

### 3. Point the page at the function

Open `docs/index.html`, find the `API_BASE` line near the top of the script, and
paste your function URL:

```js
const API_BASE = "https://<project-ref>.supabase.co/functions/v1/check";
```

Commit and push.

### 4. Turn on GitHub Pages

Repo → **Settings** → **Pages** → Source: *Deploy from a branch* → Branch:
`main`, folder: `/docs` → Save. After a minute the site is live at
`https://<you>.github.io/roblox-checker/`.

**Custom domain:** on the same Pages settings screen enter your domain and save.
GitHub commits a `CNAME` file into `docs/`. At your DNS provider add a `CNAME`
record pointing your subdomain (e.g. `checker`) to `<you>.github.io`, or for an
apex domain the four `A` records GitHub lists. Tick *Enforce HTTPS* once the
certificate is issued. If you set `ALLOWED_ORIGIN` on the function, use this
domain.

Every later `git push` redeploys the page automatically. The Edge Function only
changes when you redeploy it.

## Run it yourself instead (Python, no dependencies)

```bash
python3 server.py            # http://localhost:8080
```

Leave `API_BASE` empty in `docs/index.html` and the page uses `/api` on the same
host. The same environment variables as above apply, plus `PORT`. Works as-is on
Render (start command `python server.py`), Railway, Fly.io, or any Docker host
(`docker build -t roblox-checker . && docker run -p 8080:8080 roblox-checker`).

## About the player-badge check

Roblox requires a logged-in session to list the badges a player has earned in
games. Everything else works anonymously. To enable it, set `ROBLOX_COOKIE` to
the `.ROBLOSECURITY` cookie of a **spare** Roblox account (browser dev tools →
Application → Cookies → roblox.com). It's only used for read-only requests, but
treat it like a password: never commit it or paste it in chat. Without it the
"Player badges" tile shows `n/a` and the score skips that signal.

## How the score works

Every account starts at 35. Each signal adds points (more alt-like) or removes
them (more main-like); the result is clamped to 0–100.

| Score | Verdict       |
|-------|---------------|
| 70+   | Likely alt    |
| 50–69 | Possibly alt  |
| 30–49 | Probably main |
| < 30  | Likely main   |

The strongest signals are account age (up to +30 under a week old), a verified
badge (−30, and caps the score at 10), limited-item ownership, friend count, and
the username or description literally mentioning an alt. The weights live in
`score()` in both `checker.py` and `index.ts`; change both to keep them in sync.

This is a heuristic on public data only. A quiet, private, new-ish main will
look like an alt; a well-dressed alt with friends will look like a main.

## API

`GET <function-url>?q=<username or id>` (or `/api/lookup?q=` on the Python
server) returns JSON with `user`, `stats`, `score`, `verdict`, `signals`, and
`notes` (anything that couldn't be checked). Add `&fresh=1` to bypass the cache.
`?health=1` (or `/api/health`) reports whether the badge check is enabled.
