# Before real invoices go out

The engineering is done; these are the shop's own decisions and one-off tasks.
Kept out of the README because they matter to whoever runs the shop, not to
somebody reading the code.

Deployment itself — Render, Neon, environment variables, the AI keys — is in
[DEPLOYMENT.md](DEPLOYMENT.md).

---

## Settled

- [x] **GST rate confirmed: 18% on every product.** Seeded in `prisma/seed.ts`
      (9% CGST + 9% SGST within Punjab, 18% IGST outside). Note the test
      fixtures deliberately use 12% instead — if a test only passes at 18%, the
      rate has been hardcoded somewhere it should be read from `HsnTaxRate`.

## Data to enter

- [ ] Enter opening balances for every party as at the switchover date.
- [ ] Enter opening stock per product with its cost.
- [ ] Confirm the invoice number format the CA wants (`INV/0001/26-27` is the
      default).

## One-off fixes on the live database

- [ ] **Run `npm run repair:number-prefixes`.** A shop registered before the
      seed was completed has a `PURCHASE_INVOICE` or `PAYMENT_VOUCHER` series
      with a blank prefix, numbering bills `0001` instead of `PUR/0001`. The
      script prints a dry run first, never touches a prefix chosen on purpose,
      and never rewrites a number that has already been issued — cancel and
      re-enter those if the numbering matters more than the history.

      ```bash
      DATABASE_URL="postgresql://…" npm run repair:number-prefixes
      DATABASE_URL="postgresql://…" npm run repair:number-prefixes -- --apply
      ```

- [ ] **Clear the test data.** The AV Enterprises bill and payment entered while
      verifying the supplier-payment feature are not real purchases — that bill
      is addressed to another firm. Remove them before real entries start.

## Decisions somebody has to make

- [ ] **What does FS measure?** The sheet-size parser takes ISO sizes (`A4`) and
      explicit dimensions (`8.5x13`, `210x330mm`) but not Indian trade names, so
      an FS product has to be entered with its dimensions or left without a
      size. Without one there is no reams↔kg conversion for it. Getting the
      number wrong silently misprices every kilogram bought, so it is a call for
      whoever knows the mill rather than a default worth guessing.

- [ ] **Freight after tax, or inside it?** On a composite supply of goods,
      freight normally takes the rate of the goods it carries. This bills it
      after tax. Changing it would not touch invoices already issued, so GSTR-1
      raises a warning naming the affected ones rather than quietly adjusting a
      legal document. Needs the CA.

## Still worth building

- [ ] **Add alias names to the product form.** `Product.aliasNames` is what the
      bill scanner and the voice matcher search, and it is the difference
      between `Copier Paper48025690 FS 75-10 BOXES` on a supplier's bill
      matching a product or not. The column exists and the API accepts it; only
      the form field is missing.

- [ ] **Replace the dev-only reset-link logging** in `auth.controller.ts` with
      real SMS or WhatsApp delivery. Email works today with `RESEND_API_KEY`,
      but most accounts here have a phone number and no email address.

- [ ] **Scheduled off-site backups.** Taking one is a button and restoring it is
      a tested command, but somebody still has to press the button — and the
      free-tier database keeps only a six-hour restore window, so a mistake
      noticed the next morning is already past it.

- [ ] **Error monitoring.** Nothing reports a 500.
