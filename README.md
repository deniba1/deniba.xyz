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
| Deep checks per day      | –     | 1            | 10             |
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
  assets/theme.js                   light/dark switcher
  robots.txt, sitemap.xml, 404.html, favicon.*, assets/og.png   for search and sharing
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

Dashboard → **SQL Editor** → paste and run each file in `supabase/migrations/`,
oldest first: `20260929000000_freemium.sql`, then
`20261001000000_rate_limits.sql`. (Or `supabase db push`.) Each is safe to run
twice. When a later change adds a migration, run it *before* redeploying the
functions.

### 2. Supabase: sign-in settings

**Authentication → URL Configuration**: set *Site URL* to your site
(`https://checker.example.com`) and add `https://checker.example.com/**` to
*Redirect URLs*.

**Authentication → Emails → SMTP**: the built-in mailer only delivers to your
own project team's addresses, at 2 emails an hour, so real visitors never get
their confirmation email. Plug in your own SMTP before launch. Resend's free
plan is enough to start: verify your domain there, create an API key, then
enter host `smtp.resend.com`, port `465`, username `resend`, password = the API
key, and a sender like `no-reply@yourdomain.com`. Afterwards raise the email
limit under **Authentication → Rate Limits** (custom SMTP starts at 30 an hour).

Optional: **Authentication → Providers → Google**, then set `googleLogin: true`
in `config.js`.

Optional, against throwaway sign-ups: a “verify you are human” check. Create a
free **Turnstile** widget in Cloudflare (it gives a site key and a secret key),
put the site key in `turnstileSiteKey` in `config.js` and push, and only then
enable **Authentication → Attack Protection → CAPTCHA** in Supabase with
provider Turnstile and the secret key. Order matters: once Supabase's side is
on, sign-ins without the check are rejected.

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
3. Open dashboard.stripe.com/webhooks (the **Webhooks** tab in Workbench) →
   **Create an event destination** → *Your account* → keep the suggested API
   version → tick the four events `checkout.session.completed`,
   `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted` → **Continue** → *Webhook endpoint* →
   Endpoint URL `https://<project-ref>.supabase.co/functions/v1/billing/webhook`.
   `<project-ref>` is the first part of your Supabase project URL. On the
   endpoint's page, **Reveal** the signing secret (`whsec_…`) and copy it.
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
| `DEEP_FREE_DAILY_LIMIT` | no (1)   | Deep checks a day on a free account                           |
| `DEEP_PRO_DAILY_LIMIT`  | no (10)  | Deep checks a day on Pro                                      |
| `DEEP_GUEST_DAILY_LIMIT`| no (0)   | Deep checks a day without an account                          |
| `DEEP_GLOBAL_PER_MIN`   | no (3)   | Deep checks a minute across the whole site, Pro included      |
| `DEEP_SAMPLE`           | no (20)  | Friends profiled one by one in a deep check                   |
| `STRIPE_AUTOMATIC_TAX`  | no       | `1` to let Stripe Tax add tax at checkout (set Stripe Tax up first) |
| `ROBLOX_COOKIE`         | no       | `.ROBLOSECURITY` of a spare account; enables the badge check  |
| `CACHE_TTL`             | no (600) | Seconds a lookup is cached                                    |
| `IP_DAILY_LIMIT`        | no (40)  | Non-Pro lookups a day from one network, across all its guests and free accounts |
| `GLOBAL_DAILY_LIMIT`    | no (5000)| Non-Pro lookups a day across the whole site                   |
| `RATE_LIMIT_PER_MIN`    | no (20)  | New lookups a minute per network, and per account             |
| `GLOBAL_PER_MIN`        | no (60)  | Non-Pro new lookups a minute across the whole site            |
| `REQUESTS_PER_MIN`      | no (120) | Requests of any kind a minute per network                     |
| `IP_HASH_SALT`          | no       | Salt for the network-address hash (defaults to the service key) |

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

### 10. Search engines

The pages carry titles, descriptions, canonical links, social-preview tags and
(on the checker) `WebApplication` structured data; `docs/robots.txt` and
`docs/sitemap.xml` tell crawlers what exists. The account page is `noindex`.
Lookup results live behind `#username` and are deliberately not indexable.

1. **Google Search Console** (search.google.com/search-console): add the
   domain, verify it with the DNS TXT record it gives you, then submit
   `https://deniba.xyz/sitemap.xml` under *Sitemaps*. Bing Webmaster Tools can
   import the site from Search Console.
2. Make sure `http://` redirects to `https://`. If the domain goes through
   Cloudflare, switch on **SSL/TLS → Edge Certificates → Always Use HTTPS**
   there; otherwise tick *Enforce HTTPS* in the repo's Pages settings.

The domain is written into the canonical/`og:` tags in each page's `<head>`,
`robots.txt`, `sitemap.xml` and the JSON-LD in `index.html`. If the site ever
moves, search the `docs/` folder for `deniba.xyz` and replace it. When a page's
content changes, bump its `<lastmod>` in the sitemap.

### Changing the shared files

The pages load `style.css`, `theme.js`, `config.js` and `app.js` with a version
on the end (`assets/style.css?v=8`). Browsers keep those files for hours, so
whenever you change one of them, raise the number in every page in `docs/`
(search for `?v=`). Otherwise visitors get the new page with the old styles or
settings until their cache expires.

## How the pieces fit

- **Who is calling.** The page sends the Supabase access token with each
  lookup. `check` asks Supabase Auth who it belongs to and reads `plan` from
  `profiles`. No token means a guest, counted by a salted hash of the IP.
- **Limits.** Every new lookup goes through `admit_lookup()` in Postgres,
  which checks and counts everything in one atomic step, so parallel requests
  and multiple copies of the function can't overshoot:
  - per minute: the caller's network, the account, and the whole site;
  - per day: the caller's own allowance, the network's total across all its
    guests and free accounts, and the site's total.

  Pro is exempt from the network and site-wide limits, so abuse elsewhere never
  costs a paying customer a lookup. A network is one IPv4 address or one IPv6
  /64. Failed lookups are given back, at most ten a day per caller. Billing
  actions are limited to ten per account per ten minutes. The tables hold
  counts against salted hashes, never addresses or the usernames looked up,
  and sweep themselves after a couple of days.
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

## Badge timing

Game badges only count if they were earned at a human pace. The lookup reads
each badge's award date (`/v1/users/{id}/badges/awarded-dates`, 100 at a time)
and marks any run of 10 or more within 10 minutes as farmed, the signature of
"badge walk" games. Farmed badges are left out of the badge count, and when
they make up most of an account's badges it adds a "Badges look farmed" signal.
Badges spread over 15 or more different days count toward "main". Like the
badge list itself, this needs `ROBLOX_COOKIE`.

## Deep check

`?deep=1` runs a normal lookup and then looks at the account's friends:

1. the whole friends list (IDs only);
2. names and banned status for up to 200 of them, in batches;
3. for a spread of 20 (`DEEP_SAMPLE`): friend count, official badges, groups,
   and the first 100 of their own friends, to see who knows whom.

Roblox allows about 30 profile reads a minute, so friends' creation dates are
not fetched: they are estimated from the user ID, which Roblox hands out in
order. `ID_ANCHORS` in both backends maps IDs to dates (sampled October 2026;
add a row now and then so new accounts keep being dated well).

The web signals (friends mostly new, made the same week as the account, empty
profiles, strangers to each other, many banned, near-identical usernames, or
the opposite of each) move the normal score to give the deep score. The page
draws the profiled friends as a web: the account in the middle, a line between
any two friends who are friends with each other.

Deep checks have their own daily allowance and their own site-wide brake
(`DEEP_GLOBAL_PER_MIN`), which applies to Pro too because Roblox's limits on
reading friends lists are per server, not per customer. A deep check of an
account with no visible friends is not counted.

## API

`GET <project>/functions/v1/check?q=<username or id>` (or `/api/lookup?q=` on
the Python server) returns JSON with `user`, `stats`, `score`, `verdict`,
`signals`, `notes` (anything that couldn't be checked) and, when accounts are
on, `quota`. `&fresh=1` skips the cache (Pro). `&deep=1` adds `deep` (the friends analysis)
and `deepQuota`; on the Python server use `/api/deep?q=`. `?quota=1` returns the caller's
plan and allowance; `?health=1` (or `/api/health`) reports whether the badge
check is enabled. When the allowance is used up the reply is HTTP 429 with
`code: "quota"`.
