/**
 * Sets a user's password directly against the database.
 *
 *   DATABASE_URL="postgresql://…" npm run set-password -- \
 *     --user 9876500001 --password "a new password"
 *
 * The last resort, and the only recovery path an **owner** has.
 *
 * Staff who forget a password are fine: the owner sets them a new one from
 * Settings → Staff. Nobody can do that for the owner. Password reset by email
 * needs both a configured mail provider and an email address on the account,
 * and SMS in India needs DLT registration — so on a shop running without any
 * of that, a forgotten owner password would otherwise mean the business is
 * locked out of its own books permanently.
 *
 * This is deliberately a command rather than a screen. Anyone who can run it
 * already holds the database connection string, which means they can already
 * do anything at all; it grants no access that was not there. Putting the same
 * power behind an HTTP endpoint would.
 */
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/lib/password.js';

function fail(message: string, hint?: string): never {
  console.error(`\n✖ ${message}`);
  if (hint) console.error(`  ${hint}`);
  console.error('');
  process.exit(1);
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const identifier = arg('user');
  const password = arg('password') ?? process.env.NEW_PASSWORD;

  if (!identifier) {
    fail(
      'Give the account to reset.',
      'Its phone number or email:  --user 9876500001',
    );
  }
  if (!password || password.length < 10) {
    fail(
      'Give a new password of at least 10 characters.',
      '  --password "…"   (or set NEW_PASSWORD)',
    );
  }

  const prisma = new PrismaClient();

  try {
    // Matched the same way the login screen matches it, so whatever the person
    // types to sign in is what they type here.
    const isEmail = identifier.includes('@');
    const phone = identifier.replace(/[\s-]/g, '').replace(/^(\+91|0091|91|0)/, '');

    const users = await prisma.user.findMany({
      where: isEmail ? { email: { equals: identifier, mode: 'insensitive' } } : { phone },
      include: { business: { select: { legalName: true, gstin: true } } },
    });

    if (users.length === 0) fail(`No account matches "${identifier}".`);
    if (users.length > 1) {
      // The same phone can exist in two shops; the unique constraint is per
      // business. Refuse rather than guess which one was meant.
      fail(
        `"${identifier}" matches ${users.length} accounts, in: ` +
          users.map((u) => u.business.legalName).join(', '),
        'Use the email address instead, or run this against one shop at a time.',
      );
    }

    const user = users[0]!;
    console.log(`▸ ${user.fullName} — ${user.role} at ${user.business.legalName}`);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashPassword(password),
        // Every existing session dies with the old password. If the reason for
        // running this is that somebody else knows it, leaving their session
        // alive would defeat the whole exercise.
        tokenVersion: { increment: 1 },
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });

    await prisma.session.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'PASSWORD_CHANGED' },
    });

    await prisma.auditLog.create({
      data: {
        businessId: user.businessId,
        userId: user.id,
        action: 'user.password_set_by_cli',
        entityType: 'User',
        entityId: user.id,
        // No trace of the password itself, here or anywhere.
        after: { by: 'scripts/set-password.ts' },
      },
    });

    console.log(`\n✔ Password set. Signed out of every device.`);
    console.log(`  Sign in as ${user.email ?? user.phone}.`);
  } finally {
    await prisma.$disconnect();
  }
}

void main();
