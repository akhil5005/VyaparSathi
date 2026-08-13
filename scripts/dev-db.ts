/**
 * A development Postgres, with no Docker and no system install.
 *
 * Same `embedded-postgres` binaries the integration harness uses, but
 * **persistent** — the data directory survives restarts, so the shop you
 * registered yesterday is still there today. The test harness deliberately
 * throws its cluster away; this one must not.
 *
 *   npm run dev:db      # leave running in one terminal
 *   npm run dev         # the API, in another
 *
 * Stops cleanly on Ctrl+C. If it is killed harder than that, Postgres will
 * refuse to restart over its own shared memory — `npm run dev:db -- --reset`
 * wipes the directory and starts fresh, losing the data.
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import EmbeddedPostgres from 'embedded-postgres';

const PORT = Number(process.env.DEV_PG_PORT ?? 55432);
const DB_NAME = 'gstcal_dev';
const USER = 'postgres';
const PASSWORD = 'postgres';

// Outside the repo so a stray cluster never lands in a commit, and outside the
// project tree so the file watcher doesn't try to index it.
const dataDir = path.join(os.tmpdir(), `gstcal-dev-pgdata-${PORT}`);

const DATABASE_URL = `postgresql://${USER}:${PASSWORD}@localhost:${PORT}/${DB_NAME}?schema=public`;

async function main() {
  const reset = process.argv.includes('--reset');

  if (reset && fs.existsSync(dataDir)) {
    process.stdout.write(`▸ wiping ${dataDir}\n`);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  const firstRun = !fs.existsSync(dataDir);

  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: USER,
    password: PASSWORD,
    port: PORT,
    persistent: true,
  });

  if (firstRun) {
    process.stdout.write('▸ initialising the development cluster (first run only)…\n');
    await pg.initialise();
  }

  process.stdout.write(`▸ starting postgres on port ${PORT}…\n`);
  await pg.start();

  if (firstRun) {
    await pg.createDatabase(DB_NAME);
    process.stdout.write(`▸ created database "${DB_NAME}"\n`);
  }

  process.stdout.write(
    [
      '',
      '  Postgres is up. Put this in .env:',
      '',
      `    DATABASE_URL="${DATABASE_URL}"`,
      '',
      '  Then, in another terminal:',
      '',
      '    npm run prisma:deploy    # once, to create the tables',
      '    npm run dev              # the API on :4000',
      '    npm run web              # the frontend on :5173',
      '',
      '  Ctrl+C here to stop the database.',
      '',
    ].join('\n'),
  );

  // Without this the process exits immediately and takes the cluster with it.
  const stop = async (signal: string) => {
    process.stdout.write(`\n▸ ${signal} — stopping postgres…\n`);
    try {
      await pg.stop();
    } catch (error) {
      console.error('  (failed to stop cleanly)', error);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));

  // Keep the event loop alive.
  setInterval(() => {}, 1 << 30);
}

main().catch((error) => {
  console.error('\n✖ could not start the development database:', error);
  if (String(error).includes('shared memory')) {
    console.error(
      '\n  A cluster from a previous run is still attached. Either stop it, or\n' +
        '  start over with:  npm run dev:db -- --reset   (this deletes the data)\n',
    );
  }
  process.exit(1);
});
