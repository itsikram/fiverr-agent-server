import { getPrisma, disconnectPrisma, isDatabaseConfigured } from '../db/prisma.js';
import { createStore } from '../db/store.js';

let connected = false;
let store = null;

/**
 * Connect to MySQL using Prisma
 */
export async function connectDatabase() {
  if (!isDatabaseConfigured()) {
    console.warn('[Database] ⚠️  MySQL is not configured');
    console.warn('[Database] ⚠️  To fix: Set DB_HOST, DB_PORT, DB_NAME, DB_USER and DB_PASSWORD in your .env file');
    return false;
  }

  try {
    await getPrisma().$connect();
    connected = true;
    console.log('[Database] ✓ Connected to MySQL successfully');
    return true;
  } catch (error) {
    connected = false;
    console.warn('[Database] ⚠️  MySQL connection failed:', error.message);
    console.warn('[Database] ⚠️  Server will start without database connection');
    return false;
  }
}

/**
 * Disconnect from MySQL
 */
export async function disconnectDatabase() {
  try {
    await disconnectPrisma();
    connected = false;
    store = null;
    console.log('[Database] Disconnected from MySQL');
  } catch (error) {
    console.error('[Database] Disconnect error:', error.message);
  }
}

/**
 * Check database connection status
 */
export function isDatabaseConnected() {
  return connected;
}

/**
 * Replace the store (tests use an in-memory one). Pass null to reset.
 */
export function setStore(nextStore) {
  store = nextStore;
}

/**
 * Data store backed by the shared PrismaClient.
 * Throws when the database is not configured so callers return a 500.
 */
export function getStore() {
  if (store) {
    return store;
  }
  const prisma = getPrisma();
  if (!prisma) {
    throw new Error('Database is not configured');
  }
  store = createStore(prisma);
  return store;
}
