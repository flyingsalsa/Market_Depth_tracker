import { query } from '$lib/server/db';
import { listMarkets } from '$lib/server/markets';
import type { PageServerLoad } from './$types';

// The dashboard re-implements the SLA evaluator instead of importing from
// ../../sla to keep package boundaries clean for the MVP. The two
// implementations MUST stay in sync; they are both small. A follow-up step
// is to extract a shared `mm-core` package and depend on it from both
// services so this duplication goes away.

interface MetricRow {
  bucket_ts: Date;
  spread_bps: string | null;
  depth_bid: string[] | null;
  depth_ask: string[] | null;
  depth_bps: string[] | null;
}

interface HealthBucket {
  bucket_ts: Date;
  ws_connected: boolean;
  last_msg_age_ms: number;
}

interface PresenceBucket {
  bucket_ts: Date;
  bid_present: boolean;
  ask_present: boolean;
}

export interface ReportResult {
  params: {
    venue: string;
    symbol: string;
    hours: number;
    maxSpreadBps: number;
    minDepth: number;
    depthAtBps: number;
    bucketMs: number;
    healthStaleMs: number;
    trackedAddress: string | null;
    presenceBothSides: boolean;
    start: string;
    end: string;
  };
  totalBuckets: number;
  evaluatedBuckets: number;
  excludedBuckets: number;
  excludedFraction: number;
  spreadCompliance: number;
  spreadBreaches: number;
  depthCompliance: number;
  depthBreaches: number;
  presenceCompliance: number | null;
  presenceBreaches: number;
}

export const load: PageServerLoad = async ({ url }) => {
  const markets = await listMarkets();
  // Default to the first market that actually has data so a fresh visit lands
  // on something real. Explicit ?venue / ?symbol params always win.
  const fallback = markets[0] ?? { venue: 'hyperliquid_perp', symbol: 'BTC' };
  const params = {
    venue: url.searchParams.get('venue') ?? fallback.venue,
    symbol: url.searchParams.get('symbol') ?? fallback.symbol,
    hours: Number(url.searchParams.get('hours') ?? '1'),
    maxSpreadBps: Number(url.searchParams.get('max-spread-bps') ?? '5'),
    minDepth: Number(url.searchParams.get('min-depth') ?? '0'),
    depthAtBps: Number(url.searchParams.get('depth-at-bps') ?? '10'),
    bucketMs: Number(url.searchParams.get('bucket-ms') ?? '100'),
    healthStaleMs: Number(url.searchParams.get('health-stale-ms') ?? '2000'),
    trackedAddress: (url.searchParams.get('address') ?? '').trim().toLowerCase() || null,
    presenceBothSides: (url.searchParams.get('presence-both-sides') ?? 'true') !== 'false',
  };

  const rawEnd = new Date();
  const rawStart = new Date(rawEnd.getTime() - params.hours * 3600_000);
  // Align to bucket boundaries so this JS-side bucket walk matches the
  // epoch-aligned grid produced by ingestor writes and Postgres time_bucket.
  const startMs = Math.floor(rawStart.getTime() / params.bucketMs) * params.bucketMs;
  const endMs   = Math.floor(rawEnd.getTime()   / params.bucketMs) * params.bucketMs;
  const start = new Date(startMs);
  const end   = new Date(endMs);

  const metrics = await query<MetricRow>(
    `SELECT bucket_ts, spread_bps, depth_bid, depth_ask, depth_bps
       FROM book_metrics_100ms
      WHERE venue = $1 AND symbol = $2
        AND bucket_ts >= $3 AND bucket_ts < $4
      ORDER BY bucket_ts ASC`,
    [params.venue, params.symbol, start, end],
  );

  const health = await query<HealthBucket>(
    `SELECT time_bucket($5::interval, local_ts) AS bucket_ts,
            bool_and(ws_connected)   AS ws_connected,
            max(last_msg_age_ms)     AS last_msg_age_ms
       FROM venue_health
      WHERE venue = $1 AND symbol = $2
        AND local_ts >= $3 AND local_ts < $4
      GROUP BY 1`,
    [params.venue, params.symbol, start, end, `${params.bucketMs} milliseconds`],
  );

  let presenceRows: PresenceBucket[] = [];
  if (params.trackedAddress) {
    const pres = await query<PresenceBucket>(
      `SELECT bucket_ts, bid_present, ask_present
         FROM mm_presence_100ms
        WHERE venue = $1 AND symbol = $2 AND address = $3
          AND bucket_ts >= $4 AND bucket_ts < $5`,
      [params.venue, params.symbol, params.trackedAddress, start, end],
    );
    presenceRows = pres.rows;
  }

  const healthMap = new Map<number, HealthBucket>();
  for (const h of health.rows) healthMap.set(h.bucket_ts.getTime(), h);
  const metricMap = new Map<number, MetricRow>();
  for (const m of metrics.rows) metricMap.set(m.bucket_ts.getTime(), m);
  const presenceMap = new Map<number, PresenceBucket>();
  for (const p of presenceRows) presenceMap.set(p.bucket_ts.getTime(), p);

  const totalBuckets = Math.max(0, Math.floor((endMs - startMs) / params.bucketMs));
  let excluded = 0, evaluated = 0;
  let spreadBreaches = 0, depthBreaches = 0, presenceBreaches = 0;
  let evaluatedPresence = 0;

  for (let bts = startMs; bts < endMs; bts += params.bucketMs) {
    const h = healthMap.get(bts);
    if (!h || !h.ws_connected || h.last_msg_age_ms > params.healthStaleMs) { excluded += 1; continue; }
    const m = metricMap.get(bts);
    if (!m) { excluded += 1; continue; }
    evaluated += 1;

    const spread = m.spread_bps !== null ? Number(m.spread_bps) : null;
    if (spread === null || spread > params.maxSpreadBps) spreadBreaches += 1;

    let idx = -1;
    if (m.depth_bps) {
      for (let i = 0; i < m.depth_bps.length; i++) {
        if (Number(m.depth_bps[i]) === params.depthAtBps) { idx = i; break; }
      }
    }
    if (idx === -1) {
      depthBreaches += 1;
    } else {
      const bid = Number(m.depth_bid?.[idx] ?? 0);
      const ask = Number(m.depth_ask?.[idx] ?? 0);
      if (bid < params.minDepth || ask < params.minDepth) depthBreaches += 1;
    }

    if (params.trackedAddress) {
      evaluatedPresence += 1;
      const p = presenceMap.get(bts);
      if (!p) {
        presenceBreaches += 1;
      } else {
        const ok = params.presenceBothSides
          ? (p.bid_present && p.ask_present)
          : (p.bid_present || p.ask_present);
        if (!ok) presenceBreaches += 1;
      }
    }
  }

  const result: ReportResult = {
    params: { ...params, start: start.toISOString(), end: end.toISOString() },
    totalBuckets,
    evaluatedBuckets: evaluated,
    excludedBuckets: excluded,
    excludedFraction: totalBuckets === 0 ? 0 : excluded / totalBuckets,
    spreadCompliance: evaluated === 0 ? 0 : (evaluated - spreadBreaches) / evaluated,
    spreadBreaches,
    depthCompliance: evaluated === 0 ? 0 : (evaluated - depthBreaches) / evaluated,
    depthBreaches,
    presenceCompliance: params.trackedAddress === null
      ? null
      : (evaluatedPresence === 0 ? 0 : (evaluatedPresence - presenceBreaches) / evaluatedPresence),
    presenceBreaches,
  };

  return { result, markets };
};
