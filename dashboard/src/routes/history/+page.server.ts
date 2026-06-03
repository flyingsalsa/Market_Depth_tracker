import { query } from '$lib/server/db';
import { listMarkets } from '$lib/server/markets';
import type { PageServerLoad } from './$types';

interface MetricRow {
  bucket_ts: Date;
  mid: string | null;
  spread_bps: string | null;
}

interface ExcludedRow {
  bucket_ts: Date;
  excluded_seconds: string;
}

export const load: PageServerLoad = async ({ url, depends }) => {
  // Lets the page poll just this loader (invalidate('mm:history')) for a live
  // 1-second refresh without a full navigation.
  depends('mm:history');
  const markets = await listMarkets();
  // Default to the first market that actually has data, so a fresh visit
  // lands on something real instead of hyperliquid_perp / BTC (which may be
  // empty). Explicit ?venue / ?symbol params always win.
  const fallback = markets[0] ?? { venue: 'hyperliquid_perp', symbol: 'BTC' };
  const venue  = url.searchParams.get('venue')  ?? fallback.venue;
  const symbol = url.searchParams.get('symbol') ?? fallback.symbol;
  const hours  = Number(url.searchParams.get('hours') ?? '1');
  const safeHours = Math.min(Math.max(hours, 0.0833), 168); // 5 min .. 7 days

  // Use the 1s continuous aggregate so the dashboard stays cheap regardless
  // of window length.
  const metrics = await query<MetricRow>(
    `SELECT bucket_ts, mid::text AS mid, spread_bps::text AS spread_bps
       FROM book_metrics_1s
      WHERE venue = $1 AND symbol = $2
        AND bucket_ts >= now() - ($3 || ' hours')::interval
      ORDER BY bucket_ts ASC`,
    [venue, symbol, String(safeHours)],
  );

  // Per-minute excluded seconds, derived from venue_health.
  const excluded = await query<ExcludedRow>(
    `SELECT time_bucket('1 minute', local_ts) AS bucket_ts,
            (sum(CASE WHEN NOT ws_connected OR last_msg_age_ms > 2000
                      THEN 1 ELSE 0 END)::numeric
              * 0.1)::text AS excluded_seconds   -- 100 ms buckets -> seconds
       FROM venue_health
      WHERE venue = $1 AND symbol = $2
        AND local_ts >= now() - ($3 || ' hours')::interval
      GROUP BY 1
      ORDER BY 1 ASC`,
    [venue, symbol, String(safeHours)],
  );

  return {
    venue, symbol, hours: safeHours,
    metrics: metrics.rows, excluded: excluded.rows,
    markets,
  };
};
