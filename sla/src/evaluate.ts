import { config as dotenvConfig } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(here, '..', '..', '.env') });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Missing DATABASE_URL');

const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });

export interface SlaParams {
  venue:    string;
  symbol:   string;
  start:    Date;
  end:      Date;
  // SLA thresholds:
  maxSpreadBps: number;       // breach if spread > this in a non-excluded bucket
  minDepth:     number;       // breach if both-sided depth < this within depthAtBps
  depthAtBps:   number;       // which depth slot to evaluate (must match an ingestor depth_bps)
  // Address-based SLAs (optional):
  trackedAddress?: string;
  presenceBothSidesRequired?: boolean;
  // Bucket size in ms; must match ingestor's METRIC_BUCKET_MS (default 100).
  bucketMs?: number;
  // Health staleness threshold; buckets above this are excluded.
  healthStaleMs?: number;
}

export interface SlaResult {
  params: SlaParams;
  totalBuckets:    number;
  excludedBuckets: number;
  evaluatedBuckets: number;
  spreadBreaches:  number;
  depthBreaches:   number;
  presenceBreaches: number;
  spreadComplianceFraction: number;   // (evaluated - breaches) / evaluated
  depthComplianceFraction:  number;
  presenceComplianceFraction: number | null;  // null if no tracked address
  excludedFraction:         number;            // excluded / total
}

interface BucketRow {
  bucket_ts: Date;
  spread_bps: string | null;
  depth_bid: string[] | null;
  depth_ask: string[] | null;
  depth_bps: string[] | null;
}

interface HealthRow {
  bucket_ts: Date;
  ws_connected: boolean;
  last_msg_age_ms: number;
  book_state: string;
}

interface PresenceRow {
  bucket_ts: Date;
  bid_present: boolean;
  ask_present: boolean;
}

/**
 * Pure-ish: queries TimescaleDB, then computes the SLA result deterministically
 * from the returned rows. The same inputs (database state + params) always
 * produce the same output, which is what makes this defensible.
 */
export async function evaluateSla(p: SlaParams): Promise<SlaResult> {
  const bucketMs = p.bucketMs ?? 100;
  const healthStaleMs = p.healthStaleMs ?? 2000;

  // Align the window to bucket boundaries (epoch-anchored, matching how the
  // ingestor writes bucket_ts and how Postgres time_bucket() aligns). Without
  // this, the JS-side bucket walk and the DB-side bucket grid drift by up to
  // one bucket and a few percent of evaluation rows would silently miss.
  const alignedStartMs = Math.floor(p.start.getTime() / bucketMs) * bucketMs;
  const alignedEndMs   = Math.floor(p.end.getTime()   / bucketMs) * bucketMs;
  const startAligned = new Date(alignedStartMs);
  const endAligned   = new Date(alignedEndMs);

  const totalBuckets = Math.floor((alignedEndMs - alignedStartMs) / bucketMs);
  if (totalBuckets <= 0) {
    throw new Error('Empty or negative evaluation window');
  }

  const metricsRes = await pool.query<BucketRow>(
    `SELECT bucket_ts, spread_bps, depth_bid, depth_ask, depth_bps
       FROM book_metrics_100ms
      WHERE venue = $1 AND symbol = $2
        AND bucket_ts >= $3 AND bucket_ts < $4
      ORDER BY bucket_ts ASC`,
    [p.venue, p.symbol, startAligned, endAligned],
  );

  // Health is sampled at sub-bucket cadence; we coarsen to the bucket grid
  // by taking the worst (excluded-prone) row per bucket.
  const healthRes = await pool.query<HealthRow>(
    `SELECT time_bucket($5::interval, local_ts) AS bucket_ts,
            bool_and(ws_connected)   AS ws_connected,
            max(last_msg_age_ms)     AS last_msg_age_ms,
            max(book_state)          AS book_state
       FROM venue_health
      WHERE venue = $1 AND symbol = $2
        AND local_ts >= $3 AND local_ts < $4
      GROUP BY 1
      ORDER BY 1 ASC`,
    [p.venue, p.symbol, startAligned, endAligned, `${bucketMs} milliseconds`],
  );

  const healthMap = new Map<number, HealthRow>();
  for (const h of healthRes.rows) healthMap.set(h.bucket_ts.getTime(), h);

  let presenceMap: Map<number, PresenceRow> | null = null;
  if (p.trackedAddress) {
    const presRes = await pool.query<PresenceRow>(
      `SELECT bucket_ts, bid_present, ask_present
         FROM mm_presence_100ms
        WHERE venue = $1 AND symbol = $2 AND address = $3
          AND bucket_ts >= $4 AND bucket_ts < $5
        ORDER BY bucket_ts ASC`,
      [p.venue, p.symbol, p.trackedAddress.toLowerCase(), startAligned, endAligned],
    );
    presenceMap = new Map();
    for (const row of presRes.rows) presenceMap.set(row.bucket_ts.getTime(), row);
  }

  let excludedBuckets = 0;
  let spreadBreaches = 0;
  let depthBreaches = 0;
  let presenceBreaches = 0;
  let evaluatedBuckets = 0;
  let evaluatedPresence = 0;

  // Walk the bucket grid rather than the row set so missing buckets count
  // explicitly as excluded (no data == not evaluated).
  for (let bts = alignedStartMs; bts < alignedEndMs; bts += bucketMs) {
    const h = healthMap.get(bts);
    const excluded = !h || !h.ws_connected || h.last_msg_age_ms > healthStaleMs;
    if (excluded) {
      excludedBuckets += 1;
      continue;
    }
    // We need a metrics row to be considered evaluated; if missing, exclude.
    const m = findRowAtOrBefore(metricsRes.rows, bts, bucketMs);
    if (!m) {
      excludedBuckets += 1;
      continue;
    }
    evaluatedBuckets += 1;

    const spread = m.spread_bps !== null ? Number(m.spread_bps) : null;
    if (spread === null || spread > p.maxSpreadBps) spreadBreaches += 1;

    const idx = findDepthIndex(m.depth_bps, p.depthAtBps);
    if (idx === -1) {
      depthBreaches += 1;
    } else {
      const bid = Number(m.depth_bid?.[idx] ?? 0);
      const ask = Number(m.depth_ask?.[idx] ?? 0);
      if (bid < p.minDepth || ask < p.minDepth) depthBreaches += 1;
    }

    if (presenceMap) {
      const pres = presenceMap.get(bts);
      if (!pres) {
        presenceBreaches += 1;
        evaluatedPresence += 1;
      } else {
        evaluatedPresence += 1;
        const ok = p.presenceBothSidesRequired
          ? (pres.bid_present && pres.ask_present)
          : (pres.bid_present || pres.ask_present);
        if (!ok) presenceBreaches += 1;
      }
    }
  }

  return {
    params: p,
    totalBuckets,
    excludedBuckets,
    evaluatedBuckets,
    spreadBreaches,
    depthBreaches,
    presenceBreaches,
    spreadComplianceFraction: evaluatedBuckets === 0
      ? 0 : (evaluatedBuckets - spreadBreaches) / evaluatedBuckets,
    depthComplianceFraction: evaluatedBuckets === 0
      ? 0 : (evaluatedBuckets - depthBreaches) / evaluatedBuckets,
    presenceComplianceFraction: presenceMap === null
      ? null
      : (evaluatedPresence === 0 ? 0 : (evaluatedPresence - presenceBreaches) / evaluatedPresence),
    excludedFraction: excludedBuckets / totalBuckets,
  };
}

function findRowAtOrBefore(rows: BucketRow[], bts: number, bucketMs: number): BucketRow | null {
  // Rows are ordered ASC. We do a small bounded scan starting from a binary search.
  // For the MVP a linear scan is more than fast enough at 100ms granularity for
  // window sizes up to several hours.
  let lo = 0, hi = rows.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = rows[mid]!.bucket_ts.getTime();
    if (t <= bts) { ans = mid; lo = mid + 1; }
    else          { hi = mid - 1; }
  }
  if (ans < 0) return null;
  const r = rows[ans]!;
  // Only accept rows that fall in the same bucket.
  return (bts - r.bucket_ts.getTime()) < bucketMs ? r : null;
}

function findDepthIndex(arr: string[] | null, target: number): number {
  if (!arr) return -1;
  for (let i = 0; i < arr.length; i++) {
    if (Number(arr[i]) === target) return i;
  }
  return -1;
}

export async function closeSlaPool(): Promise<void> {
  await pool.end();
}
