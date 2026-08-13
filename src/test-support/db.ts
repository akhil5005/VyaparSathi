import { prisma } from '../lib/prisma.js';

/**
 * Shared database helpers for integration tests.
 *
 * The cluster is booted by `scripts/run-integration-tests.ts` and reached
 * through the DATABASE_URL it puts in the environment — these helpers only
 * manage state *within* it.
 */

let cachedTables: string[] | null = null;

async function tableNames(): Promise<string[]> {
  if (cachedTables) return cachedTables;
  const rows = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%'
  `;
  cachedTables = rows.map((r) => `"public"."${r.tablename}"`);
  return cachedTables;
}

/**
 * Wipes every table between tests.
 *
 * One TRUNCATE across all tables with CASCADE, rather than per-table deletes in
 * dependency order — it is faster and immune to the foreign-key ordering
 * problems that make hand-written teardown so brittle.
 */
export async function resetDatabase(): Promise<void> {
  const tables = await tableNames();
  if (tables.length === 0) return;
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
}

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}

export { prisma };
