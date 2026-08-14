/**
 * Restores a backup file into a database.
 *
 *   DATABASE_URL="postgresql://…" npx tsx scripts/restore-backup.ts \
 *     ./vyapar-sathi-backup-03AABCM1234C1ZD-2026-08-13.json \
 *     --owner-password "a new password"
 *
 * A thin command line over `src/modules/backup/restore.ts`, which is where the
 * rules and the tests live. Worth running once against a scratch database
 * before it is ever needed for real — an untested backup is a hope.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { parseBackup, restoreBackup, RestoreError } from '../src/modules/backup/restore.js';

function fail(message: string, hint?: string): never {
  console.error(`\n✖ ${message}`);
  if (hint) console.error(`  ${hint}`);
  console.error('');
  process.exit(1);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const file = args.find((arg) => !arg.startsWith('--'));
  const flagIndex = args.indexOf('--owner-password');
  const ownerPassword =
    flagIndex >= 0 ? args[flagIndex + 1] : process.env.RESTORE_OWNER_PASSWORD;

  if (!file) fail('Give the path to a backup file.');
  if (!ownerPassword) {
    fail(
      'Give a new owner password.',
      'The backup carries no password hashes on purpose, so the restored shop needs one:\n' +
        '    --owner-password "…"   (or set RESTORE_OWNER_PASSWORD)',
    );
  }

  return { file: path.resolve(file), ownerPassword };
}

async function main() {
  const { file, ownerPassword } = parseArgs();
  if (!fs.existsSync(file)) fail(`No such file: ${file}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`That file is not valid JSON (${(error as Error).message}).`);
  }

  const prisma = new PrismaClient();

  try {
    const backup = parseBackup(parsed);
    console.log(`▸ backup written ${backup.exportedAt}`);

    const result = await restoreBackup(prisma, backup, {
      ownerPassword,
      onProgress: (section, count) => console.log(`  ${String(count).padStart(7)}  ${section}`),
    });

    console.log(`\n✔ Restored ${result.legalName}.`);
    if (result.ownerIdentifier) {
      console.log(`  Sign in as ${result.ownerIdentifier} with the password you just set.`);
      console.log('  Other staff have no password yet — set one from Settings → Staff.');
    } else {
      console.warn('  ⚠ No owner user in that backup, so nobody can sign in to this shop.');
    }
  } catch (error) {
    if (error instanceof RestoreError) fail(error.message, error.hint);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
