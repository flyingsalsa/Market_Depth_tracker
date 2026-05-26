import pg from 'pg';
import { config } from './config.js';

// Hyperliquid sizes/prices are decimals that fit comfortably in JS numbers for
// the bucketing math we do, but pg returns NUMERIC as string by default to
// avoid precision loss. We leave that default in place; conversion to number
// only happens at the metric layer.

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on('error', err => {
  console.error('pg pool error', err);
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as unknown[]);
}

export async function close(): Promise<void> {
  await pool.end();
}
