import { PrismaClient } from '@prisma/client';
import { isProduction } from '../config/env.js';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: isProduction ? ['warn', 'error'] : ['warn', 'error'],
  });

// tsx watch reloads the module on every save; without this we leak a connection
// pool per reload and exhaust Postgres in about a minute.
if (!isProduction) globalForPrisma.prisma = prisma;
