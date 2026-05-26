import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './logger.js';
import { pool, close } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '..', '..', 'db', 'migrations');

async function main(): Promise<void> {
  log.info('Loading migrations', { dir: migrationsDir });
  const files = (await readdir(migrationsDir))
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const f of files) {
    const sql = await readFile(join(migrationsDir, f), 'utf8');
    log.info(`Applying ${f}`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  log.info('All migrations applied');
}

main()
  .catch(err => {
    log.error('Migration failed', { error: String(err) });
    process.exitCode = 1;
  })
  .finally(() => close());
