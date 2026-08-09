import { PrismaClient } from '@prisma/client';

/**
 * Single shared Prisma client. Next.js dev mode reloads modules on every edit,
 * so without the global cache we would leak a connection pool per reload and
 * eventually exhaust SQLite's locks mid-draft.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export default prisma;
