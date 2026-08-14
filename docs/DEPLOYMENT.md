# Deployment

**One service, one origin.** The Docker image builds the web app and the API
together, and Express serves the built frontend alongside `/api/*`.

Why not two hosts. `something.onrender.com` and `something.pages.dev` are
different *registrable domains*, which makes the refresh cookie a genuine
third-party cookie — Safari blocks those by default and Chrome is phasing them
out. Login would work on a laptop and fail on a phone. One origin removes the
problem rather than working around it, needs no CORS in production, and costs
one service instead of two.

If you later get a domain, splitting is easy: build the frontend with
`VITE_API_URL=https://api.yourdomain` and deploy `web/dist` separately. The
server only serves the app when `web/dist` exists, so it needs no change. Two
subdomains of one domain are cross-origin but *same-site*, so the cookie stays
`SameSite=Lax`.

| | Service | Free? |
|---|---|---|
| App + API | Render Web Service (Docker) | Yes — but sleeps after ~15 min idle |
| Database | Neon Postgres | Yes, and persistent |

**The sleep matters.** A free Render service takes 30–60 seconds to wake. Fine
for a demo; unusable at a counter, where the operator would press "New bill" and
stare at nothing. Upgrade to a paid instance the week the shop starts relying on
it. *(Check current pricing — it moves.)*

---

## 1. Database — Neon (~5 min)

[neon.tech](https://neon.tech) → sign in with GitHub → **New Project** →
region **Singapore** (closest to Punjab).

Copy the connection string:

```
postgresql://user:pass@ep-xxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
```

That is a real secret. It goes into Render's environment settings and nowhere
else.

Neon's free tier keeps a **6-hour** history window you can restore from — the
slider in *Settings → History window* stops there, and 30 days is a paid
feature. Six hours is not a floor you can build on: a bad delete on Monday
afternoon, noticed on Tuesday morning, is already past it. Treat Neon's history
as protection against Neon losing data and nothing else, and read
[Backups](#4-backups) as the actual recovery plan.

*(Check the console rather than trusting this line — an earlier version of this
document claimed 7 days, which was wrong, and free-tier limits move.)*

---

## 2. App + API — Render (~15 min)

[render.com](https://render.com) → **New → Web Service** → connect GitHub →
pick **VyaparSathi**.

| Field | Value |
|---|---|
| Language | **Docker** (it finds the `Dockerfile`) |
| Region | Singapore |
| Health check path | `/health` |

**Environment variables:**

```
NODE_ENV            production
DATABASE_URL        <the Neon string>
JWT_ACCESS_SECRET   <generate>
JWT_REFRESH_SECRET  <generate>
```

Generate the secrets by running this **twice**, using a different output for
each — they must differ from one another and from your development values:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

`APP_URL` is **not needed** in a single-origin deployment. CORS never engages,
because the browser is talking to the origin it loaded from. Leave it unset.

The first build takes several minutes — it installs both dependency trees and
builds both halves. Watch the log for `prisma migrate deploy` creating the
tables, then `Vyapar Sathi API listening`.

Then open `https://<your-service>.onrender.com`. The app itself should load, not
JSON.

---

## 3. First run

1. **Register a new shop** — use the firm's **real GSTIN**; the checksum is
   validated. This creates the firm, the owner account, the unit master and the
   invoice number sequences in one transaction.
2. Seed the HSN codes at 18%, run locally against production:
   ```bash
   DATABASE_URL="<neon string>" npm run db:seed
   ```
3. **Do not run `db:seed:catalogue`.** Those rates are invented sample data.
4. Enter the real product range with real rates, then opening balances and
   opening stock as at the switchover date.

---

## 4. Backups

Neon's history protects against Neon losing data. It does not protect against a
bad delete, it lives with the same provider, and on the free tier it reaches
back only six hours. Anything older than that has exactly one recovery path:
a copy you took yourself.

**From the app, which is what will actually get used.** Settings → Backup →
*Download backup*, owner only. One JSON file with every customer, product, bill,
payment and ledger entry. The counts are shown before the download so an empty
backup cannot be mistaken for a good one. Putting it back:

```bash
DATABASE_URL="<empty database>" \
  npm run backup:restore -- ./backup.json --owner-password "a new password"
```

Password hashes are deliberately not in the file, which is why restoring sets a
fresh owner password. Details in the README under **Backups**.

**Or `pg_dump`, where a shell and a client are available.** A true
point-in-time dump rather than a read across several queries:

```bash
pg_dump "$DATABASE_URL" --no-owner --format=custom > vyapar-$(date +%F).dump
```

Either way: on a schedule, stored somewhere that is not Neon, and restored once
to prove it works — a backup nobody has restored is a hypothesis. Nothing here
runs automatically yet; somebody has to do it.

---

## Forgotten passwords

**On a deployment with no `RESEND_API_KEY`, the "forgot password" link cannot
send anything to anybody.** That is the default state, and it is worth knowing
before someone needs it rather than after. The screen says so plainly — it
checks whether the server has a delivery channel at all and, when it does not,
points at the paths below instead of telling the person to check an inbox.

Three paths. The first works today with nothing configured.

**Owner sets it.** Settings → Staff → **Set password**. Available today, needs
nothing configured. The password is shown rather than masked so the owner can
read it out, and setting it signs that person out of every device — usually the
point, since the reason for a reset is often that someone else knows the old
one. An owner cannot set another owner's password, or their own; changing your
own goes through **change password**, which demands the current one.

**The owner's own password: `npm run set-password`.** Nobody can reset the
owner — that is the whole point of the paragraph above, and it cuts both ways.
An owner who forgets their password, on a shop with no mail provider or with no
email address on the account, would otherwise be locked out of the business's
own books for good. So:

```bash
DATABASE_URL="postgresql://…" \
  npm run set-password -- --user 9876500001 --password "a new password"
```

It matches the account the same way the login screen does — phone or email —
signs that user out of every device, and writes an audit entry recording that
the change came from the command line. It is deliberately not an HTTP endpoint:
anyone who can run it already holds the database connection string and could do
anything at all, so it grants nothing new. An endpoint would.

**Emailed reset link.** Set `RESEND_API_KEY` and `MAIL_FROM` and the "forgot
password" flow emails a one-time link that expires in 30 minutes. Two caveats,
and the second catches people out: Resend needs a verified sending domain
before it will deliver to arbitrary recipients, and **an account with no email
address cannot be reached at all** — registration only asks for a phone number,
so this is the common case rather than the exception. Anyone can add one to
their own account under **My account**, and an account without one is warned
there. Without the two variables the link is logged and delivered nowhere; the
server says so at startup, on every attempt, and now on the screen itself.

**Why not SMS.** Reaching an Indian mobile requires DLT registration under the
TRAI mandate: the sender ID and every message template must be registered with
a telecom operator, which takes days and needs a registered business entity.
WhatsApp's Cloud API needs Meta business verification. `src/lib/notifier.ts` is
an interface with one implementation, so adding either later is a class and one
branch — nothing that calls it changes.

## Still missing before real customers

- **Error monitoring.** Nothing reports a 500. Sentry's free tier is about ten
  lines.

---

## Troubleshooting

**The root URL returns JSON instead of the app.** `web/dist` was not built into
the image. Check the build log for the Vite step; if the frontend build failed,
the server falls back to API-only and the SPA routes 404.

**404 on refreshing `/billing`.** Same cause as above — the catch-all that
serves `index.html` only registers when `web/dist/index.html` exists.

**Logged out on every page load.** The refresh cookie is `Secure` in production,
so it needs HTTPS. Render provides that; if you are testing over plain HTTP
somewhere else, that is why.

**`prisma migrate deploy` fails on boot.** The container log names the migration
and the failing SQL. A database that already has tables from a manual `db push`
is the usual cause; a fresh Neon branch is the quickest fix while there is no
real data to lose.

**Deploy succeeds but the app shows an old version.** `index.html` is served
`no-store` and the hashed assets are immutable, so this should not happen — if
it does, it is a CDN or proxy in front of Render, not the app.
