#!/usr/bin/env node
/**
 * Apply pending Prisma migrations before the server starts (`prestart`).
 * Skips when DB_* is not configured and never blocks startup: a failure is
 * logged and the server still boots.
 */
import '../src/config/env.js';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { buildDatabaseUrl } from '../src/db/prisma.js';

const url = buildDatabaseUrl();
if (!url) {
  console.warn('[Migrate] DB_* not set - skipping migrations');
  process.exit(0);
}

const require = createRequire(import.meta.url);
const prismaCli = require.resolve('prisma/build/index.js');

const result = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: url },
});
if (result.status !== 0) {
  console.error('[Migrate] prisma migrate deploy failed - starting server anyway');
}
process.exit(0);
