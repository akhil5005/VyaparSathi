/**
 * The API over real HTTP.
 *
 * Every other integration test calls the service functions directly. This one
 * goes through the whole stack — Express routing, helmet, JSON parsing, the
 * authenticate middleware, the role gates, the Zod schemas at the controller
 * boundary, the error handler, and the response headers — because none of that
 * had ever executed before this file existed. The services were proven; the
 * wiring above them was only typechecked.
 *
 * The main case walks a real shop day in order: register the firm, sign in, set
 * up the masters, bill a customer, take a part payment, print the invoice. If
 * that passes, the software works.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { allowedOrigins } from './config/env.js';
import { prisma, resetDatabase, disconnect } from './test-support/db.js';
import { makeGstin } from './test-support/factories.js';
import { TestClient } from './test-support/httpClient.js';

const OWNER_PASSWORD = 'a-long-test-passphrase';

/// A distinct 10-digit Indian mobile per call — phone is unique per user.
let phoneSequence = 6000000000;
const nextPhone = () => String(++phoneSequence);

const registrationPayload = (overrides: { gstin?: string } = {}) => ({
  business: {
    legalName: 'Mittal Paper Traders',
    tradeName: 'Mittal Paper House',
    gstin: overrides.gstin ?? makeGstin('03'),
    addressLine1: 'Shop 14, Paper Market',
    city: 'Ludhiana',
    pincode: '141008',
    phone: nextPhone(),
  },
  owner: {
    fullName: 'Akhil Mittal',
    email: `owner${phoneSequence}@example.com`,
    phone: nextPhone(),
    password: OWNER_PASSWORD,
  },
});

describe('HTTP API', () => {
  let client: TestClient;

  before(async () => {
    client = await TestClient.start();
  });

  after(async () => {
    await client.stop();
    await disconnect();
  });

  beforeEach(async () => {
    await resetDatabase();
    client.authenticateAs(undefined).clearCookies();
  });

  // -------------------------------------------------------------------------
  // The whole shop day
  // -------------------------------------------------------------------------

  it('registers, bills a customer, takes a payment and prints — end to end', async () => {
    // ---- Register the firm ----
    const registration = registrationPayload();
    const registered = await client.post('/api/auth/register', registration);

    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    assert.ok(registered.body.accessToken, 'an access token comes back');
    assert.equal(registered.body.user.role, 'OWNER');
    assert.equal(registered.body.business.gstin, registration.business.gstin);
    // The refresh token is httpOnly and scoped to the auth routes, so no XSS
    // payload can read it and it is never sent to the billing endpoints.
    const setCookie = registered.headers.getSetCookie().join(';');
    assert.match(setCookie, /vyapar_rt=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Path=\/api\/auth/i);
    // A password must never come back out, in any form.
    assert.ok(!JSON.stringify(registered.body).toLowerCase().includes('passwordhash'));
    assert.ok(!JSON.stringify(registered.body).includes(OWNER_PASSWORD));

    client.authenticateAs(registered.body.accessToken);

    // Registration seeds the unit master, so billing works without setup.
    const units = await client.get('/api/masters/units');
    assert.equal(units.status, 200);
    assert.ok(units.body.units.length > 0, 'default units were created');
    const ream = units.body.units.find((u: any) => /ream/i.test(u.name));
    assert.ok(ream, `expected a Ream unit, got ${units.body.units.map((u: any) => u.name)}`);

    // ---- Masters: HSN at the confirmed 18%, then a product ----
    const hsn = await client.post('/api/masters/hsn', {
      code: '4802',
      description: 'Uncoated writing and printing paper',
      gstRate: 18,
      effectiveFrom: '2020-01-01',
    });
    assert.equal(hsn.status, 201, JSON.stringify(hsn.body));

    const product = await client.post('/api/masters/products', {
      name: 'JK Copier A4 75gsm',
      hsnCodeId: hsn.body.hsnCode.id,
      baseUnitId: ream.id,
      gsm: 75,
      sheetSize: 'A4',
      sheetsPerReam: 500,
      defaultSaleRate: 240,
      openingStock: 100,
      openingStockRate: 200,
    });
    assert.equal(product.status, 201, JSON.stringify(product.body));

    const customer = await client.post('/api/masters/parties', {
      displayName: 'Sharma Stationery',
      gstin: makeGstin('03'),
      phone: nextPhone(),
      city: 'Ludhiana',
    });
    assert.equal(customer.status, 201, JSON.stringify(customer.body));

    // ---- Preview before committing, the way the invoice form does ----
    const preview = await client.post('/api/sales-invoices/preview', {
      partyId: customer.body.party.id,
      items: [{ productId: product.body.product.id, quantity: 10, rate: 240 }],
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    // 10 x 240 = 2400 taxable; 18% intra-state splits 9 + 9 = 216 + 216.
    assert.equal(preview.body.totals.taxableValue, '2400');
    assert.equal(preview.body.totals.totalCgst, '216');
    assert.equal(preview.body.totals.totalSgst, '216');
    assert.equal(preview.body.totals.totalIgst, '0');
    assert.equal(preview.body.totals.grandTotal, '2832');

    // Nothing was written by a preview.
    assert.equal(await prisma.salesInvoice.count(), 0);

    // ---- Issue it ----
    const invoice = await client.post('/api/sales-invoices', {
      partyId: customer.body.party.id,
      items: [{ productId: product.body.product.id, quantity: 10, rate: 240 }],
    });
    assert.equal(invoice.status, 201, JSON.stringify(invoice.body));
    assert.equal(invoice.body.invoice.status, 'ISSUED');
    assert.equal(invoice.body.invoice.invoiceNumber, 'INV/0001');
    assert.equal(invoice.body.invoice.grandTotal, '2832');

    const invoiceId = invoice.body.invoice.id;

    // ---- Take a part payment in cash ----
    const payment = await client.post('/api/payments', {
      partyId: customer.body.party.id,
      direction: 'RECEIPT',
      amount: 2000,
      mode: 'CASH',
    });
    assert.equal(payment.status, 201, JSON.stringify(payment.body));

    // FIFO settled it against the only open bill.
    const afterPayment = await client.get(`/api/sales-invoices/${invoiceId}`);
    assert.equal(afterPayment.body.invoice.amountPaid, '2000');
    assert.equal(afterPayment.body.invoice.amountDue, '832');

    // ---- The udhaar report shows the balance ----
    const outstanding = await client.get('/api/payments/outstanding');
    assert.equal(outstanding.status, 200);
    const row = outstanding.body.parties.find((p: any) => p.partyId === customer.body.party.id);
    assert.ok(row, 'the customer appears on the outstanding report');
    assert.equal(row.ageing.total, '832');

    // ---- Print it ----
    const pdf = await client.get(`/api/printing/invoices/${invoiceId}/pdf`);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.match(pdf.headers.get('content-disposition') ?? '', /inline; filename="invoice-INV-0001\.pdf"/);
    // A reissued invoice must never come back from a proxy cache.
    assert.equal(pdf.headers.get('cache-control'), 'no-store');
    assert.equal(pdf.buffer!.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.equal(pdf.headers.get('content-length'), String(pdf.buffer!.length));

    const receipt = await client.get(`/api/printing/invoices/${invoiceId}/receipt`);
    assert.equal(receipt.status, 200);
    assert.ok(receipt.body.lines.join('\n').includes('INV/0001'));
  });

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  describe('authentication', () => {
    it('refuses every protected route without a token', async () => {
      for (const path of [
        '/api/masters/units',
        '/api/masters/parties',
        '/api/sales-invoices',
        '/api/purchases',
        '/api/payments',
        '/api/notes',
        '/api/printing/printers',
      ]) {
        const response = await client.get(path, { token: null });
        assert.equal(response.status, 401, `${path} should be 401`);
        assert.equal(response.body.error.code, 'UNAUTHORIZED');
      }
    });

    it('refuses a malformed or forged token', async () => {
      for (const token of ['not-a-jwt', 'a.b.c', `${'x'.repeat(200)}`]) {
        const response = await client.get('/api/masters/units', { token });
        assert.equal(response.status, 401);
      }
    });

    it('leaves /health open', async () => {
      const response = await client.get('/health', { token: null });
      assert.equal(response.status, 200);
      assert.equal(response.body.status, 'ok');
    });

    it('signs in with either email or phone', async () => {
      const registration = registrationPayload();
      await client.post('/api/auth/register', registration);

      for (const identifier of [registration.owner.email, registration.owner.phone]) {
        const login = await client.post('/api/auth/login', {
          identifier,
          password: OWNER_PASSWORD,
        });
        assert.equal(login.status, 200, `login with ${identifier}`);
        assert.ok(login.body.accessToken);
      }
    });

    it('gives the same answer for a wrong password and an unknown user', async () => {
      const registration = registrationPayload();
      await client.post('/api/auth/register', registration);

      const wrongPassword = await client.post('/api/auth/login', {
        identifier: registration.owner.phone,
        password: 'definitely-not-the-password',
      });
      const unknownUser = await client.post('/api/auth/login', {
        identifier: '9999999999',
        password: 'definitely-not-the-password',
      });

      // Differing status or message here would let an attacker enumerate which
      // phone numbers have accounts.
      assert.equal(wrongPassword.status, unknownUser.status);
      assert.deepEqual(wrongPassword.body, unknownUser.body);
    });

    it('rotates the refresh token and revokes the whole session on reuse', async () => {
      const registration = registrationPayload();
      const registered = await client.post('/api/auth/register', registration);
      const firstRefreshToken = registered.body.refreshToken;

      const rotated = await client.post('/api/auth/refresh', { refreshToken: firstRefreshToken });
      assert.equal(rotated.status, 200);
      assert.notEqual(rotated.body.refreshToken, firstRefreshToken, 'the token rotated');

      // Presenting the consumed token again is the signature of a stolen token
      // being replayed, so the entire session tree is revoked.
      const replay = await client.post('/api/auth/refresh', { refreshToken: firstRefreshToken });
      assert.equal(replay.status, 401);

      const afterReuse = await client.post('/api/auth/refresh', {
        refreshToken: rotated.body.refreshToken,
      });
      assert.equal(afterReuse.status, 401, 'the rotated token is dead too');
    });

    it('refreshes from the httpOnly cookie alone, with no body', async () => {
      await client.post('/api/auth/register', registrationPayload());
      // The client stored vyapar_rt from Set-Cookie, exactly as a browser would.
      assert.ok(client.cookie('vyapar_rt'));

      const refreshed = await client.post('/api/auth/refresh', {});
      assert.equal(refreshed.status, 200);
      assert.ok(refreshed.body.accessToken);
    });

    it('logs out and clears the cookie', async () => {
      const registered = await client.post('/api/auth/register', registrationPayload());
      const logout = await client.post('/api/auth/logout', {
        refreshToken: registered.body.refreshToken,
      });
      assert.equal(logout.status, 204);

      const afterLogout = await client.post('/api/auth/refresh', {
        refreshToken: registered.body.refreshToken,
      });
      assert.equal(afterLogout.status, 401);
    });

    it('returns the signed-in profile from /me', async () => {
      const registered = await client.post('/api/auth/register', registrationPayload());
      client.authenticateAs(registered.body.accessToken);

      const me = await client.get('/api/auth/me');
      assert.equal(me.status, 200);
      assert.equal(me.body.user.role, 'OWNER');
    });

    it('sends the same business shape from register, login and /me', async () => {
      // These drifted: login omitted stateCode and stateName, so a client had
      // *less* information right after signing in than after a refresh. The
      // state code decides CGST+SGST vs IGST, so it must never be intermittent.
      const expected = [
        'id',
        'legalName',
        'tradeName',
        'gstin',
        'stateCode',
        'stateName',
        'city',
        'phone',
        'gstRegistrationType',
        'fyStartMonth',
        'hsnDigits',
        'isActive',
      ].sort();

      const registration = registrationPayload();
      const registered = await client.post('/api/auth/register', registration);
      assert.deepEqual(Object.keys(registered.body.business).sort(), expected, 'register');

      const login = await client.post('/api/auth/login', {
        identifier: registration.owner.phone,
        password: OWNER_PASSWORD,
      });
      assert.deepEqual(Object.keys(login.body.business).sort(), expected, 'login');

      client.authenticateAs(login.body.accessToken);
      const me = await client.get('/api/auth/me');
      assert.deepEqual(Object.keys(me.body.business).sort(), expected, '/me');

      // And the values agree, not just the key sets.
      assert.equal(login.body.business.stateCode, registered.body.business.stateCode);
      assert.equal(me.body.business.stateCode, registered.body.business.stateCode);
    });

    it('sends exactly the allowlisted user fields and nothing more', async () => {
      // An allowlist, asserted exactly. A "does it contain passwordHash?" check
      // passes for every field nobody thought to look for — which is how
      // tokenVersion, failedLoginCount and lockedUntil were being shipped to
      // the browser before this test existed.
      const expected = [
        'id',
        'businessId',
        'fullName',
        'email',
        'phone',
        'role',
        'isActive',
        'emailVerifiedAt',
        'phoneVerifiedAt',
        'lastLoginAt',
        'createdAt',
      ].sort();

      const registration = registrationPayload();
      const registered = await client.post('/api/auth/register', registration);
      assert.deepEqual(Object.keys(registered.body.user).sort(), expected, 'register');

      const login = await client.post('/api/auth/login', {
        identifier: registration.owner.phone,
        password: OWNER_PASSWORD,
      });
      assert.deepEqual(Object.keys(login.body.user).sort(), expected, 'login');

      client.authenticateAs(login.body.accessToken);
      const me = await client.get('/api/auth/me');
      assert.deepEqual(Object.keys(me.body.user).sort(), expected, '/me');

      // And the staff list, which returns other people's records.
      const users = await client.get('/api/auth/users');
      for (const user of users.body.users) {
        for (const forbidden of ['passwordHash', 'totpSecret', 'recoveryCodes', 'tokenVersion']) {
          assert.ok(!(forbidden in user), `${forbidden} must not be exposed`);
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // Forgotten passwords
  // -------------------------------------------------------------------------

  describe('password reset', () => {
    it('answers the same for a real account and an invented one', async () => {
      const registration = registrationPayload();
      await client.post('/api/auth/register', registration);

      const real = await client.post('/api/auth/forgot-password', {
        identifier: registration.owner.phone,
      });
      const invented = await client.post('/api/auth/forgot-password', {
        identifier: '5550000000',
      });

      // Any difference here — status, body, even wording — turns this endpoint
      // into a way to discover which phone numbers belong to real shops.
      assert.equal(real.status, invented.status);
      assert.deepEqual(real.body, invented.body);
    });

    it('says plainly that no link can be sent when delivery is not configured', async () => {
      const registration = registrationPayload();
      await client.post('/api/auth/register', registration);

      const response = await client.post('/api/auth/forgot-password', {
        identifier: registration.owner.phone,
      });

      // The tests run without RESEND_API_KEY, which is also the state of every
      // deployment until somebody configures one. Claiming "a link has been
      // sent" leaves the person waiting for something never sent.
      assert.equal(response.status, 200);
      assert.equal(response.body.deliveryConfigured, false);
      assert.match(response.body.message, /no email delivery/i);
    });

    it('still records a token, so configuring delivery later needs no other change', async () => {
      const registration = registrationPayload();
      await client.post('/api/auth/register', registration);
      await client.post('/api/auth/forgot-password', { identifier: registration.owner.phone });

      assert.equal(await prisma.passwordResetToken.count(), 1);
    });
  });

  // -------------------------------------------------------------------------
  // Your own profile
  // -------------------------------------------------------------------------

  describe('own profile', () => {
    /** Signs in a phone-only clerk, which is the normal shape at a counter. */
    async function withClerk() {
      const registration = registrationPayload();
      const registered = await client.post('/api/auth/register', registration);
      client.authenticateAs(registered.body.accessToken);

      const staff = await client.post('/api/auth/users', {
        fullName: 'Counter Clerk',
        phone: nextPhone(),
        password: 'clerk-password-long',
        role: 'BILLING_STAFF',
      });
      assert.equal(staff.status, 201, JSON.stringify(staff.body));

      const signedIn = await client.post('/api/auth/login', {
        identifier: staff.body.user.phone,
        password: 'clerk-password-long',
      });
      client.authenticateAs(signedIn.body.accessToken);

      return { registration, staff: staff.body.user };
    }

    it('adds an email to an account that had none — the only way reset can reach it', async () => {
      const { staff } = await withClerk();
      assert.equal(staff.email, null);

      const updated = await client.patch('/api/auth/me', { email: 'clerk@example.com' });
      assert.equal(updated.status, 200, JSON.stringify(updated.body));
      assert.equal(updated.body.user.email, 'clerk@example.com');

      const me = await client.get('/api/auth/me');
      assert.equal(me.body.user.email, 'clerk@example.com');
    });

    it('clears an email when null is sent, and leaves it alone when omitted', async () => {
      const registration = registrationPayload();
      const registered = await client.post('/api/auth/register', registration);
      client.authenticateAs(registered.body.accessToken);

      const renamed = await client.patch('/api/auth/me', { fullName: 'Akhil K Mittal' });
      assert.equal(renamed.body.user.fullName, 'Akhil K Mittal');
      assert.equal(
        renamed.body.user.email,
        registration.owner.email,
        'an omitted email must survive',
      );

      const cleared = await client.patch('/api/auth/me', { email: null });
      assert.equal(cleared.body.user.email, null);
    });

    it('will not let you promote yourself', async () => {
      const { staff } = await withClerk();

      await client.patch('/api/auth/me', { fullName: 'Clerk', role: 'OWNER', isActive: true });

      // Unknown keys are stripped by the schema rather than rejected, so what
      // matters is what actually landed in the database.
      const after = await prisma.user.findUniqueOrThrow({ where: { id: staff.id } });
      assert.equal(after.role, 'BILLING_STAFF');
    });

    it('refuses an email another user in the same shop already has', async () => {
      const { registration } = await withClerk();

      const clash = await client.patch('/api/auth/me', { email: registration.owner.email });
      assert.equal(clash.status, 409, JSON.stringify(clash.body));
    });

    it('needs a session', async () => {
      client.authenticateAs(undefined);
      const anonymous = await client.patch('/api/auth/me', { fullName: 'Nobody' });
      assert.equal(anonymous.status, 401);
    });
  });

  // -------------------------------------------------------------------------
  // Role gates
  // -------------------------------------------------------------------------

  describe('role gates', () => {
    let ownerToken: string;
    let staffToken: string;
    let partyId: string;

    beforeEach(async () => {
      const registered = await client.post('/api/auth/register', registrationPayload());
      ownerToken = registered.body.accessToken;
      client.authenticateAs(ownerToken);

      const staffPhone = nextPhone();
      const created = await client.post('/api/auth/users', {
        fullName: 'Counter Staff',
        phone: staffPhone,
        password: OWNER_PASSWORD,
        role: 'BILLING_STAFF',
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));

      const staffLogin = await client.post('/api/auth/login', {
        identifier: staffPhone,
        password: OWNER_PASSWORD,
      });
      staffToken = staffLogin.body.accessToken;

      const party = await client.post('/api/masters/parties', {
        displayName: 'Sharma Stationery',
        stateCode: '03',
      });
      partyId = party.body.party.id;
    });

    it('lets billing staff add a walk-in customer but not edit one', async () => {
      const created = await client.post(
        '/api/masters/parties',
        { displayName: 'Walk-in Customer', stateCode: '03' },
        { token: staffToken },
      );
      assert.equal(created.status, 201);

      const edited = await client.patch(
        `/api/masters/parties/${partyId}`,
        { displayName: 'Renamed' },
        { token: staffToken },
      );
      assert.equal(edited.status, 403);
      assert.equal(edited.body.error.code, 'FORBIDDEN');
    });

    it('lets the owner set a staff password, and signs that person out', async () => {
      const staffPhone = nextPhone();
      const created = await client.post(
        '/api/auth/users',
        {
          fullName: 'Second Staff',
          phone: staffPhone,
          password: OWNER_PASSWORD,
          role: 'BILLING_STAFF',
        },
        { token: ownerToken },
      );
      assert.equal(created.status, 201);

      const before = await client.post('/api/auth/login', {
        identifier: staffPhone,
        password: OWNER_PASSWORD,
      });
      assert.equal(before.status, 200, 'signs in with the original password');
      const staffAccess = before.body.accessToken;

      const newPassword = 'a-brand-new-passphrase';
      const set = await client.post(
        `/api/auth/users/${created.body.user.id}/set-password`,
        { newPassword },
        { token: ownerToken },
      );
      assert.equal(set.status, 200, JSON.stringify(set.body));

      // The old password stops working and the new one starts.
      const old = await client.post('/api/auth/login', {
        identifier: staffPhone,
        password: OWNER_PASSWORD,
      });
      assert.equal(old.status, 401);

      const fresh = await client.post('/api/auth/login', {
        identifier: staffPhone,
        password: newPassword,
      });
      assert.equal(fresh.status, 200);

      // tokenVersion was bumped, so the token they were holding is dead —
      // the point of the feature is that whoever knew the old password is out.
      const stale = await client.get('/api/auth/me', { token: staffAccess });
      assert.equal(stale.status, 401, 'the existing session was revoked');
    });

    it('refuses to set an owner’s password, or your own', async () => {
      const users = await client.get('/api/auth/users', { token: ownerToken });
      const owner = users.body.users.find((u: any) => u.role === 'OWNER');

      // Own account must go through change-password, which demands the current
      // password — otherwise a borrowed unlocked session takes over the shop.
      const self = await client.post(
        `/api/auth/users/${owner.id}/set-password`,
        { newPassword: 'some-other-passphrase' },
        { token: ownerToken },
      );
      assert.ok(self.status >= 400, `expected a rejection, got ${self.status}`);
    });

    it('does not let staff set anyone’s password', async () => {
      const users = await client.get('/api/auth/users', { token: ownerToken });
      const target = users.body.users.find((u: any) => u.role === 'BILLING_STAFF');

      const attempt = await client.post(
        `/api/auth/users/${target.id}/set-password`,
        { newPassword: 'a-long-enough-passphrase' },
        { token: staffToken },
      );
      assert.equal(attempt.status, 403);
    });

    it('keeps staff management to the owner', async () => {
      const asStaff = await client.get('/api/auth/users', { token: staffToken });
      assert.equal(asStaff.status, 403);

      const asOwner = await client.get('/api/auth/users', { token: ownerToken });
      assert.equal(asOwner.status, 200);
      assert.equal(asOwner.body.users.length, 2);
    });

    it('keeps printer configuration away from the counter', async () => {
      const asStaff = await client.post(
        '/api/printing/printers',
        { name: 'Counter' },
        { token: staffToken },
      );
      assert.equal(asStaff.status, 403);

      const asOwner = await client.post(
        '/api/printing/printers',
        { name: 'Counter' },
        { token: ownerToken },
      );
      assert.equal(asOwner.status, 201);
      assert.equal(asOwner.body.printer.isDefault, true);
    });

    it('lets staff read an invoice PDF — an accountant may need to send a copy', async () => {
      const printers = await client.get('/api/printing/printers', { token: staffToken });
      assert.equal(printers.status, 200);
    });
  });

  // -------------------------------------------------------------------------
  // Tenant isolation
  // -------------------------------------------------------------------------

  describe('tenant isolation', () => {
    /// Two registered firms, and the ids belonging to the first.
    async function twoFirms() {
      const firstToken = (await client.post('/api/auth/register', registrationPayload())).body
        .accessToken;
      client.authenticateAs(firstToken);

      const party = await client.post('/api/masters/parties', {
        displayName: 'Sharma Stationery',
        stateCode: '03',
      });
      const hsn = await client.post('/api/masters/hsn', {
        code: '4802',
        description: 'Uncoated writing and printing paper',
        gstRate: 18,
        effectiveFrom: '2020-01-01',
      });
      const units = await client.get('/api/masters/units');
      const ream = units.body.units.find((u: any) => /ream/i.test(u.name));
      const product = await client.post('/api/masters/products', {
        name: 'JK Copier A4 75gsm',
        hsnCodeId: hsn.body.hsnCode.id,
        baseUnitId: ream.id,
        defaultSaleRate: 240,
        openingStock: 100,
        openingStockRate: 200,
      });
      const invoice = await client.post('/api/sales-invoices', {
        partyId: party.body.party.id,
        items: [{ productId: product.body.product.id, quantity: 5, rate: 240 }],
      });

      client.clearCookies();
      const secondToken = (await client.post('/api/auth/register', registrationPayload())).body
        .accessToken;

      return {
        firstToken,
        secondToken,
        partyId: party.body.party.id,
        productId: product.body.product.id,
        invoiceId: invoice.body.invoice.id,
      };
    }

    it('cannot read another firm’s data with a valid token of its own', async () => {
      const { secondToken, partyId, invoiceId } = await twoFirms();

      const party = await client.get(`/api/masters/parties/${partyId}`, { token: secondToken });
      assert.equal(party.status, 404, 'a cross-tenant read must not succeed');

      const invoice = await client.get(`/api/sales-invoices/${invoiceId}`, { token: secondToken });
      assert.equal(invoice.status, 404);

      const list = await client.get('/api/masters/parties', { token: secondToken });
      assert.equal(list.body.parties.length, 0);
    });

    it('cannot write to another firm’s records', async () => {
      const { firstToken, secondToken, partyId, invoiceId } = await twoFirms();

      // Each of these is a valid, authorised request from a real owner — the
      // only thing wrong with it is that the id belongs to somebody else. The
      // role gate cannot catch that; only the tenant filter in the service can.
      const edited = await client.patch(
        `/api/masters/parties/${partyId}`,
        { displayName: 'Hijacked' },
        { token: secondToken },
      );
      assert.equal(edited.status, 404, 'a cross-tenant update must not succeed');

      const cancelled = await client.post(
        `/api/sales-invoices/${invoiceId}/cancel`,
        { reason: 'Cross-tenant cancellation attempt' },
        { token: secondToken },
      );
      assert.equal(cancelled.status, 404);

      // And the first firm's records are untouched — a 404 that still wrote
      // would be worse than an error.
      const stillThere = await client.get(`/api/masters/parties/${partyId}`, {
        token: firstToken,
      });
      assert.equal(stillThere.status, 200);
      assert.equal(stillThere.body.party.displayName, 'Sharma Stationery');
    });

    it('cannot bill another firm’s customer or product', async () => {
      const { secondToken, partyId, productId } = await twoFirms();

      const invoice = await client.post(
        '/api/sales-invoices',
        { partyId, items: [{ productId, quantity: 1, rate: 240 }] },
        { token: secondToken },
      );
      // A 2xx here would mean one shop could put a bill on another's ledger.
      assert.ok(invoice.status >= 400, `expected a rejection, got ${invoice.status}`);
      assert.equal(await prisma.salesInvoice.count({ where: { partyId } }), 1);
    });

    it('cannot print another firm’s invoice', async () => {
      const { secondToken, invoiceId } = await twoFirms();
      const pdf = await client.get(`/api/printing/invoices/${invoiceId}/pdf`, {
        token: secondToken,
      });
      assert.equal(pdf.status, 404);
    });
  });

  // -------------------------------------------------------------------------
  // Error shapes — the frontend will render these
  // -------------------------------------------------------------------------

  describe('error shapes', () => {
    let token: string;

    beforeEach(async () => {
      token = (await client.post('/api/auth/register', registrationPayload())).body.accessToken;
      client.authenticateAs(token);
    });

    it('reports validation failures field by field', async () => {
      const response = await client.post('/api/masters/parties', { displayName: 'x' });
      assert.equal(response.status, 400);
      assert.equal(response.body.error.code, 'VALIDATION_ERROR');
      assert.ok(Array.isArray(response.body.error.fields));
      assert.ok(response.body.error.fields.length > 0);
      assert.ok(response.body.error.fields.every((f: any) => 'path' in f && 'message' in f));
    });

    it('rejects an invalid GSTIN with a reason, not a generic failure', async () => {
      const response = await client.post('/api/masters/parties', {
        displayName: 'Bad GSTIN Traders',
        // Correct shape, wrong checksum — the mod-36 check has to catch this.
        gstin: '03AABCM1234C1ZZ',
      });
      assert.equal(response.status, 400);
      assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    });

    it('404s an unknown route with a usable message', async () => {
      const response = await client.get('/api/does-not-exist');
      assert.equal(response.status, 404);
      assert.equal(response.body.error.code, 'NOT_FOUND');
      assert.match(response.body.error.message, /GET \/api\/does-not-exist/);
    });

    it('404s a real route with an unknown id', async () => {
      const response = await client.get('/api/sales-invoices/clzzzzzzzzzzzzzzzzzzzzzzz');
      assert.equal(response.status, 404);
      assert.equal(response.body.error.code, 'NOT_FOUND');
    });

    it('409s a duplicate rather than 500ing on the constraint', async () => {
      await client.post('/api/masters/units', { name: 'Bundle', symbol: 'bdl', uqc: 'NOS' });
      const duplicate = await client.post('/api/masters/units', {
        name: 'Bundle',
        symbol: 'bdl',
        uqc: 'NOS',
      });
      assert.equal(duplicate.status, 409);
      assert.equal(duplicate.body.error.code, 'CONFLICT');
    });

    it('rejects a malformed JSON body as 400, not 500', async () => {
      // body-parser throws before any route runs. Untagged, that lands in the
      // 500 branch and — outside production — answers with a stack trace.
      const response = await fetch(`${client.baseUrl}/api/masters/units`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: '{"name": "broken",',
      });
      assert.equal(response.status, 400);
      const body = (await response.json()) as any;
      assert.equal(body.error.code, 'INVALID_BODY');
      assert.ok(!('stack' in body.error));
    });

    it('never leaks a stack trace in the error body of a normal failure', async () => {
      const response = await client.get('/api/sales-invoices/clzzzzzzzzzzzzzzzzzzzzzzz');
      assert.ok(!('stack' in response.body.error));
    });
  });

  // -------------------------------------------------------------------------
  // CORS — the frontend is on its own subdomain, so every call is cross-origin
  // -------------------------------------------------------------------------

  describe('CORS', () => {
    // Whatever APP_URL is configured to; the client is same-process so it can
    // ask rather than assume.
    const allowed = allowedOrigins[0]!;

    it('answers a preflight from the app origin with credentials allowed', async () => {
      const response = await fetch(`${client.baseUrl}/api/auth/login`, {
        method: 'OPTIONS',
        headers: {
          Origin: allowed,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type,authorization',
        },
      });

      assert.ok(response.status < 300, `preflight returned ${response.status}`);
      // Echoing the specific origin, not `*` — a wildcard is invalid alongside
      // credentials and the browser would reject the response.
      assert.equal(response.headers.get('access-control-allow-origin'), allowed);
      assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
      assert.match(response.headers.get('access-control-allow-methods') ?? '', /POST/);
    });

    it('allows the app origin to read a real response', async () => {
      const response = await fetch(`${client.baseUrl}/health`, { headers: { Origin: allowed } });
      assert.equal(response.headers.get('access-control-allow-origin'), allowed);
      assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
    });

    it('sends no allow header to an origin that is not configured', async () => {
      const response = await fetch(`${client.baseUrl}/health`, {
        headers: { Origin: 'https://not-our-app.example.com' },
      });
      // The request still succeeds server-side; the *browser* blocks the read
      // because this header is absent. Returning an error instead would leak
      // that the endpoint exists and break non-browser clients.
      assert.equal(response.headers.get('access-control-allow-origin'), null);
    });

    it('serves a request with no Origin at all', async () => {
      // curl, uptime checks, the mobile app later — CORS is a browser rule and
      // there is no browser here to protect.
      const response = await fetch(`${client.baseUrl}/health`);
      assert.equal(response.status, 200);
    });

    it('never answers with a wildcard, which would void the credentials', async () => {
      for (const origin of [allowed, 'https://not-our-app.example.com']) {
        const response = await fetch(`${client.baseUrl}/health`, { headers: { Origin: origin } });
        assert.notEqual(response.headers.get('access-control-allow-origin'), '*');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Security headers
  // -------------------------------------------------------------------------

  it('sets the helmet headers and hides the Express fingerprint', async () => {
    const response = await client.get('/health', { token: null });
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(response.headers.get('x-frame-options') || response.headers.get('content-security-policy'));
    assert.equal(response.headers.get('x-powered-by'), null);
  });

  it('allows cross-origin resource loads, which helmet blocks by default', async () => {
    // helmet's default is `same-origin`, correct for a website and wrong here:
    // the frontend is on another origin, and opening an invoice PDF in a new
    // tab is a no-cors navigation that `same-origin` would refuse.
    const response = await client.get('/health', { token: null });
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'cross-origin');
  });
});

// ---------------------------------------------------------------------------
// Rate limiting, on its own app so its counters affect nothing else
// ---------------------------------------------------------------------------

describe('HTTP rate limiting', () => {
  let limited: TestClient;

  before(async () => {
    limited = await TestClient.start({ enableRateLimit: true });
  });

  after(async () => {
    await limited.stop();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it('stops the sixth registration attempt from one address', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const response = await limited.post('/api/auth/register', registrationPayload());
      statuses.push(response.status);
    }

    // Five allowed per hour, then 429 — and the message must stay JSON so the
    // frontend can render it like any other error.
    assert.equal(statuses.slice(0, 5).every((s) => s === 201), true, `got ${statuses}`);
    assert.equal(statuses[5], 429);
    assert.equal(statuses[6], 429);

    const blocked = await limited.post('/api/auth/register', registrationPayload());
    assert.equal(blocked.body.error.code, 'TOO_MANY_REQUESTS');
  });

  /**
   * Asking for a reset link and redeeming one had a single shared budget, and
   * the consequence was ugly: request a handful of links while something
   * downstream is misconfigured, finally get a working one, and then be
   * refused permission to use it. A valid token and no way to spend it.
   */
  it('lets a reset link be redeemed after the request budget is exhausted', async () => {
    const registration = registrationPayload();
    await limited.post('/api/auth/register', registration);

    // Burn the request budget, exactly as a frustrated person retrying does.
    for (let i = 0; i < 8; i++) {
      await limited.post('/api/auth/forgot-password', { identifier: registration.owner.phone });
    }
    const exhausted = await limited.post('/api/auth/forgot-password', {
      identifier: registration.owner.phone,
    });
    assert.equal(exhausted.status, 429, 'requesting should be limited');

    // Redeeming must still be possible. An invalid token is the right probe:
    // it proves the request reached the handler rather than the limiter, and
    // it needs no real token to do so.
    const redeem = await limited.post('/api/auth/reset-password', {
      token: 'a-token-that-does-not-exist',
      newPassword: 'a-brand-new-passphrase',
    });
    assert.notEqual(redeem.status, 429, 'redeeming must have its own budget');
    assert.equal(redeem.status, 400);
    assert.match(redeem.body.error.message, /invalid or has expired/i);
  });

  it('still limits brute force against the reset link itself', async () => {
    // Counted rather than indexed: the limiter's budget is per app instance and
    // the test above already spent some of it. Asserting on a fixed position
    // would make this pass or fail depending on test order.
    let rejected = 0;
    let blockedAfter: number | null = null;

    for (let i = 0; i < 30 && blockedAfter === null; i++) {
      const response = await limited.post('/api/auth/reset-password', {
        token: `guess-${i}`,
        newPassword: 'a-brand-new-passphrase',
      });
      if (response.status === 429) blockedAfter = rejected;
      else {
        assert.equal(response.status, 400);
        rejected += 1;
      }
    }

    // Guessing 32 random bytes is not a real threat, but it should not be free
    // either — and the ceiling must stay well clear of someone fumbling the
    // confirmation box a few times.
    assert.notEqual(blockedAfter, null, 'brute force was never blocked');
    assert.ok(blockedAfter! >= 10, `blocked after only ${blockedAfter} attempts`);
  });
});
