# Roblox Alt Checker

A website that looks up a Roblox username or user ID, pulls the account's
public data, and scores how likely it is to be an alt account. It runs as a
freemium service: guests and free accounts get a daily allowance and see ads,
and a paid Pro plan lifts the limit, removes the ads and unlocks bulk checks.

It checks: account age, friends, followers/following, Roblox badges, player
badges (optional), favorite games, inventory (limited items + paid wearables),
groups, created games, avatar customization, username history, and naming
patterns. Every signal is shown with the points it added or removed.

## Plans

|                          | Guest | Free account | Pro            |
|--------------------------|-------|--------------|----------------|
| Lookups per day          | 3     | 10           | 500            |
| Ads                      | yes   | yes          | no             |
| Bulk check (20 names)    | –     | –            | yes            |
| Refresh past the cache   | –     | –            | yes            |

The limits are secrets on the `check` function (`GUEST_DAILY_LIMIT`,
`FREE_DAILY_LIMIT`, `PRO_DAILY_LIMIT`), and the Pro price is whatever the Stripe
price says. The pricing page reads both from the server, so there is nothing to
keep in sync by hand. A cached result is free, a failed lookup is given back,
and allowances reset at 00:00 UTC.

## Layout

```
docs/                               the website (GitHub Pages serves this folder)
  index.html                        the checker
  pricing.html, account.html        plans; sign-in, plan, billing, delete account
  terms.html, privacy.html, refunds.html
  assets/config.js                  ← the one file you edit: keys, ad IDs, legal details
  assets/app.js, assets/style.css   shared session/plan/ads code and styles
supabase/migrations/*.sql           profiles + usage tables, quota functions
supabase/functions/check/index.ts   lookups, accounts, daily quotas (Deno)
supabase/functions/billing/index.ts Stripe checkout, portal, webhook, account deletion
supabase/config.t oml                both functions verify the caller themselves
checker.py + server.py              the lookup backend in Python, for self-hosting
Dockerfile                          container for the Python version
```

Roblox's APIs send no CORS headers, so the browser can't call them; the `check`
function does it and returns one JSON result. The Roblox and scoring code in
`index.ts` and `checker.py` are line-for-line ports: change both. Accounts,
quotas and billing exist only in the Supabase version.

## Going live

Do it in this order. Use Stripe **test mode** until the last step.

### 1. Supabase: database

Dashboard → **SQL Editor** → paste `supabase/migrations/20260929000000_freemium.sql`
→ Run. (Or `supabase db push`.) It is safe to run twice.

### 2. Supabase: sign-in settings

**Authentication → URL Configuration**: set *Site URL* to your site
(`https://checker.example.com`) and add `https://checker.example.com/**` to
*Redirect URLs*.

**Authentication → Emails → SMTP**: the built-in mailer only sends a couple of
emails an hour. Before launch, plug in your own SMTP (Resend, Postmark, SES…)
or sign-ups will stall waiting for confirmation emails.

Optional: **Authentication → Providers → Google**, then set `googleLogin: true`
in `config.js`. Optional but recommended: **Attack Protection → CAPTCHA**.

### 3. Supabase: functions

```bash
supabase login
supabase link --project-ref <your-project-ref>
supabase functions deploy check
supabase functions deploy billing
```

No CLI? Dashboard → **Edge Functions** → **Deploy a new function** → **Via
Editor**; create `check` and `billing`, paste each `index.ts`, and turn
**Verify JWT** off for both.

### 4. Stripe

1. **Product catalog → Add product**: "Pro", recurring price (monthly or
   yearly). Copy the price ID (`price_…`).
2. **Developers → API keys**: copy the secret key (`sk_test_…`).
3. **Developers → Webhooks → Add endpoint**:
   `https://<project-ref>.supabase.co/functions/v1/billing/webhook`, events
   `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`.
   Copy the signing secret (`whsec_…`).
4. **Settings → Billing → Customer portal**: switch it on and allow customers
   to cancel subscriptions and update payment methods. "Manage billing" on the
   account page opens this.
5. **Settings → Payment methods**: enable what you want to accept (cards, Apple
   Pay, Google Pay, PayPal, Link…). Checkout offers whatever is enabled here.
6. **Settings → Business → Public details**: add your support email and the
   URLs of the Terms, Privacy and Refund pages.

### 5. Secrets

Dashboard → **Edge Functions → Secrets**, or `supabase secrets set NAME=value`.

| Secret                  | Needed   | What it does                                                  |
|-------------------------|----------|---------------------------------------------------------------|
| `STRIPE_SECRET_KEY`     | yes      | `sk_test_…` / `sk_live_…`                                     |
| `STRIPE_PRICE_ID`       | yes      | `price_…` of the Pro price                                    |
| `STRIPE_WEBHOOK_SECRET` | yes      | `whsec_…` of the webhook endpoint                             |
| `SITE_URL`              | yes      | Where the site lives; Stripe sends people back here           |
| `ALLOWED_ORIGIN`        | advised  | Lock CORS to your site, e.g. `https://checker.example.com`    |
| `GUEST_DAILY_LIMIT`     | no (3)   | Lookups a day without an account, per IP                      |
| `FREE_DAILY_LIMIT`      | no (10)  | Lookups a day on a free account                               |
| `PRO_DAILY_LIMIT`       | no (500) | Lookups a day on Pro                                          |
| `STRIPE_AUTOMATIC_TAX`  | no       | `1` to let Stripe Tax add tax at checkout (set Stripe Tax up first) |
| `ROBLOX_COOKIE`         | no       | `.ROBLOSECURITY` of a spare account; enables the badge check  |
| `CACHE_TTL`             | no (600) | Seconds a lookup is cached                                    |
| `RATE_LIMIT_PER_MIN`    | no (20)  | Burst limit per IP per minute                                 |
| `IP_HASH_SALT`          | no       | Salt for the guest IP hash (defaults to the service key)      |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are provided
by Supabase automatically.

### 6. `docs/assets/config.js`

Fill in the Supabase URL and anon key (**Project Settings → API**), and your
name or company, contact email and governing law. Those three are printed in
the Terms, Privacy Policy and Refund Policy; until they're set the pages show
an orange "[… not set]" marker. Read the three policies through and adjust them
to what you actually intend to do, the refund windows especially.

### 7. GitHub Pages

```bash
git remote add origin git@github.com:<you>/roblox-checker.git
git push -u origin main
```

Repo → **Settings → Pages** → *Deploy from a branch* → `main`, folder `/docs`.
Enter your custom domain there, add the DNS record GitHub asks for, and tick
*Enforce HTTPS*. Every later `git push` redeploys the site; the functions only
change when you redeploy them.

### 8. Test, then switch Stripe to live

Create an account, open Pricing, and pay with card `4242 4242 4242 4242` (any
future date, any CVC). The account page should flip to Pro within seconds, the
ads should disappear, and "Manage billing" should let you cancel. Then create
the product, price, webhook and portal settings again in live mode and replace
the three `STRIPE_*` secrets with the live values.

### 9. Google AdSense

1. Apply at adsense.google.com with your domain. Approval needs the site to be
   live with real content, and a custom domain (not `<you>.github.io/repo`).
2. Once approved, create two **Display** ad units and put the publisher ID
   (`ca-pub-…`) and the two unit IDs into `config.js`.
3. Create `docs/ads.txt` with the line AdSense gives you
   (`google.com, pub-…, DIRECT, f08c47fec0942fa0`).
4. **Privacy & messaging** in AdSense: create the European consent message.
   Google requires a certified consent prompt for visitors from the EEA, UK and
   Switzerland; this one is served by the ad script, no code needed.

Ads only load for guests and free accounts, only on the checker page, and the
ad script is never requested for Pro. On `localhost` a dashed placeholder marks
where each ad will sit.

## How the pieces fit

- **Who is calling.** The page sends the Supabase access token with each
  lookup. `check` asks Supabase Auth who it belongs to and reads `plan` from
  `profiles`. No token means a guest, counted by a salted hash of the IP.
- **Quotas.** `consume_lookup()` in Postgres takes one lookup atomically, so
  parallel requests can't overshoot. The `usage` table holds counts only, never
  which usernames were looked up, and sweeps itself after two days.
- **Becoming Pro.** `billing/checkout` creates a Stripe Checkout session. Stripe
  calls `billing/webhook`, which verifies the signature, re-reads the
  subscription from Stripe and writes `plan` to `profiles`. Browsers can read
  their own profile row but never write it.
- **Staying in sync.** Cancellations, failed payments and renewals arrive as
  `customer.subscription.*` events. As a backstop, `check` treats Pro as lapsed
  three days after the paid period ends if no renewal was recorded.

## Run it yourself instead (Python, no dependencies)

```bash
python3 server.py            # http://localhost:8080
```

With `config.js` left blank the site runs in self-hosted mode: `/api` on the
same host, no accounts, no limits beyond the burst limiter, no ads, everything
unlocked. `ROBLOX_COOKIE`, `CACHE_TTL`, `RATE_LIMIT_PER_MIN` and `PORT` apply.
Works on any Docker host
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

`GET <project>/functions/v1/check?q=<username or id>` (or `/api/lookup?q=` on
the Python server) returns JSON with `user`, `stats`, `score`, `verdict`,
`signals`, `notes` (anything that couldn't be checked) and, when accounts are
on, `quota`. `&fresh=1` skips the cache (Pro). `?quota=1` returns the caller's
plan and allowance; `?health=1` (or `/api/health`) reports whether the badge
check is enabled. When the allowance is used up the reply is HTTP 429 with
`code: "quota"`.
