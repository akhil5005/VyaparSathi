/**
 * Integration test runner.
 *
 * Boots a real PostgreSQL cluster (embedded-postgres downloads genuine Postgres
 * binaries into node_modules — no Docker, no system install, no admin rights),
 * pushes the Prisma schema into it, then runs the `.itest.ts` files against it
 * in a child process.
 *
 * Why a real Postgres and not a WASM stand-in like PGlite: half of what these
 * tests exist to prove is *concurrency* — that invoice numbering serialises
 * under a row lock, that two payments to one customer can't double-allocate.
 * A single-connection emulator cannot demonstrate any of that.
 *
 * Why one cluster for the whole run, spawned once here rather than per test
 * file: `node --test` runs each file in its own process, so booting Postgres
 * inside the tests would pay the startup cost per file. Here it is paid once.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import EmbeddedPostgres from 'embedded-postgres';

const PORT = Number(process.env.ITEST_PG_PORT ?? 55433);
const DB_NAME = 'gstcal_itest';
const USER = 'postgres';
const PASSWORD = 'postgres';

// Kept outside the repo so a stray cluster never lands in a commit, and outside
// the project tree so file watchers don't try to index it.
//
// Keyed by port so a cluster leaked by a killed run can never block a fresh
// one: Postgres refuses to start over a data directory whose shared memory
// block is still attached ("pre-existing shared memory block is still in use"),
// and on Windows the orphan's open file handles also defeat the rmSync below.
// Overriding ITEST_PG_PORT therefore gets you a completely independent cluster,
// which is the escape hatch when a previous run has leaked one.
const dataDir =
  process.env.ITEST_PG_DATADIR ?? path.join(os.tmpdir(), `gstcal-itest-pgdata-${PORT}`);

const DATABASE_URL = `postgresql://${USER}:${PASSWORD}@localhost:${PORT}/${DB_NAME}?schema=public`;

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env,
      shell: process.platform === 'win32',
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function main() {
  // A cluster left behind by a crashed run cannot be reused — initialise()
  // refuses a non-empty directory, and the old one may be mid-schema.
  if (fs.existsSync(dataDir)) {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: USER,
    password: PASSWORD,
    port: PORT,
    persistent: false,
  });

  let started = false;
  let exitCode = 1;

  try {
    process.stdout.write('▸ initialising postgres cluster…\n');
    await pg.initialise();

    process.stdout.write(`▸ starting postgres on port ${PORT}…\n`);
    await pg.start();
    started = true;

    await pg.createDatabase(DB_NAME);
    process.stdout.write(`▸ database "${DB_NAME}" ready\n`);

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL,
      NODE_ENV: 'test',
      // env.ts validates these at boot; integration tests never mint a real
      // token but the schema still demands something long enough.
      JWT_ACCESS_SECRET:
        process.env.JWT_ACCESS_SECRET ?? 'integration-test-access-secret-not-for-production-use',
      JWT_REFRESH_SECRET:
        process.env.JWT_REFRESH_SECRET ?? 'integration-test-refresh-secret-not-for-production-use',
    };

    // `migrate deploy`, not `db push`: this is what runs against production, so
    // running it here means every integration test doubles as a check that the
    // committed migration actually produces the schema the code expects. A
    // `db push` would build the schema straight from the datamodel and happily
    // pass even if the migration were broken or missing.
    process.stdout.write('▸ applying migrations…\n');
    const migrateCode = await run('npx', ['prisma', 'migrate', 'deploy'], childEnv);
    if (migrateCode !== 0) throw new Error(`prisma migrate deploy failed with code ${migrateCode}`);

    process.stdout.write('▸ running integration tests\n\n');
    exitCode = await run(
      'node',
      [
        '--import',
        'tsx',
        '--test',
        // Serial: the tests share one database and truncate between cases, so
        // running files in parallel would have them wiping each other's rows.
        '--test-concurrency=1',
        'src/**/*.itest.ts',
      ],
      childEnv,
    );
  } catch (error) {
    console.error('\n✖ integration harness failed:', error);
    if (String(error).includes('shared memory block is still in use')) {
      console.error(
        `\n  A Postgres cluster leaked by an earlier run is still attached to ${dataDir}.\n` +
          `  Either stop it, or run against a fresh one:  ITEST_PG_PORT=55434 npm run test:integration\n`,
      );
    }
    exitCode = 1;
  } finally {
    if (started) {
      process.stdout.write('\n▸ stopping postgres…\n');
      await pg.stop().catch((e) => console.error('  (failed to stop cleanly)', e));
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  process.exit(exitCode);
}

void main();
