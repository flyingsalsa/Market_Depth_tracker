import { log } from './logger.js';
import { computeBookMetrics, computePresence, type BookMetrics } from './metrics.js';
import type { HlBookLevel } from './hyperliquid/types.js';
import type { Writer } from './writer.js';

type BookState = 'LIVE' | 'SNAPSHOT' | 'RESYNCING' | 'GAP_DETECTED' | 'DISCONNECTED';

interface SymbolBucketAccumulator {
  sampleCount: number;
  // Most recent metrics observed in the bucket. We keep "last in bucket"
  // semantics because the source data is already a stream of snapshots:
  // averaging snapshots does not have a meaningful physical interpretation,
  // whereas "the book at the close of the bucket" does.
  last: BookMetrics | null;
}

/**
 * Per-market state. Owns the latest book, the current bucket accumulator,
 * and the MM open-orders view used by presence metrics.
 *
 * Each instance carries its own `venue` so a single ingestor can monitor
 * Hyperliquid perps, spot, and alt-dex perps in parallel — the venue tag is
 * propagated all the way to the database row.
 *
 * This class is the place where the dual policy "venue-reported time is
 * audit-only, local_ts is the analytics clock" is enforced: every metric
 * row we write is keyed on a 100 ms wall-clock bucket derived from
 * `Date.now()`, never from the venue timestamp.
 */
export class SymbolState {
  private latestMid: number | null = null;
  private latestBids: HlBookLevel[] = [];
  private latestAsks: HlBookLevel[] = [];

  // Per-address open-order maps: orderId -> [side, price, size]
  private mmOrders = new Map<string, Map<string, { side: 'buy' | 'sell'; price: number; size: number }>>();

  private bucket: SymbolBucketAccumulator = { sampleCount: 0, last: null };
  private currentBucketTs: number = 0;
  private bookState: BookState = 'DISCONNECTED';

  constructor(
    public readonly venue: string,
    public readonly symbol: string,
    private readonly writer: Writer,
    private readonly bucketMs: number,
    private readonly depthBps: number[],
    private readonly trackedAddresses: string[],
    private readonly nearTouchBps: number,
  ) {
    this.currentBucketTs = this.bucketStart(Date.now());
    for (const a of trackedAddresses) this.mmOrders.set(a, new Map());
  }

  onConnectionState(state: BookState): void {
    this.bookState = state;
  }

  applyL2Snapshot(bids: HlBookLevel[], asks: HlBookLevel[], firstAfterReconnect: boolean): void {
    this.latestBids = bids;
    this.latestAsks = asks;
    if (firstAfterReconnect) {
      this.bookState = 'SNAPSHOT';
    } else if (this.bookState !== 'LIVE') {
      this.bookState = 'LIVE';
    }
    const m = computeBookMetrics(bids, asks, this.depthBps);
    this.latestMid = m.mid;
    this.observeBookMetrics(m);
  }

  applyOrderUpdate(
    address: string,
    orderId: string,
    side: 'buy' | 'sell',
    price: number,
    size: number,
    status: string,
  ): void {
    let map = this.mmOrders.get(address);
    if (!map) { map = new Map(); this.mmOrders.set(address, map); }
    if (status === 'open') {
      map.set(orderId, { side, price, size });
    } else {
      map.delete(orderId);
    }
  }

  /**
   * Called by the main loop every bucket boundary to emit a row even if no
   * data arrived in the bucket, so the metric stream is dense and the SLA
   * evaluator can iterate buckets without a sparse-vs-dense join.
   */
  tick(now: number): void {
    const bucket = this.bucketStart(now);
    if (bucket === this.currentBucketTs) return;
    this.flushBucket(new Date(this.currentBucketTs));
    this.currentBucketTs = bucket;
    this.bucket = { sampleCount: 0, last: this.bucket.last };
  }

  bookStateLabel(): BookState { return this.bookState; }

  private observeBookMetrics(m: BookMetrics): void {
    this.bucket.sampleCount += 1;
    this.bucket.last = m;
  }

  private flushBucket(bucketTs: Date): void {
    const m = this.bucket.last;
    if (m) {
      this.writer.enqueueMetrics({
        bucketTs,
        venue: this.venue,
        symbol: this.symbol,
        metrics: m,
        sampleCount: this.bucket.sampleCount,
      });
    }
    // Always emit presence rows for each tracked address, even when sampleCount
    // is 0, so SLA evaluation has a dense per-address series.
    for (const addr of this.trackedAddresses) {
      const orders = this.mmOrders.get(addr) ?? new Map();
      const bids: Array<[number, number]> = [];
      const asks: Array<[number, number]> = [];
      for (const o of orders.values()) {
        if (o.side === 'buy')  bids.push([o.price, o.size]);
        else                   asks.push([o.price, o.size]);
      }
      const presence = computePresence(this.latestMid, bids, asks, this.nearTouchBps);
      this.writer.enqueuePresence({
        bucketTs,
        venue: this.venue,
        symbol: this.symbol,
        address: addr,
        metrics: presence,
      });
    }
  }

  private bucketStart(t: number): number {
    return Math.floor(t / this.bucketMs) * this.bucketMs;
  }
}

export function bookStateFromConnection(
  wsConnected: boolean,
  lastMsgAgeMs: number,
  staleMs: number,
): BookState {
  if (!wsConnected) return 'DISCONNECTED';
  if (lastMsgAgeMs > staleMs) return 'GAP_DETECTED';
  return 'LIVE';
}

export { log };
