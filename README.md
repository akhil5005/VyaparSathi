# Vyapar Sathi

*व्यापार साथी — "business companion"*

GST billing, inventory and ledger software for a paper trading business in
Punjab. Built to replace a legacy desktop package my father's shop had outgrown,
so every constraint in it is the trade's own rather than one I invented.

**Live:** https://vyapar-sathi-y7bg.onrender.com · **Stack:** TypeScript ·
Node + Express · PostgreSQL + Prisma · React + Vite + Tailwind · Claude for the
AI features

> The live instance is a demo on a free tier — it sleeps after 15 minutes idle,
> so the first request takes about a minute to wake it.

---

## Why this domain is interesting to build for

Three constraints shape almost every design decision in the codebase.

**Invoice numbers must be sequential and gap-free within a financial year.**
That is GST law, not a preference. It rules out generating a number optimistically
and rules out most eventual-consistency designs — you need a locked row inside
the same transaction that writes the invoice.

**One bill touches four tables at once** — invoice, line items, ledger entry,
stock movement. If stock decrements and the ledger write fails, the books are
silently wrong and nobody notices until the accountant does, a month later.

**Paper is bought by weight and sold by the ream.** The mill bills 100 kg; the
counter sells 12 reams. The same product has to be two units at once, and the
conversion depends on the paper's own specification.

Those three are why this is Postgres and not a document store: a locked
sequence row, multi-table transactions, and reports that are all joins.

---

## Running it

```bash
npm install && npm run web:install

npm run dev:db          # real Postgres binaries — no Docker, no system install.
                        # Prints the DATABASE_URL for .env. Leave it running.
npm run prisma:deploy   # schema from the committed migration

npm run dev             # API      http://localhost:4000
npm run web             # web app  http://localhost:5173   (second terminal)
```

Open `http://localhost:5173` and press **Register a new shop** — one call creates
the firm, the owner account, the unit master and the invoice number sequences in
a single transaction. It validates the real GSTIN checksum, so use the firm's
actual number. Then `npm run db:seed` for the paper HSN codes at 18%.

| Command | |
|---|---|
| `npm test` | Unit tests — pure logic, no database |
| `npm run test:integration` | Integration tests against real Postgres |
| `npm run typecheck` | Both halves |
| `npm run backup:restore -- <file> --owner-password "…"` | Restore a backup into an empty database |
| `npm run set-password -- --user <phone> --password "…"` | Last-resort password reset |

Deployment is one Render service serving the API and the built web app from a
single origin — details and reasoning in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

---

## What's in it

| Module | Does |
|---|---|
| `src/modules/auth` | Registration, login, refresh-token rotation, five roles |
| `src/modules/masters` | Customers, suppliers, products, units, HSN codes, per-party ledgers |
| `src/modules/invoices` | Sales invoices, gap-free numbering, tax computation |
| `src/modules/purchases` | Supplier bills, moving-average costing, input tax credit |
| `src/modules/notes` | Credit and debit notes, sales and purchase returns |
| `src/modules/payments` | Receipts, supplier payments, FIFO allocation, cheques |
| `src/modules/gstr1` | The monthly GST return, checked before download |
| `src/modules/printing` | A4 tax invoice (pdfkit) and thermal receipt (ESC/POS) |
| `src/modules/backup` | Full export and a tested restore path |
| `src/modules/ai` | Reading a supplier bill from a photograph |
| `src/modules/voice` | Answering spoken questions about the shop |
| `web/` | React front end — billing counter, ledger, all screens |

---

## Six decisions worth defending

### 1. Money is a string end to end, and the browser computes none of it

`Prisma.Decimal` server-side, `string` over the wire, `string` in the browser.
No amount is ever a JavaScript `number`, because `0.1 + 0.2` is the wrong answer
on a tax invoice.

The billing screen shows a live total as the operator types, but it does not
calculate it. Every figure — tax split, discount, round-off, grand total — comes
from `POST /api/sales-invoices/preview`, the same code path that later issues
the invoice. The screen and the printed bill therefore cannot disagree, which is
a property you get for free by refusing to duplicate the arithmetic.

### 2. Gap-free numbering is a row lock, not a counter

```ts
await tx.numberSequence.update({ where: { id }, data: { nextNumber: { increment: 1 } } });
```

Prisma compiles that to `UPDATE … SET nextNumber = nextNumber + 1 … RETURNING *`,
which takes a row lock held until the transaction commits. Two concurrent bills
serialise instead of reading the same value; a rollback returns the number to
the pool. An integration test fires 20 concurrent allocations and asserts 20
distinct numbers.

[`numbering.ts`](src/modules/invoices/numbering.ts) must be called **last**,
after everything else is known to be valid — allocating early reintroduces the
gaps the lock exists to prevent.

### 3. Landed cost, not invoice cost

A mill bills 100 kg at ₹95 with ₹500 freight. What the stock is actually worth
is 42.76 reams at ₹233.86 each, and getting there needs three things at once:
kg converted to reams using the paper's own weight, freight apportioned across
lines by value with no paise lost to rounding, and GST **excluded** because it
comes back as input credit. Moving average blends it with what was already on
the shelf.

[`costing.ts`](src/modules/purchases/costing.ts) is pure and unit-tested,
including the case where stock has gone negative — a real occurrence when a
delivery is billed before it is entered.

### 4. The reams↔kg factor is derived, never typed

```
ream weight (kg) = gsm × sheet area (m²) × sheets per ream ÷ 1000
```

A4 75gsm, 500 sheets → 2.3389 kg, so 1 kg = 0.4276 reams. Enter the paper
specification and the conversion configures itself
([`paperWeight.ts`](src/modules/masters/paperWeight.ts)). This removes the single
most error-prone piece of data entry in the system: a mistyped factor silently
misprices every kilogram bought from the mill thereafter.

### 5. pdfkit over Puppeteer, and column widths measured rather than guessed

Puppeteer means a ~200MB Chromium download and one to three seconds of startup
per document. pdfkit is a couple of megabytes and renders in milliseconds — at a
counter printing dozens of bills a day, that is the whole argument. The cost is
that layout is code instead of CSS, a fair trade for a document whose shape is
fixed by statute.

The numeric columns are sized against **measured Helvetica glyph widths**: at
7.5pt a lakh-scale amount is 44pt wide, and a narrower column wraps the figure
onto a second line, which on a tax invoice reads as a different number. A test
measures the real widths and fails if any column is too narrow. It caught
exactly that bug during development.

Two traps worth knowing: **U+20B9 (₹) is not in WinAnsi**, the encoding PDF's
built-in Helvetica uses, so amounts default to `Rs.` unless an embedded font is
supplied. And thermal printers want **latin1, not utf8** — a multi-byte sequence
prints as mojibake.

### 6. One ledger per firm, not per role

The same firm sells you reels in the morning and buys back your cut waste in the
afternoon. There is one `Party` and one account: sales and debit notes debit it,
purchases and credit notes credit it, receipts credit and payments debit. Both
directions net to a single closing balance, shown Dr/Cr the way the paper *bahi
khata* it replaces does.

This is also where a subtle bug lived. The columns were labelled *Billed* and
*Received* — customer words on an account keyed to the firm — so every supplier's
account read backwards. And a date-filtered statement computed its closing
balance from the period's own movement, ignoring everything before it, which on
a supplier account inverted the direction: a bill you had already paid showed as
money owed *to* you.

---

## The AI features

Two are built, both deliberately narrow.

**Reading a supplier bill from a photograph.** Photograph the bill, get the
supplier, bill number, date and line items back as a filled purchase form. The
model extracts; it does not decide. Products and suppliers are matched against
your own masters by a deterministic matcher, a printed GSTIN beats any name
score, and an unmatched line is flagged rather than guessed at.

**Asking the shop a question out loud,** in Punjabi or English — *"Sharma
Stationery nu kinna paisa dena hai?"* Read-only by design.

Both follow the same rule: **everything that can be deterministic is.** Spoken
numbers are parsed by a hand-written grammar (`sarhe teen` → 3.5, `sava do sau`
→ 225) because a parser is right every time and a model is right most of the
time and wrong silently. Candidate names are narrowed to a shortlist before the
model sees anything, so its whole job is picking from a list.

Two guarantees are enforced rather than intended:

- **The model never states a figure.** Every amount in an answer is composed
  from the database. A confidently wrong balance read out at a counter is worse
  than no feature.
- **Ids are validated against the shortlist,** so a hallucinated id can never
  reach a `where` clause. One integration test runs every intent and asserts
  that no row, balance, stock figure or number sequence moved.

---

## Testing

**587 tests, all green** — 338 unit, 249 integration.

Unit tests cover pure logic: the tax split, set-off ordering, moving-average
costing, FIFO allocation, ageing buckets, paper weight, Punjabi numerals, name
matching, Indian digit grouping, ESC/POS bytes, PDF layout.

Integration tests exist for what a unit test physically cannot prove — that the
transactions are atomic and the row locks actually serialise. They run against
real Postgres via `embedded-postgres`, so there is no Docker requirement:

- 20 concurrent number allocations produce 20 distinct numbers
- 10 concurrent invoices lose no stock
- 6 concurrent receipts never over-allocate an invoice
- A mid-transaction failure leaves **nothing** behind
- Cross-tenant reads **and writes** are rejected
- A whole shop day over real HTTP: register, sign in, set up masters, bill, take
  a payment, download the PDF

### Checking the tests actually work

Passing tests prove nothing until you have watched them fail. Each guarantee
below was verified by deliberately breaking the code and confirming the test
caught it:

| Sabotage | Caught by |
|---|---|
| Remove the party-balance row lock from `recordPayment` | the over-allocation test, plus 7 others |
| Make `authorize()` always allow | all 3 role-gate tests |
| Drop `businessId` from the `updateParty` filter | the cross-tenant **write** test |
| Narrow the inter-state total column back to 25pt | the column-width test |
| Touch a balance while answering a spoken question | the "writes absolutely nothing" test |
| Close a date-filtered ledger on the period's own movement | the "carries the earlier balance" test |
| Store a ream's weight against a product counted in kilograms | the "kilogram is not a ream" test |
| Renumber documents already issued while repairing a series | the "leaves issued numbers alone" test |

The third row is why the table exists. The first cross-tenant test only covered
*reads*, so deleting the tenant filter from `updateParty` changed nothing and
every test still passed. The gap was invisible until the mutation was tried.

### Nine real bugs found this way

The ones worth naming:

- **`sanitizeUser` was a denylist.** It stripped three known secrets and passed
  everything else through, so `tokenVersion`, `failedLoginCount` and
  `lockedUntil` were reaching the browser — and any new column on the User model
  would have joined them silently. It is an allowlist now.
- **The test factory was more complete than production.** Registration seeded
  number series for five document types but not `PURCHASE_INVOICE`, and the lazy
  fallback created it with an empty prefix — so the first real supplier bill was
  numbered `0001` instead of `PUR/0001`. No test caught it because the fixture
  seeded what registration didn't.
- **A mistyped year returned a 500.** A date input's year is a free-typed
  segment, so one stray keystroke sends `82026-04-01` — a perfectly valid
  JavaScript `Date`, waved through by `z.coerce.date()`, then a driver error. It
  was never one endpoint's bug: thirty call sites took an unbounded date.
- **`z.coerce.boolean()` turned `?preview=false` into `true`,** so previewing an
  invoice incremented its print count.
- **A kilogram was given the weight of a ream,** which would have declared 278 kg
  of paper as 650 kg on an e-way bill.

Five of the nine came from *using* the software rather than reading it.

---

## Not built yet

1. **Off-site backups on a schedule.** Taking one is a button and restoring it is
   a tested command, but somebody still has to press the button.
2. **Billing by voice.** Reading a photographed bill and answering spoken
   questions are done; creating an invoice by voice is not. Worth building only
   once the read-only path reliably understands real speech.
3. **E-way bill generation** against the NIC portal. Needs a commercial GSP
   account before it can be verified against anything real.
4. **Error monitoring.** Nothing reports a 500.
5. **Freight is added after tax.** On a composite supply, freight normally takes
   the rate of the goods it carries. Changing it would not touch bills already
   issued, so GSTR-1 raises a warning naming the affected invoices rather than
   quietly adjusting a legal document after the fact.

The shop's own remaining decisions — opening balances, what FS measures, the
freight question for the CA — are in [docs/GOING-LIVE.md](docs/GOING-LIVE.md).

---

## Licence

[MIT](LICENSE) — © 2026 Akhil Mittal.

The product rates in `prisma/seed-catalogue.ts` are invented sample data, not a
real price list. Anyone adapting this for their own shop should replace them and
confirm the GST rate for each HSN with their accountant before issuing an
invoice.
