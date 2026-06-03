import { query } from '$lib/server/db';
import type { PageServerLoad } from './$types';

interface SymbolRow {
  venue: string;
  symbol: string;
  best_bid: string | null;
  best_ask: string | null;
  mid: string | null;
  spread_bps: string | null;
  depth_bps: string[] | null;
  depth_bid: string[] | null;
  depth_ask: string[] | null;
  bucket_ts: Date;
}

interface HealthRow {
  venue: string;
  symbol: string;
  ws_connected: boolean;
  last_msg_age_ms: number;
  book_state: string;
  local_ts: Date;
}

interface PresenceRow {
  venue: string;
  symbol: string;
  address: string;
  bid_present: boolean;
  ask_present: boolean;
  bid_distance_bps: string | null;
  ask_distance_bps: string | null;
  bucket_ts: Date;
}

export const load: PageServerLoad = async () => {
  // Latest metric row per (venue, symbol). We previously filtered on
  // venue='hyperliquid', but the ingestor now writes multiple venue tags
  // (hyperliquid_perp, hyperliquid_spot, hyperliquid_perp_<suffix>) so the
  // dashboard simply shows whatever it finds.
  const symbols = await query<SymbolRow>(`
    SELECT DISTINCT ON (venue, symbol)
      venue, symbol, best_bid, best_ask, mid, spread_bps,
      depth_bps, depth_bid, depth_ask, bucket_ts
    FROM book_metrics_100ms
    WHERE bucket_ts > now() - interval '5 minutes'
    ORDER BY venue, symbol, bucket_ts DESC
  `);

  const health = await query<HealthRow>(`
    SELECT DISTINCT ON (venue, symbol)
      venue, symbol, ws_connected, last_msg_age_ms, book_state, local_ts
    FROM venue_health
    WHERE local_ts > now() - interval '5 minutes'
    ORDER BY venue, symbol, local_ts DESC
  `);

  const presence = await query<PresenceRow>(`
    SELECT DISTINCT ON (venue, symbol, address)
      venue, symbol, address, bid_present, ask_present,
      bid_distance_bps, ask_distance_bps, bucket_ts
    FROM mm_presence_100ms
    WHERE bucket_ts > now() - interval '5 minutes'
    ORDER BY venue, symbol, address, bucket_ts DESC
  `);

  return {
    symbols: symbols.rows,
    health:  health.rows,
    presence: presence.rows,
  };
};
