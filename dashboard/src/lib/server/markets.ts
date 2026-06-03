import { query } from '$lib/server/db';

export interface Market {
  venue: string;
  symbol: string;
}

// Distinct (venue, symbol) pairs that have produced book metrics recently.
// Backs the market dropdown on the History and Report tabs so operators can
// pick e.g. hyperliquid_spot / BASED/USDC instead of typing it by hand. We
// look back 7 days (the max History window) off the cheap 1s aggregate.
export async function listMarkets(): Promise<Market[]> {
  const res = await query<Market>(`
    SELECT DISTINCT venue, symbol
      FROM book_metrics_1s
     WHERE bucket_ts > now() - interval '7 days'
     ORDER BY venue, symbol
  `);
  return res.rows;
}
