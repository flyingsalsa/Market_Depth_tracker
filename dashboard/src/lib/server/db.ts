import { config as dotenvConfig } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// dashboard/src/lib/server -> project root is four levels up.
const here = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(here, '..', '..', '..', '..', '.env') });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('Missing DATABASE_URL (set it in the project .env)');
}

export const pool = new pg.Pool({ connectionString: databaseUrl, max: 6 });

pool.on('error', err => {
  console.error('pg pool error', err);
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as unknown[]);
}
