import { PrismaClient } from '@prisma/client';

/**
 * Build the MySQL connection URL from DB_HOST, DB_PORT, DB_NAME, DB_USER and
 * DB_PASSWORD. Returns null when the database is not configured.
 */
export function buildDatabaseUrl(env = process.env) {
  const host = (env.DB_HOST || '').trim();
  const name = (env.DB_NAME || '').trim();
  const user = (env.DB_USER || '').trim();
  if (!host || !name || !user) {
    return null;
  }

  const port = (env.DB_PORT || '3306').trim();
  const password = env.DB_PASSWORD || '';
  return `mysql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(name)}`;
}

export function isDatabaseConfigured() {
  return buildDatabaseUrl() !== null;
}

let prisma = null;

/**
 * Shared PrismaClient (lazy). Returns null when DB_* is not configured.
 */
export function getPrisma() {
  if (prisma) {
    return prisma;
  }

  const url = buildDatabaseUrl();
  if (!url) {
    return null;
  }

  prisma = new PrismaClient({ datasourceUrl: url });
  return prisma;
}

export async function disconnectPrisma() {
  if (!prisma) {
    return;
  }
  const client = prisma;
  prisma = null;
  await client.$disconnect();
}
