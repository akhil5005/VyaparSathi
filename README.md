# Vyapar Sathi

*व्यापार साथी — "business companion"*

GST billing, inventory and ledger for a paper trading business in Punjab —
customers, products with reams↔kg conversion, purchases with input tax credit,
sales invoices with correct CGST/SGST/IGST, credit notes, payment allocation,
cheque tracking, and printing to both A4 and thermal. E-way bills are modelled
but not yet generated; see [Not built yet](#not-built-yet).

**Stack:** Node.js + Express + TypeScript · PostgreSQL + Prisma · React + Vite + Tailwind · Claude for voice billing.

Built for a real shop replacing a legacy desktop package, so the constraints are
the trade's own rather than invented: paper is bought from the mill by weight
and sold over the counter by the ream, invoice numbers must be gap-free within a
financial year because GST law says so, and a bill has to be in a customer's
hand in under a minute.

**Where to look first**

- [`web/src/pages/billing/`](web/src/pages/billing) — the counter screen. The
  browser computes no money at all; every figure comes from the same server code
  that produces the invoice, so the screen and the printed bill cannot disagree.
- [`src/modules/purchases/costing.ts`](src/modules/purchases/costing.ts) —
  moving-average cost, freight apportioned by value, GST excluded when the
  credit is reclaimable. 100 kg at ₹95 plus ₹500 freight becomes 42.76 reams at
  ₹233.86 landed.
- [`src/modules/invoices/numbering.ts`](src/modules/invoices/numbering.ts) —
  gap-free numbering under a row lock, with a concurrency test proving 20
  simultaneous allocations produce 20 distinct numbers.
- [Test coverage](#test-coverage) — including a table of deliberate sabotage
  used to check the tests actually catch what they claim to, and the real bugs
  that fell out of it.

It runs live on a single Render service that serves the API and the built web
app from one origin. Development is deliberately *not* arranged that way — Vite
on `:5173` calls the API on `:4000` with no dev proxy, so CORS and the refresh
cookie are exercised every day rather than discovered on deploy day. Both
layouts, and why the deployed one collapsed to a single origin, are in
[Cross-origin by design](#cross-origin-by-design).

---

## Why PostgreSQL and not MongoDB

Three things in this domain make a relational database the right call:

1. **Invoice numbers must be sequential and gap-free within a financial year.**
   That is a GST requirement, not a preference. It needs a locked row and a
   transaction — `SELECT … FOR UPDATE` on `NumberSequence`.
2. **One bill writes to four tables atomically** — invoice, line items, ledger
   entry, stock movement. If stock decrements but the ledger write fails, the
   books are wrong and nobody notices for a month.
3. **Every report is a join** — GSTR-1, party ledger, stock valuation, HSN
   summary, margin per bill.

---

## Getting started

Four terminals, or three if you already have Postgres.

```bash
# 0. Install both halves
npm install && npm run web:install

# 1. A database, with no Docker and no system install.
#    Real Postgres binaries, persistent between restarts. Leave it running.
npm run dev:db

# 2. Configure — .env is already generated with random JWT secrets.
#    dev:db prints the DATABASE_URL to paste in.
cat .env

# 3. Create the schema from the committed migration
npm run prisma:deploy

# 4. Run both halves
npm run dev            # API      http://localhost:4000
npm run web            # web app  http://localhost:5173

# 5. Open http://localhost:5173 and press "Register a new shop".
#    That one call creates the firm, the owner account, the unit master and the
#    invoice number sequences in a single transaction.

# 6. Seed the paper HSN codes at 18%
npm run db:seed

# 7. Optional: a sample product range, so the screens have something to work
#    with. Illustrative rates — replace them before billing anyone.
npm run db:seed:catalogue
```

> Registration validates the real GSTIN checksum — the form checks it as you
> type, and the server checks it again. Use the firm's actual GSTIN.

`prisma:deploy` applies the committed migration in `prisma/migrations/`, which is
what production runs. Use `prisma:migrate` only when *changing* the schema: it
generates a new migration from your edits and applies it.

### Scripts

| Command | Does |
|---|---|
| `npm run dev` | API with hot reload, `:4000` |
| `npm run web` | Web app with hot reload, `:5173` |
| `npm run dev:db` | A persistent embedded Postgres — no Docker, no install |
| `npm run dev:db -- --reset` | …and throw away the data first |
| `npm run web:build` | Production build of the web app into `web/dist/` |
| `npm test` | Unit tests — pure logic, no database, ~1s |
| `npm run test:integration` | Integration tests against a real Postgres (boots its own) |
| `npm run test:all` | Both |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run prisma:migrate` | Create + apply a migration |
| `npm run prisma:studio` | Browse the database |
| `npm run db:seed` | Seed the paper HSN codes at 18% |
| `npm run db:seed:catalogue` | Seed a 16-product sample range — **illustrative rates** |
| `npm run backup:restore -- <file> --owner-password "…"` | Put a backup back into an empty database |
| `npm run set-password -- --user <phone> --password "…"` | Last-resort password reset — the only recovery an owner has |
| `ITEST_PATTERN="src/modules/x/*.itest.ts" npm run test:integration` | Integration tests for one module only |

`npm run test:integration` needs **no setup** — `embedded-postgres` downloads
real Postgres binaries into `node_modules` and the harness boots a throwaway
cluster on port 55433, applies the migration, runs the tests and tears it down.
No Docker, no system install, no admin rights, and nothing left behind.

It runs `prisma migrate deploy`, not `db push`. That means every integration
test doubles as a check that the **committed migration** actually produces the
schema the code expects — a `db push` would build the schema straight from the
datamodel and pass happily even if the migration were broken or missing.

If a run is killed mid-flight the cluster can survive it, and Postgres will then
refuse to start over the same data directory ("pre-existing shared memory block
is still in use"). The data directory is keyed by port, so the escape hatch is
`ITEST_PG_PORT=55434 npm run test:integration` — an entirely independent
cluster, no need to hunt down the orphan first.

---

## What's built

### Database — `prisma/schema.prisma`

Complete. 27 models covering:

- **Tenancy & auth** — Business, User, Session, PasswordResetToken,
  VerificationToken, LoginAttempt, AuditLog
- **Masters** — Party (customer *and* supplier), PartyRate, PartyBalance, Unit,
  Product, **ProductUnit** (the reams↔kg bridge), HsnCode, **HsnTaxRate** (rate
  history), ProductStock
- **Sales** — SalesInvoice + items, NumberSequence
- **Purchases** — PurchaseInvoice + items, with ITC tracking
- **Corrections** — CreditDebitNote + items
- **Money** — Payment, PaymentAllocation, Cheque, LedgerEntry
- **Operations** — StockMovement, EwayBill, PrinterProfile

Five design rules the whole app depends on are documented at the top of the
schema file. The important ones:

- **Issued documents are immutable.** Returns and corrections go through credit
  notes. This is GST law and it is why `SalesInvoice` has no destructive update.
- **Tax is computed once, at issue, and stored per line and per header.** A
  reprint in 2029 must match the original rupee for rupee.
- **GST rates live on HSN with an effective-date range**, never as a column on
  the product — so a Council rate revision is one row, and old invoices keep
  printing the rate that applied on their date.
- **`ProductUnit.conversionToBase`** is snapshotted onto every invoice line. Paper
  is bought in kg from the mill and sold in reams; correcting a conversion factor
  later must not silently rewrite last year's stock.
- **Place of supply is derived from the GSTIN state code**, never picked from a
  dropdown. `src/lib/gstin.ts` validates the 15-char format *and* the mod-36
  checksum, so a typo is caught at entry rather than on a filed return.

### Auth — `src/modules/auth/`

Complete and typechecking.

- Argon2id password hashing (OWASP parameters), with transparent rehash on login
- JWT access token (15 min) + opaque refresh token (30 days), SHA-256 hashed at rest
- **Refresh token rotation with reuse detection** — presenting a retired token
  revokes the user's whole session tree
- `tokenVersion` on the user so password change, deactivation and
  "log out everywhere" take effect immediately instead of after 15 minutes
- Per-account lockout after N failed attempts, plus IP+identifier rate limiting
- Password reset that does not leak whether an account exists
- Login by email **or** phone (staff will use whichever they remember)
- Role-based access: `OWNER` / `MANAGER` / `BILLING_STAFF` / `ACCOUNTANT` / `VIEWER`
- Session listing and per-device revocation
- Append-only audit log on every sensitive action
- Refresh token in an httpOnly cookie for browsers; same token in the body for
  native clients

Endpoints under `/api/auth`: `register`, `login`, `refresh`, `logout`,
`logout-all`, `me`, `change-password`, `forgot-password`, `reset-password`,
`sessions`, `sessions/:id`, and `users` CRUD (owner only).

### Masters — `src/modules/masters/`

Complete. Parties, products, units and HSN codes, plus stock entry.

**The kg↔ream conversion configures itself.** A ream's weight is fully determined
by three facts already on the product:

```
weight (kg) = gsm × sheet area (m²) × sheets per ream ÷ 1000
```

Give a product `gsm: 75`, `sheetSize: "A4"`, `sheetsPerReam: 500` and it derives
2.3389 kg per ream, then creates the KG unit row at `1 kg = 0.4276 reams` and
makes kg the purchase default — because the mill bills in kg and the shop sells
in reams. `GET /products/:id/kg-conversion` shows the factor and the reasoning
before you commit to it. Sheet sizes accept `A4`, `B5`, `210x297mm`, `70x100cm`,
and bare `23x36`, which is read as **inches** — the Indian mill-size convention.

Other behaviour worth knowing:

- **Place of supply is derived from the party's GSTIN**, and a supplied state
  code that contradicts the GSTIN is rejected rather than silently preferred.
  Unregistered customers must give a state code explicitly.
- **Opening balances are write-once.** They seed `PartyBalance` *and* write an
  `OPENING_BALANCE` ledger entry, so the ledger reconciles from its first line.
  Changing one later would desync the ledger, so the update schema omits it —
  use an adjustment instead.
- **HSN rates are versioned, never edited.** Adding a revision closes the open
  row one millisecond earlier: no gap, no overlap. Deleting a rate that invoices
  were issued under is blocked.
- **Party rates are versioned the same way**, so an old invoice's price can
  still be explained.
- **Conversion factors are not retroactive.** Editing a product's paper spec
  recomputes its weight but deliberately leaves existing `ProductUnit` rows
  alone — invoices snapshot their own factor, and quietly changing a live
  conversion would make future stock disagree with history.
- **Stock adjustments require a reason.** An unexplained stock change is what
  makes a stock report untrustworthy six months later.
- **Billing staff can add a walk-in customer** mid-sale but cannot edit masters.

Endpoints under `/api/masters`: `units`, `hsn` (+ `/rates`), `parties`
(+ `/ledger`, `/rates`), `products` (+ `/units`, `/kg-conversion`,
`/opening-stock`, `/adjust-stock`, `/stock-history`).

### Sales invoicing — `src/modules/invoices/`

Complete. The one operation everything else hangs off.

Issuing an invoice does five things **in a single transaction** — if any of them
fails, none of them happened:

1. **Allocates the invoice number** from `NumberSequence` via an atomic
   `nextNumber + 1`, which takes a row lock held to commit. Two concurrent bills
   serialise instead of colliding, and a rollback returns the number to the pool
   — that is what keeps the sequence gap-free, which GST requires.
2. **Computes tax** — CGST+SGST or IGST, derived from the GSTIN state codes,
   never chosen by the user. Rates are looked up from `HsnTaxRate` *as at the
   invoice date*, so a backdated bill carries the rate that applied then.
3. **Decrements stock** in base units and writes a `StockMovement` with the
   balance after, using an atomic `decrement` so concurrent sales can't lose an
   update.
4. **Debits the party ledger** and updates the cached balance.
5. **Creates a pending e-way bill** when it's an interstate supply over the
   threshold, so it lands on a worklist instead of being forgotten.

Everything that can fail — unknown product, missing kg↔ream conversion, no GST
rate configured for the date — is resolved *before* the transaction opens and
before a number is consumed.

Other behaviour worth knowing:

- **Drafts** carry no number, move no stock and post no ledger entry. Issuing a
  draft re-runs the computation against current masters, so a rate corrected
  since the draft is picked up.
- **Cancelling** reverses stock and ledger with *contra* entries, never by
  deleting the originals, and does **not** release the invoice number. It is
  blocked once payments are allocated — a credit note is the right instrument
  then.
- **Negative stock warns, it does not block.** The shop bills before entering the
  purchase; refusing the sale would be worse than the warning.
- **`POST /preview`** runs the full computation and returns totals, HSN summary
  and warnings without writing anything. Both the invoice form and the voice
  confirmation card call it.
- **Cost and margin are stripped** from responses for `BILLING_STAFF`.
- **Freight** is treated as a non-taxable reimbursement. If freight must carry
  GST — the usual case when you arrange transport — add it as a line item
  against the transport HSN, which keeps the HSN summary on GSTR-1 correct.

Endpoints under `/api/sales-invoices`: `GET /`, `GET /next-number`,
`GET /:id`, `POST /preview`, `POST /`, `POST /:id/issue`, `POST /:id/cancel`.

Tax split, discounts, rounding, HSN grouping, amount-in-words (Indian
lakh/crore grouping) and the financial-year boundary are all covered by tests.

### Credit and debit notes — `src/modules/notes/`

Complete. The correct instrument for damaged reams, short supply and rate
corrections — invoices are immutable, so this is the only way to change what a
customer owes after the fact.

**Tax reverses at the original invoice's rate, never today's master.** Goods
sold at 12% are credited at 12% even if the slab has since been revised. The
rates come off the original invoice line, not from an HSN lookup — crediting the
new rate would leave tax reported that was never collected.

**Goods can't be credited twice.** A running ceiling per product per invoice
caps returns at what was actually invoiced, counting both earlier notes and
other lines in the same note. `GET /notes/creditable/:invoiceId` exposes the
remaining quantity so the UI can cap its input rather than failing on submit.

**Returns and rate corrections are different things**, and the distinction is
derived from the reason rather than left to whoever fills the form.
`SALES_RETURN`, `DAMAGED_GOODS`, `QUANTITY_SHORTAGE` and `PURCHASE_RETURN` move
goods; `RATE_DIFFERENCE`, `POST_SALE_DISCOUNT` and `CORRECTION` are money only —
they touch no stock and don't consume return quota.

Direction, using the schema's "positive balance = they owe us" convention:

| Note | Against | Effect | Stock |
|---|---|---|---|
| Credit note | Sales invoice | Customer owes less | Comes back in, at the cost it left at |
| Debit note | Sales invoice | Customer owes more (undercharge) | None |
| Debit note | Purchase invoice | We owe the mill less | Goes back out |

A credit note against a *purchase* is refused, pointing at the right
instrument: conventionally a supplier's credit note is recorded in your books as
a debit note against them, and keeping one canonical direction per side means
the ledger sign is never ambiguous.

**The GST summary now nets notes on both sides** — sales credit notes reduce
output tax, sales debit notes increase it, purchase returns reverse input
credit. The note totals are reported separately so the netting is auditable
rather than hidden.

Endpoints under `/api/notes`: `GET /`, `POST /preview`, `POST /`, `GET /:id`,
`POST /:id/cancel`, `GET /creditable/:invoiceId`.

### Purchases and input tax credit — `src/modules/purchases/`

Complete. This is the only thing that puts stock *in*, and the only thing that
reclaims the GST paid to suppliers.

**Stock comes in at landed cost, on a moving weighted average.** Freight is
apportioned across lines in proportion to value, with the rounding residual
pushed onto the largest line so the shares always add back to exactly the
charge. Two edge cases the textbook formula doesn't cover are handled: when
stock is negative (the shop bills before entering the purchase — normal here) the
incoming rate simply becomes the new average, because averaging against a
negative quantity produces nonsense.

**GST is excluded from cost when the credit is claimable** — you get that money
back, so counting it as cost would understate every margin. When the credit is
*not* available (blocked credit, unregistered supplier) the tax is a real cost
and is included. Getting this backwards is a common bookkeeping error.

**The supplier's rate wins over your master.** Their bill governs the credit you
can claim, so a per-line `gstRate` override is respected — but a difference from
the HSN master raises a warning, because it usually means one of the two is out
of date. Type the grand total off the paper bill as `supplierGrandTotal` and a
mismatch beyond ₹1 is flagged before it reaches a return.

**Duplicate bills are blocked.** The same supplier invoice number entered twice
is rejected by name — it's the most common data-entry error in purchases, and it
doubles both your stock and your credit claim.

**`GET /api/purchases/gst-summary?period=2026-07` is the payoff report**: output
tax from sales, input credit from purchases, and the set-off between them — which
is *not* a subtraction. IGST credit is used first (IGST → CGST → SGST), then CGST
credit covers CGST and any leftover IGST, then SGST likewise. **CGST credit can
never pay SGST, and vice versa** — which is why a business can hold unused credit
and still owe cash. It also surfaces eligible credit from earlier periods that
was never claimed, which is money left on the table.

The report is explicitly indicative. Reversals, blocked credits and
provisional-credit rules are not applied; the return the CA files is the
authority, and the response says so.

Endpoints under `/api/purchases`: `GET /`, `POST /preview`, `POST /`,
`GET /:id`, `POST /:id/cancel`, `GET /gst-summary`, `GET /itc/pending`,
`POST /itc/claim`, `POST /:id/unclaim-itc`, `GET /by-product/:productId`.

Note the access tier: purchases expose supplier pricing and landed cost, so
`BILLING_STAFF` is excluded from reading them entirely — unlike sales, where
they can bill but not see cost.

### Payments, allocation and cheques — `src/modules/payments/`

Complete. Closes the loop: you can now record that a customer paid.

**Allocation settles the oldest bill first** — what a shopkeeper means by "adjust
it against the old ones". A partial payment leaves the last touched invoice
partly paid rather than spreading thinly across everything. You can also
hand-pick which bills a payment clears, and anything left over sits **on
account** as an advance until the next invoice.

**The concurrency guard is the party balance row.** Every payment for a party
must update `PartyBalance`, so the transaction updates it *first* — that takes a
row lock held to commit. Two concurrent receipts for the same customer therefore
queue instead of both reading the same set of open bills and double-allocating
against them.

**Cheques post on receipt, not on clearance.** The ledger is written when the
cheque is taken, which matches how the trade accounts for it. Clearing is
therefore a no-op on the money; a **bounce reverses**: the invoices it settled
reopen, the party's balance goes back up, and any bank charge is added to what
they owe. If you'd rather not recognise a post-dated cheque until it's banked,
just don't record the payment until then — `chequeDate` keeps it on the due list
either way. `GET /cheques?dueBy=<date>` answers the Monday-morning question:
which cheques can I bank this week?

**Nothing is ever deleted.** Reversals and bounces keep the payment row with
`reversedAt` set and write a contra ledger entry. A payment that vanishes from
the books is exactly what an audit trail exists to prevent.

**`GET /api/payments/outstanding` is the udhaar report** — every customer who
owes money, bucketed 0–30 / 31–60 / 61–90 / 90+ days, ageing from the due date
when credit terms were given and from the invoice date otherwise.

Endpoints under `/api/payments`: `GET /`, `POST /`, `GET /:id`,
`POST /:id/allocate`, `DELETE /:id/allocations/:allocationId`,
`POST /:id/reverse`, `GET /outstanding`, and `cheques` with
`/deposit`, `/clear`, `/bounce`, `/cancel`.

### Printing — `src/modules/printing/`

Two documents, because the shop needs both: an A4 tax invoice the customer files
and the CA reads, and a thermal receipt for the counter.

**`invoicePdf.ts` — the A4 invoice.** Rendered with **pdfkit, not Puppeteer**.
Puppeteer means a ~200MB Chromium download and one to three seconds of browser
startup per document unless you keep one warm; pdfkit is a couple of megabytes
and renders in milliseconds. At a counter printing dozens of bills a day that is
the whole argument. The cost is that layout is code rather than CSS — a fair
trade for a document whose shape is fixed by statute.

Everything on it is a Rule 46 requirement: the words "Tax Invoice", both
parties' names, addresses and GSTINs, a unique serial number and date, HSN per
line, taxable value, the rate and amount of tax under each head, place of
supply, and a signature block. Unregistered customers print as "GSTIN:
Unregistered" rather than blank. Cancelled invoices carry a red CANCELLED mark
so a reprint can't be passed off as live. The three statutory copies — ORIGINAL
FOR RECIPIENT, DUPLICATE FOR TRANSPORTER, TRIPLICATE FOR SUPPLIER — are a query
parameter.

The line-item table has two column sets, because an intra-state invoice needs
two tax columns (CGST and SGST) and an inter-state one needs a single wider IGST
column. **The numeric columns are sized against measured Helvetica widths, not
eyeballed** — at 7.5pt a lakh-scale amount is 44pt wide, and a column narrower
than that wraps the figure onto a second line, which on a tax invoice reads as a
different number. A test measures the real glyph widths and fails if any column
is too narrow; it caught exactly this bug during development.

The rupee sign is a trap worth knowing about: **U+20B9 is not in WinAnsi**, which
is the encoding PDF's built-in Helvetica uses, so printing `₹` without an
embedded font yields a wrong glyph. Amounts default to `Rs.` and switch to `₹`
only when the caller supplies `unicodeFontPath` pointing at a TTF that has it.

**`escpos.ts` — the byte protocol.** Thermal printers don't take documents, they
take Epson ESC/POS command bytes. This is a dependency-free encoder for the
subset a receipt needs (`ESC @` reset, `ESC a` align, `ESC E` bold, `GS !` size,
`GS V` cut, `ESC p` cash drawer); the npm alternatives all pull in native
bindings that need rebuilding per platform, which is a poor trade for eighty
lines of byte pushing. Text is encoded **latin1, not utf8** — the printer decodes
each byte through its code page, so a multi-byte UTF-8 sequence prints as
mojibake.

**Printed documents are English.** Punjabi is how the shopkeeper talks to the
software — voice input — not what the software hands a customer or a CA, so
neither the PDF nor the receipt attempts Gurmukhi. That is a deliberate scope
line, and it is a good one: no ESC/POS code page contains the script, so a
Punjabi receipt would mean rasterising text to a bitmap and shipping it as
raster data, for a document nobody asked to be in Punjabi. Characters outside
latin1 print as `?` rather than silently mangling — a backstop for a stray
paste, not a feature.

**`receipt.ts` — the layout.** Deliberately split in two: `buildReceiptLines`
produces plain strings and `renderReceipt` wraps them in ESC/POS. Testing byte
buffers for layout mistakes is miserable; testing strings is not, and the same
strings drive the on-screen print preview. Product names wrap onto their own
line rather than truncating, which is the only layout that survives a 32-character
58mm roll without turning "JK Excel Bond Premium A4 75gsm" into "JK Excel B…".

**`printer.ts` — getting bytes to the device.** Only **NETWORK** printers can be
driven from the server: a printer on the shop LAN listens on TCP 9100 and prints
whatever you write to the socket — no driver, no spooler. USB, Bluetooth and
SYSTEM printers are attached to the *operator's* machine, not the server's, so
for those the API returns the ESC/POS buffer as base64 and the browser sends it
via WebUSB or Web Bluetooth. That keeps byte generation (the hard part, and the
part worth testing) on the server and the last hop where the device actually is.
A successful socket write means "the printer accepted the job", never "the
customer has a receipt" — a thermal printer never replies.

Printer profiles enforce two invariants: exactly one default, and never zero
usable printers. The first printer configured becomes the default whatever the
caller asked for, deleting the default promotes another, and disabling the only
one is refused — otherwise every print fails with "no default configured" at the
worst possible moment.

Endpoints under `/api/printing`: `GET /invoices/:id/pdf` (with `?copy=`,
`?download=1`, `?preview=1`), `GET /invoices/:id/receipt` (lines + base64
ESC/POS, for preview or client-side sending), `POST /invoices/:id/receipt`
(actually send it), and `GET|POST|PATCH|DELETE /printers` plus
`POST /printers/:id/test`.

### GST returns — `src/modules/gstr1/`

GSTR-1 for a month, in the shape the GST portal's offline utility accepts, plus
a plain-language summary of the same month to check first. It is a **working
paper for the CA**: nothing here talks to the portal and nothing is marked as
filed.

The file the portal wants is unreadable by design — `inum`, `txval`, `camt`, no
recognisable invoice, amounts as bare floats — so nobody can eyeball it for a
missing bill. Hence two endpoints: `GET /api/gstr1/summary` returns counts,
totals and warnings for the screen, and `GET /api/gstr1/download` returns the
payload as a file.

The classification is the part that is legally wrong if it is wrong:

| Supply | Section | Reported |
|---|---|---|
| Counterparty has a GSTIN | B2B | Invoice by invoice, grouped by their GSTIN |
| Unregistered, inter-state, over ₹1,00,000 | B2CL | Invoice by invoice, grouped by state |
| Everything else | B2CS | Totals per state per rate only |

Cancelled invoices are excluded from every section — no supply took place — but
still counted in `doc_issue`, because their number *was* issued and the portal
checks the declared range against the count. A note against a purchase is the
supplier's outward supply and never appears. A credit note against a small B2C
sale is negated and netted into the B2CS totals rather than reported on its own,
which is why a B2CS row can legitimately come out negative in a month of heavy
returns.

Money stays a `Decimal` throughout. The portal JSON is the only place in this
codebase a rupee becomes a float, and it happens at the last step.

Split into a pure builder (`gstr1.build.ts`, no database, no clock) and a
service that queries, so every classification rule is unit-testable — and is
tested, boundary by boundary.

### Backups — `src/modules/backup/`

The books *are* the business. A disk dies, a laptop is stolen, a free database
tier is reclaimed, and years of ledger go with it.

`GET /api/backup/download` (owner only) returns one JSON file with every
customer, product, invoice, payment and ledger entry for the shop.
`GET /api/backup/summary` returns the counts, shown on screen *before* the
download — the classic backup failure is discovering on the day you need it that
the file was empty all along.

Deliberately **not** in the file: password hashes, TOTP secrets, sessions,
refresh tokens, reset tokens. It ends up in a Downloads folder and gets emailed
around; a backup that leaks logins is worse than no backup. Restoring therefore
sets a fresh owner password, and other staff come back needing one set from
Settings → Staff.

Putting it back is a command rather than a button, because it is not an
operation to make easy:

```bash
DATABASE_URL="postgresql://…" \
  npm run backup:restore -- ./backup.json --owner-password "a new password"
```

It refuses two things: restoring over a business already in the database
(merging a snapshot into live books duplicates invoice numbers and breaks the
ledger), and restoring without a new owner password. Worth running once against
a scratch database while nothing depends on it — a backup you have never
restored is a hope, not a backup. The round trip is covered by an integration
test that exports a shop with invoices, notes, payments and a ledger, wipes the
database, restores from the file alone and checks the balances, stock, average
cost and invoice numbering all still reconcile.

It is a data export, not a point-in-time snapshot: rows are read across several
queries, so a bill issued mid-export could land half in. Take it when the
counter is quiet. `pg_dump` remains the better disaster-recovery tool where a
shell and a connection string are available.

### The HTTP layer — `src/app.ts`

Every module above is mounted under `/api`, behind `helmet`, CORS with
credentials (the refresh cookie needs it), a 2MB JSON body cap and
`trust proxy: 1` — without that last one `req.ip` is the reverse proxy's address
and one rate limiter throttles the entire shop at once.

**Rate limiters are built per app, not shared.** They keep their counters in
memory, so a module-level singleton is global to the process: fine in production
where there is one app, but it means a test that deliberately trips a limit
leaves it tripped for everything afterwards. `createApp({ enableRateLimit })`
builds a fresh set, and the limits themselves are still proven by a test that
builds an app with them switched on and watches the sixth registration get a 429.

**Error shapes are part of the API.** Everything comes back as
`{ error: { code, message } }` — `VALIDATION_ERROR` carries a `fields` array so
a form can highlight the offending input, unique-constraint violations become
409 `CONFLICT` rather than a 500, and a malformed request body is 400
`INVALID_BODY`. That last one was a real bug found by these tests: body-parser
throws before any route runs, and untagged it landed in the 500 branch, which
outside production answers with a stack trace.

### The web app — `web/`

React 19 + Vite + Tailwind v4, TanStack Query for server state, React Router for
routing. **Not Next.js**, despite an earlier plan: every screen sits behind a
login and reads from an API that already exists, so server rendering would go
unused while costing a second Node process to keep alive.

```
web/
  .env.development          VITE_API_URL=http://localhost:4000  (committed)
  .env.production.example   the deployed API URL goes here at build time
  vite.config.ts            no dev proxy — see below
  src/
    main.tsx                mounts <App/>
    App.tsx                 router, QueryClient, route guards
    index.css               Tailwind v4 theme (configured in CSS, not JS)

    lib/
      api.ts                the only thing that talks to the API
      types.ts              response shapes; money is `string`, never `number`
      money.ts              Indian digit grouping, done on strings
      gstin.ts              checksum validation, mirrored from the server

    auth/
      AuthProvider.tsx      access token in memory, refresh cookie for the rest
      AuthShell.tsx         frame for the signed-out screens
      LoginPage.tsx
      SignupPage.tsx        two-step: shop details, then owner account
      ForgotPasswordPage.tsx
      ResetPasswordPage.tsx
      RequireAuth.tsx       route guards, incl. RequireRole

    components/
      Layout.tsx            sidebar, nav filtered by role
      Button.tsx  Field.tsx  Alert.tsx  Spinner.tsx

    pages/
      DashboardPage.tsx     outstanding, recent bills, low stock
      PlaceholderPage.tsx   honest stub for the screens not yet built
      billing/
        BillingPage.tsx        the counter screen
        useBillingDraft.ts     the bill being typed — intent only, no money
        LineItemsTable.tsx     editable columns + server-priced columns
        TotalsPanel.tsx        totals, straight from the preview endpoint
        IssuedInvoiceDialog.tsx  number, total, and the PDF
        NewCustomerDialog.tsx    add a walk-in without leaving the bill
      account/
        AccountPage.tsx        change your own password — every role, not just owners
      returns/
        Gstr1Page.tsx          the month's GSTR-1, checked before it is downloaded
        periods.ts             which months to offer; defaults to the one being filed
      payments/
        PaymentsPage.tsx       ageing summary + three tabs
        OutstandingTable.tsx   the udhaar list, worst debtor first
        RecordPaymentDialog.tsx  cash / UPI / cheque / transfer
        PaymentList.tsx        what came in; reversals shown, not hidden
        ChequeList.tsx         deposit, clear, bounce
      products/
        ProductsPage.tsx       a stock report first, a catalogue second
        NewProductDialog.tsx   paper spec with a live ream-weight preview
        ProductDetailDialog.tsx  stats, units, and the movement ledger
        AdjustStockDialog.tsx  asks what you counted, not the delta
        paperWeight.ts         gsm × area × sheets, mirrored for preview only
      purchases/
        PurchasesPage.tsx      supplier bills + unclaimed input credit
        NewPurchaseDialog.tsx  typed as printed, priced by the server
        PurchaseLinesTable.tsx the kg→ream conversion and landed cost
        usePurchaseDraft.ts    intent only; each line carries its own unit
      invoices/
        InvoicesPage.tsx       look one up afterwards; filter, search, reprint
        InvoiceDetailDialog.tsx  read-only by design
        CancelInvoiceDialog.tsx  spells out exactly what will move
      notes/
        NotesPage.tsx          credit notes raised, and why
        NewCreditNoteDialog.tsx  capped at what is still creditable
        reasons.ts             each reason says whether stock moves
      parties/
        PartiesPage.tsx        customers and suppliers in one book
        PartyDetailDialog.tsx  the account, line by line
        NewPartyDialog.tsx     full record incl. credit terms
        balance.ts             turns a signed balance into a direction
```

**Customers and suppliers share one screen** because they share one ledger: the
same firm can buy paper from you on Monday and sell you board on Friday, and
its position is a single running figure either way.

The detail worth naming is `balance.ts`. The server signs balances from the
shop's point of view — positive means they owe us, negative means we owe them —
and rendering that raw puts **"−₹11,710"** on screen, which reads as a mistake
rather than as money payable to a mill. So the sign becomes words and the number
is always shown unsigned: *"₹11,710.00 — you owe"* against *"₹4,022.00 — owes
you"*, in different colours. Inside the ledger the same signal becomes **Dr/Cr**,
which is the notation of the paper bahi khata this replaces.

Two bugs found by opening a real account, both the same shape as earlier ones —
a claim about the server that was never checked:

- The voucher map used `PAYMENT_RECEIPT`, the name in `DocumentType`. The ledger
  writes `RECEIPT`, so every payment line rendered as a raw shouty constant.
- **The running balance read out of sequence** — 0 → 2,832 → 1,832 → 1,032. The
  server orders by `entryDate`, which is right for a ledger, but an invoice's
  entryDate carries a time while a payment's is midnight (it comes from a date
  input), so on a day with both, the payment sorts ahead of the sale that caused
  it. `runningBalance` is computed at insert time, so the rows are now sorted by
  `createdAt` — the only order in which that column is coherent. The proper fix
  is to order by `createdAt` server-side too; until then this reorders within a
  page rather than across a long account.

**Invoices is read-only, deliberately.** An issued invoice carries a number that
has gone to a customer and been reported to the government; an edit button would
silently rewrite history. The only destructive action is cancellation, and the
dialog for it names the consequences in concrete terms — *"10 Ream of stock goes
back on the shelf"*, *"₹2,832.00 comes off Sharma Stationery's account"*,
*"invoice number INV/0001 stays used — it is never reissued"* — because the
person doing it is usually in a hurry. If money has already been received it
says so in red, and it points at credit notes as the usually-correct instrument:
cancel when the bill should never have existed, credit-note when goods came back.

One detail worth noting from verification: the margin shown on an invoice uses
the cost **snapshotted at the moment of sale**, not today's average. INV/0001
shows a ₹400 margin against a ₹200 cost even though a later purchase moved the
running average to ₹211.16. Historical margin must not drift when new stock is
bought, and it doesn't.

**Purchases is where the domain earns its keep.** A supplier bill is entered
exactly as printed — the mill's own number, its quantities, its units — and the
server does the rest. Verified end to end: 100 kg at ₹95 with ₹500 freight
becomes **42.76 reams at ₹233.86 landed**, and saving it moved stock 87 → 129.76
with the average cost blending 200 → **₹211.16**.

Two things that number quietly gets right. The freight is *in* it, apportioned
across the lines by value rather than expensed separately, because it is part of
what the goods cost. The ₹1,710 of GST is *out* of it — the bill totalled
₹11,710 but only ₹10,000 reached stock value, because reclaimable tax is not a
cost. Get either wrong and every margin downstream is wrong with it.

The screen also asks for the total printed on the supplier's bill. Optional, but
the server compares and flags a mismatch there and then — far better than the
difference surfacing months later in a GSTR-2B reconciliation.

**Products** leads with what is on the shelf rather than the catalogue, because
that is the question being asked. Two decisions worth naming:

*Adjusting stock asks for the counted figure, not the difference.* The API takes
a signed delta, which is right for an append-only ledger and wrong for someone
standing at a shelf who has just counted 87 and does not want to work out that
87 − 90 is −3. The dialog does that subtraction and shows the result before
anything is sent. A reason is mandatory — an adjustment is the one stock
movement with no document behind it, so the note is the only record of why the
number moved.

*The ream-weight formula is mirrored from the server into `paperWeight.ts`, for
preview only.* The server derives and stores the real figure; this copy exists
so a mistyped gsm is caught while the cursor is still in the box, rather than
becoming a conversion factor that quietly misprices every kilogram purchased
from the mill thereafter.

**Payments** answers the question three ways, because it gets asked three ways:
*who owes me* (the udhaar report, sorted by amount rather than name — the
question is "who do I chase today"), *what came in* (reversed payments stay on
the list struck through; a reversal is not a deletion and the voucher may be on
a receipt in someone's pocket), and *which cheques can I bank* (a cheque is
routinely written weeks ahead, so Deposit stays disabled until the server says
`bankable`).

Recording a payment deliberately does **not** ask which bills to settle. The
server applies it oldest-first, which is what a shop does anyway and what keeps
the ageing honest; the remainder sits on account. Hand-picking bills exists in
the API and belongs on a payment's own screen, not in a two-second interaction
at a counter.

**The billing screen is where the design decisions show.** Two rules govern it:

*The browser computes no money.* Every figure — the tax split, the discount, the
round-off, the total — comes from `POST /api/sales-invoices/preview`, which is
the same code path that produces the real invoice. A total calculated in the
browser could disagree with the printed bill, and the printed bill is the legal
document. `useBillingDraft` therefore holds *intent* only: which product, how
many, at what rate. It has no idea what anything costs.

*It is driven from the keyboard.* Choosing a customer moves focus to the product
box; choosing a product moves focus to its quantity; <kbd>F2</kbd>,
<kbd>F3</kbd> and <kbd>F9</kbd> jump to customer, item and save. At a counter
the mouse is on the desk, not in anyone's hand.

**Four bugs in this screen were found only by driving a real browser**, none of
which a build or a type error would have caught:

| Bug | Why it mattered |
|---|---|
| The server's warnings are `{ code, message }` objects; the frontend type said `string[]` and rendered them directly | React threw, unmounting the whole page. `PARTY_UNREGISTERED` fires for any customer without a GSTIN, so **the billing screen went blank on the first realistic bill** |
| Totals kept showing the last bill after issuing | `placeholderData` survives the query being disabled. An empty form sat next to ₹2,832 — a good way to charge one customer for the previous customer's goods |
| Enter straight after typing opened "add new customer" | The search had not returned, so `items` was empty and the highlighted index 0 *was* the create row. "Type a name, hit Enter" is the natural motion at a counter, so this meant duplicate customers all day |
| Hover moved the keyboard highlight onto "add new" | After clicking the search box the pointer sits exactly where the dropdown opens, so Enter offered to create a customer visible in the list |
| The dashboard read `grandTotal.older`, which the API does not send | "Overdue past 90 days" would have shown ₹0.00 for ever — the real field is `over90`. Same root cause as the warnings bug: a hand-written type is a *claim* about someone else's code, and `undefined` formats to ₹0.00 without complaint |

The last row is why the payment types were transcribed from live responses
rather than guessed. It is worth doing that for every endpoint before writing
the screen — a wrong type compiles perfectly and then either crashes or, worse,
quietly reports zero.

The last two are why the combobox now refuses to create anything on Enter unless
the operator arrowed onto that row deliberately, falls back to the top match if
they did not, and shows "Searching…" rather than an empty list while a query is
in flight. Creating a record is destructive-adjacent; it should take intent.

A render crash can no longer blank the app either — an `ErrorBoundary` wraps the
routed content, scoped inside the layout so the navigation survives and the
operator can walk away from a broken screen.

Smaller things that matter more than they look:

- Quantity and rate are `type="text"` with `inputMode="decimal"`, **not**
  `type="number"` — a number input discards intermediate states like `10.` and
  can be changed by a stray scroll wheel over a focused field. On a rate column
  that is a mispriced invoice nobody notices.
- The PDF is fetched as a blob, not opened with `window.open`. A plain
  navigation cannot carry the `Authorization` header, so it would arrive
  unauthenticated and 401.
- A new customer's **state code** is asked for explicitly when there is no
  GSTIN to read it from, because that single field decides CGST+SGST versus
  IGST on every bill they are ever given.

**Money is typed as `string` throughout.** The API sends every NUMERIC column as
a string because Postgres decimals do not survive a JavaScript `number`, and an
invoice out by a paisa is a filing problem. Typing them as `string` is what
stops someone writing `a + b` and shipping a rounding bug — the browser performs
no money arithmetic at all. Even `formatIndian` groups digits by manipulating
the string, so a value never passes through a float on its way to the screen.

**The access token lives in a module variable, never `localStorage`.** Anything
in `localStorage` is readable by any XSS payload. What survives a page reload is
the httpOnly refresh cookie, which JavaScript cannot read at all; the app spends
one round trip on mount exchanging it for a fresh access token. A 401 mid-session
triggers a single refresh-and-retry — *single* because concurrent refreshes look
exactly like a stolen token being replayed, and the API revokes the whole session
tree when it sees one.

### Cross-origin by design

In development the app and the API are separate origins — Vite on `:5173`
calling `:4000` — and **there is deliberately no dev proxy.** Proxying `/api`
would make development same-origin and hide every CORS and cookie problem until
deploy day.

Deployment collapsed that to a single origin, and the reason is worth writing
down. Two subdomains of one registrable domain are cross-*origin* but
same-*site*, so the refresh cookie stays `SameSite=Lax` and never becomes a
third-party cookie. Splitting across unrelated hosts (`x.onrender.com` +
`y.pages.dev`) is cross-*site*, which forces `SameSite=None` — blocked by
default in Safari, so login would work on a laptop and fail on an iPhone. With
no domain of its own to put both halves under, the only correct option left was
to serve them from one process: `express.static` over `web/dist` plus an SPA
rewrite that excludes `/api`, in `src/app.ts`.

So CORS still has to be right — it is what development runs on, and what a
two-subdomain deployment would need the day a domain is bought. Three things it
needed beyond `app.use(cors())`:

- **`credentials: true`**, or the browser silently drops the refresh cookie and
  staying signed in stops working.
- **An origin function, not a list.** A rejected origin gets *no* CORS header
  rather than an error, so the browser blocks it and non-browser clients
  (health checks, curl) still work. Never `*` — a wildcard is invalid alongside
  credentials and the browser rejects the response.
- **`crossOriginResourcePolicy: 'cross-origin'`.** helmet defaults this to
  `same-origin`, which is right for a website and wrong for an API meant to be
  read from another origin. JSON survives either way since CORS governs `fetch`,
  but opening an invoice PDF in a new tab is a no-cors navigation that
  `same-origin` blocks.

### Reading a bill from a photograph — `src/modules/ai/`

Point a phone at a supplier's invoice and the purchase form comes back filled
in. Entering purchases is the slowest job in the shop and the one whose mistakes
travel furthest — a supplier bill sets the moving-average cost, so a wrong rate
quietly corrupts every margin afterwards — and it is the one task always done
with the paper still in your hand, which makes checking the result free.

Three rules hold it together, and the code enforces each:

- **Nothing is written.** The scan returns a draft that lands in the ordinary
  purchase form, which calls the ordinary service.
- **The model reads; it does not compute.** It reports what is printed. Tax,
  landed cost and totals are recomputed server-side from what the operator
  confirms.
- **The model never invents a party or a product.** Names come back as printed;
  matching them to records is deterministic in
  [`match.ts`](src/modules/ai/match.ts) — Sørensen–Dice over bigrams plus token
  containment, which copes with `M/S J.K. PAPER MILLS LTD.` against
  `JK Paper Mills` — and an uncertain match is offered as a choice, never
  applied. A GSTIN printed on the bill outranks any name score, because it is an
  identifier rather than a resemblance.

Photos are downscaled to 1600px in the browser before upload: printed invoice
text stays legible well below sensor resolution, the upload survives a shop
connection, and the full-size file never leaves the phone.

### Asking the shop a question — `src/modules/voice/`

"Sharma Stationery nu kinna paisa dena hai?" — spoken into the phone, or typed,
answered from the ledger. Read-only, deliberately: it is useful immediately, it
shows how the speech engine copes with how this shop actually talks, and it
cannot damage anything while that is being found out.

The pipeline puts as little as possible in the model's hands.
[`punjabiNumbers.ts`](src/modules/voice/punjabiNumbers.ts) turns `sarhe teen`
into 3.5 and `sava do sau` into 225 before anything else looks at the sentence —
a closed grammar, so a parser is right every time where a model is right most of
the time. `match.ts` then narrows a few hundred names to a shortlist of four.
Only then does Claude see the utterance, and its whole job is to pick an intent
and an id from that list.

Two further rules make the answers trustworthy:

- **The model never states a figure.** Every amount, quantity and date in the
  reply is composed by [`voiceQuery.service.ts`](src/modules/voice/voiceQuery.service.ts)
  from the database. A confidently wrong balance read out at a counter is worse
  than no feature.
- **Ids are checked against the shortlist.** Anything else the model returns is
  discarded, so a hallucinated cuid never reaches a `where` clause. One
  integration test runs every intent and asserts that no row, balance, stock
  figure or number sequence moved.

Balances are answered in words rather than signs — "you owe JK Mills ₹8,000"
rather than a minus — because a minus sign is inaudible and this is a feature
you use while looking at a customer. Cost figures are withheld from staff who
are not shown them elsewhere either.

Speech goes through Sarvam's Saarika (`pa-IN`) with Whisper behind it; without a
speech key the same questions can still be typed, and without an Anthropic key
the Ask button does not appear at all.

Full AI architecture and the Claude call shape: **[docs/AI_STACK.md](docs/AI_STACK.md)**.

---

## Not built yet

Every screen is built. The web app covers the whole trading cycle —
**purchases** (buy from the mill, set the cost), **products &amp; stock**,
**billing**, **invoices** (look one up, reprint, cancel), **credit notes**
(returns and corrections), **payments** (collect, chase udhaar, bank cheques),
**customers &amp; suppliers** with their ledgers, and **settings** — plus
authentication and the dashboard.

It is **deployed** — one Render service serving both halves from a single
origin, which is what makes the refresh cookie first-party without a domain of
its own. Step by step in **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.
GSTR-1 export and backups are built; what remains:

1. **Off-site backups on a schedule.** Taking one is a button and restoring it
   is a tested command, but somebody still has to press the button. That matters
   more than it sounds: the managed database's free tier keeps a six-hour
   restore window, so a mistake noticed the next morning is already past it and
   a downloaded copy is the only way back. A nightly job writing to object
   storage is the honest version.
2. **Voice billing.** Reading a bill from a photograph and asking read-only
   questions are both built; making a bill by voice is not. The confirmation
   card would call `POST /api/sales-invoices/preview`, which already exists.
   Worth building only once the query path is reliably understanding real
   speech — which is the point of shipping the read-only half first.
3. **E-way bill** generation against the NIC portal via a GSP. Requires a
   commercial GSP account before it can be verified against anything real.
4. **Freight is added after tax.** On a composite supply of goods, freight
   normally takes the rate of the goods it carries. Changing it would not touch
   bills already issued, so GSTR-1 raises a warning naming the invoices rather
   than quietly adjusting a legal document after the fact.

## Test coverage

**559 tests, all green** — 331 unit + 228 integration.

### Unit (`npm test`) — pure logic, no database

| Area | What's pinned |
|---|---|
| GST | CGST/SGST vs IGST split, discounts, round-off both directions, HSN grouping |
| Set-off | IGST-first ordering, the CGST↮SGST wall, cess ring-fencing, money conservation |
| Costing | Moving average incl. negative stock, freight apportionment with no lost paise, ITC-in-or-out-of-cost |
| Allocation | FIFO order, partial payments, on-account remainder, over-allocation guards |
| Ageing | Bucket boundaries, ageing from due date vs invoice date |
| Paper | gsm × area × sheets → ream weight, kg↔ream factor, sheet-size parsing |
| Punjabi | `sarhe teen` → 3.5, `sava do sau` → 225, Gurmukhi script |
| Name matching | `M/S J.K. PAPER MILLS LTD.` resolves to `JK Paper Mills`; `75gsm` matches `75 GSM` while `A4` stays intact; two near-identical names get a candidate list, not a confident pick |
| Spoken periods | Week starts Monday (and Sunday belongs to the week it ends); last month ends on its own last day in February; "this year" is the financial year |
| Voice guard | An id the model was never offered is discarded; an unknown intent falls back to UNKNOWN; a malformed confidence reads as zero, not as certainty |
| Formatting | Indian lakh/crore amount-in-words, financial-year boundary |
| Print format | Indian digit grouping (12,34,567.89 not 1,234,567.89), word wrap, fixed-width columns flush to the roll edge |
| ESC/POS | Every command's exact bytes, latin1 not utf8 encoding, feed-before-cut, drawer kicked once per job not once per copy |
| Receipt | Never exceeds 32 or 48 chars, CGST/SGST vs IGST by supply type, zero charges omitted, long names wrap not truncate |
| Invoice PDF | Column widths measured against real Helvetica glyphs; every layout branch (draft, cancelled, B2C, all optional totals, 60-line pagination, missing font) produces a structurally valid PDF |
| Transport | Bytes delivered verbatim over a real TCP socket; unreachable printers time out instead of hanging; USB/Bluetooth handed back to the client |

### Integration (`npm run test:integration`) — real Postgres

These exist for the things a unit test physically cannot prove: that the
transactions are atomic and that the row locks actually serialise.

| Area | What's pinned |
|---|---|
| Numbering | Sequential and gap-free; **20 concurrent allocations produce 20 distinct numbers**; a rollback returns the number to the pool; series isolated per document type, per financial year, per business |
| Sales invoice | Issue writes invoice + stock + ledger + balance together; a mid-transaction failure leaves **nothing** behind; 10 concurrent invoices lose no stock; cancel reverses with contra entries and keeps the number; drafts touch nothing |
| Purchases | Moving average blends across receipts; freight lands in cost but claimable GST does not; kg→ream conversion; negative stock takes the incoming rate; **5 concurrent receipts of one product don't lose an average update**; duplicate supplier bills rejected |
| Payments | FIFO settles oldest-first; overpayment sits on account; **6 concurrent receipts never over-allocate an invoice**; reversal reopens bills without deleting the payment |
| Cheques | Posted on receipt; clearing doesn't double-count; a bounce reopens the bill and adds bank charges; illegal status transitions refused |
| Notes | **Tax credited at the original rate after the HSN rate changes**; the same goods can't be credited twice, across notes *or* within one; money-only notes don't consume return quota; purchase returns push stock back out; cancelling frees the quantity again |
| ITC | Output tax netted against input credit *and* against notes on both sides; double-claiming refused; ineligible bills excluded |
| Scanned bills | A supplier matched through decoration the database does not have; a printed GSTIN beating any name score; near-identical names refused confidence; a customer never matched as the supplier; an unmatched line flagged rather than dropped; a line with no quantity or rate left blank, since those set the cost |
| Voice questions | A balance said the right way round — "you owe" rather than a minus sign; an unsure match offering choices instead of a figure; the last rate actually charged, scoped to the party who asked; cost figures withheld from staff who may not see them; **every intent run in turn leaves no row, balance, stock figure or number sequence changed** |
| Printing | A real invoice row renders to a valid PDF on both column layouts; the print counter moves on print and not on preview; receipts take their width from the default profile; **a real TCP listener receives the invoice number on the wire**; a failed send doesn't count as a print; one default printer always, never zero |
| HTTP | **A whole shop day over real HTTP** — register, sign in, set up masters, bill, take a payment, download the PDF; refresh-token rotation and reuse revoking the session; login enumeration-safe; role gates; **cross-tenant reads *and* writes rejected**; error shapes; `Content-Type`/`Content-Disposition`/`Cache-Control` on the PDF; helmet headers; the registration limiter 429ing on the sixth attempt |
| CORS | Preflight answered with the specific origin and `Allow-Credentials`; an unconfigured origin gets no allow header at all; a request with no `Origin` still served; **never a wildcard**, which would void the credentials; `Cross-Origin-Resource-Policy: cross-origin` so a PDF can open in a new tab |
| Auth exposure | The user object is asserted field-by-field against an **exact allowlist** on register, login and `/me` — not just "does it contain passwordHash", which is why `tokenVersion`, `failedLoginCount` and `lockedUntil` were reaching the browser unnoticed |

**The tests were verified to have teeth**, by breaking the thing each one
guards and confirming it fails:

| Sabotage | Caught by |
|---|---|
| Remove the party-balance row lock from `recordPayment` | the over-allocation test, plus 7 others |
| Narrow the inter-state total column back to 25pt | the column-width test |
| Make `authorize()` always allow | all 3 role-gate tests |
| Drop `businessId` from the `getParty` filter | the cross-tenant read test |
| Drop `businessId` from the `updateParty` filter | the cross-tenant write test |
| Allow any origin in the CORS callback | the unconfigured-origin test |
| Touch `PartyBalance.lastEntryAt` while answering a spoken balance question | the "writes absolutely nothing" test |

That last row is the reason this table exists. The first attempt at the
cross-tenant check only covered *reads*, so removing the tenant filter from
`updateParty` changed nothing and every test still passed. The gap was invisible
until the mutation was tried. Cross-tenant writes are now covered separately —
update, cancel, bill-against-another-firm's-customer, and print.

**Six real bugs were found this way:** the inter-state amount column was too
narrow to hold a rupee figure without wrapping; `input.isDefault ?? existingCount === 0`
honoured an explicit `false` and left a shop with a printer but no default;
`z.coerce.boolean()` turned `?preview=false` into `true`, so a preview
incremented the print count; a malformed request body returned 500 with a stack
trace instead of 400; helmet's default `Cross-Origin-Resource-Policy` would have
blocked the invoice PDF from opening; and `sanitizeUser` was a **denylist** that
stripped three known secrets and passed everything else through — so
`tokenVersion`, `failedLoginCount` and `lockedUntil` were being sent to the
browser, and any new column on the User model would have joined them silently.
It is an allowlist now.

---

## Before real invoices go out

- [x] **GST rate confirmed: 18% on every product.** Seeded in `prisma/seed.ts`
      (9% CGST + 9% SGST within Punjab, 18% IGST outside). Note the test
      fixtures deliberately use 12% instead — if a test only passes at 18%, the
      rate has been hardcoded somewhere it should be read from `HsnTaxRate`.
- [ ] Confirm the invoice number format the CA wants (`INV/0001/26-27` is the default).
- [ ] Enter opening balances for every party as at the switchover date.
- [ ] Enter opening stock per product with its cost.
- [ ] Replace the dev-only reset-link logging in `auth.controller.ts` with real
      SMS/WhatsApp delivery.

---

## Licence

[MIT](LICENSE) — © 2026 Akhil Mittal.

The invented product rates in `prisma/seed-catalogue.ts` are sample data, not a
real price list. Anyone adapting this for their own shop should replace them and
confirm the GST rate for each HSN with their accountant before issuing an
invoice.
