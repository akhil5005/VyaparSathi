# Deployment

Two pieces on two subdomains of one domain:

| | Host | Address |
|---|---|---|
| API | Railway (or Render / Fly) | `api.yourname.me` |
| Web app | Cloudflare Pages (or Vercel / Netlify) | `app.yourname.me` |
| Database | Managed Postgres on the API's host | not public |

**Why two subdomains rather than two unrelated hosts.** Subdomains of one
registrable domain are cross-*origin* but same-*site*. That means CORS is
genuinely exercised — and the refresh cookie stays `SameSite=Lax` instead of
becoming a third-party cookie, which Safari blocks by default. Splitting across
`something.vercel.app` and `something.railway.app` would force `SameSite=None`
and give you an auth flow that fails on iPhone.

---

## Before you start

- A domain. A `.me` is free for a year with the [GitHub Student Developer
  Pack](https://education.github.com/pack) via Namecheap.
- Accounts on the two hosts. Both have free tiers that fit this.
- Nothing else. No credit card is needed for the free tiers, though Railway
  asks for one to lift its trial limits.

---

## 1. Database

Create a managed Postgres on the same host as the API — same region, so the
query round trip stays under a millisecond.

On Railway: **New → Database → PostgreSQL**. It injects `DATABASE_URL` into
services in the same project automatically; check whether it has before setting
it by hand.

**Turn on automated backups now, not later.** These are a business's books. A
daily snapshot with 7-day retention is the minimum; also see
[Backups](#4-backups) below for the off-host copy that matters more.

---

## 2. API

Point the host at this repository. The `Dockerfile` at the root is picked up
automatically by Railway, Render and Fly.

**Environment variables** — copy from `.env.production.example`. The two that
must be generated fresh:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Run it twice. `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` must differ from each
other and from your development values.

`APP_URL` must be the exact frontend origin — `https://app.yourname.me`, no
trailing slash. A mismatch here produces a CORS failure that reads as a
mysterious network error in the browser.

**Migrations run themselves.** `npm start` executes `prisma migrate deploy`
before booting, so a deploy is atomic from your point of view: if the migration
fails the container never starts and the previous one keeps serving.

**Health check**: `GET /health` returns `{"status":"ok"}`. Point the platform's
health check at it so a failed boot rolls back instead of serving errors.

### Custom domain

Add `api.yourname.me` in the host's domain settings. It will give you a CNAME
target; add that at your registrar:

```
CNAME   api   <target the host gives you>
```

HTTPS certificates are issued automatically once DNS resolves. Give it a few
minutes.

---

## 3. Web app

The frontend is static — built once, served from a CDN. No Node process.

| Setting | Value |
|---|---|
| Root directory | `web` |
| Build command | `npm ci && npm run build` |
| Output directory | `web/dist` |
| Environment variable | `VITE_API_URL=https://api.yourname.me` |

`VITE_API_URL` is read **at build time**, not runtime — Vite substitutes it into
the bundle. Change it and you must rebuild; setting it after a build has no
effect.

**Single-page app routing.** The router owns paths like `/billing` and
`/invoices`, but a static host looks for a file at that path and returns 404 on
a hard refresh. Every host needs a rewrite to `index.html`:

- **Cloudflare Pages** — add `web/public/_redirects` containing `/* /index.html 200`
- **Netlify** — the same `_redirects` file
- **Vercel** — detected automatically for Vite projects

This repository ships the `_redirects` file, so Cloudflare and Netlify work
without further configuration.

Then add `app.yourname.me` as a custom domain, with the CNAME the host gives you.

---

## 4. Backups

The platform's daily snapshot protects against the platform losing your data. It
does not protect against you, or a bug, deleting rows — and it lives with the
same provider. Keep a copy somewhere else:

```bash
pg_dump "$DATABASE_URL" --no-owner --format=custom > vyapar-$(date +%F).dump
```

Run it on a schedule and put the file somewhere off-host. Verify a restore works
at least once; a backup nobody has restored is a hypothesis.

---

## 5. First run

1. Open `https://app.yourname.me` and register the shop. This creates the firm,
   the owner account, the unit master and the invoice number sequences in one
   transaction — use the firm's **real GSTIN**, the checksum is validated.
2. Seed the HSN codes:
   ```bash
   npm run db:seed        # with DATABASE_URL pointing at production
   ```
   Skip `db:seed:catalogue` — those rates are invented sample data.
3. Enter the real product range, with real rates.
4. Enter opening balances and opening stock as at the switchover date.

---

## Still to do before real customers

- **Password reset delivery.** `auth.controller.ts` logs the reset link to the
  server console behind a `TODO`. Someone clicking "forgot password" in
  production currently receives nothing. Wire up SMS or WhatsApp before relying
  on it.
- **Error monitoring.** Nothing reports a 500 to you. Sentry's free tier covers
  this in about ten lines.

---

## Troubleshooting

**CORS errors in the browser console.** `APP_URL` on the API must exactly match
the frontend origin — scheme, host, no trailing slash, no path. Confirm what the
API thinks it allows by checking the `Access-Control-Allow-Origin` header on any
response.

**Logged out on every page load.** The refresh cookie is `Secure` in production,
so it is only sent over HTTPS. If the site is reachable over plain HTTP, fix
that first.

**404 on refreshing `/billing`.** The SPA rewrite is missing — see the web app
section above.

**`prisma migrate deploy` fails on boot.** Read the container log: it names the
migration and the SQL that failed. The database may already have tables from a
manual `db push`; a fresh database is the quickest fix while there is no real
data to lose.
