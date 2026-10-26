#!/usr/bin/env node
/**
 * Run the Prisma CLI with DATABASE_URL built from DB_HOST, DB_PORT, DB_NAME,
 * DB_USER and DB_PASSWORD.
 *
 * Usage: node scripts/prisma.js <prisma args>   e.g. `db push`, `migrate deploy`
 */
import '../src/config/env.js';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { buildDatabaseUrl } from '../src/db/prisma.js';

const args = process.argv.slice(2);
const url = buildDatabaseUrl();

// `prisma generate` and `prisma validate` don't connect, so a placeholder is fine.
const offline = ['generate', 'validate', 'format'].includes(args[0]);
if (!url && !offline) {
  console.error('[Prisma] Set DB_HOST, DB_PORT, DB_NAME, DB_USER and DB_PASSWORD first');
  process.exit(1);
}

const require = createRequire(import.meta.url);
const prismaCli = require.resolve('prisma/build/index.js');

const result = spawnSync(process.execPath, [prismaCli, ...args], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: url || 'mysql://user:password@localhost:3306/db' },
});
process.exit(result.status ?? 1);
