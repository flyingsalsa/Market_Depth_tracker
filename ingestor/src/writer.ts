import { query } from './db.js';
import { log } from './logger.js';
import type { BookMetrics, PresenceMetrics } from './metrics.js';
import type { HlBookLevel } from './hyperliquid/types.js';

// Every row carries its own `venue` so a single writer instance can serve
// multiple market types (default perps, spot, alt-dex perps) in parallel.
// The classification lives in config.ts (parseMarket); we just store the tag.

interface BookSnapshotRow {
  localTs: Date;
  exchangeTs: Date;
  venue: string;
  symbol: string;
  bids: HlBookLevel[];
  asks: HlBookLevel[];
}

interface BboRow {
  localTs: Date;
  exchangeTs: Date;
  venue: string;
  symbol: string;
  bidPx: number; bidSz: number;
  askPx: number; askSz: number;
}

interface TradeRow {
  localTs: Date;
  exchangeTs: Date;
  venue: string;
  symbol: string;
  side: 'buy' | 'sell';
  price: number;
  size: number;
  // Empty string when the venue did not supply an id; matches the NOT NULL
  // DEFAULT '' on the trade table so the row is still uniquely keyed.
  tradeId: string;
}

interface OrderEventRow {
  localTs: Date;
  exchangeTs: Date;
  venue: string;
  symbol: string;
  address: string;
  orderId: string;
  side: 'buy' | 'sell';
  price: number;
  size: number;
  status: string;
  raw: unknown;
}

interface OpenOrdersRow {
  localTs: Date;
  venue: string;
  symbol: string;
  address: string;
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
}

interface HealthRow {
  localTs: Date;
  venue: string;
  symbol: string;
  wsConnected: boolean;
  lastMsgAgeMs: number;
  bookState: 'LIVE' | 'SNAPSHOT' | 'RESYNCING' | 'GAP_DETECTED' | 'DISCONNECTED';
  note: string | null;
}

interface MetricsRow {
  bucketTs: Date;
  venue: string;
  symbol: string;
  metrics: BookMetrics;
  sampleCount: number;
}

interface PresenceRow {
  bucketTs: Date;
  venue: string;
  symbol: string;
  address: string;
  metrics: PresenceMetrics;
}

/**
 * Batching writer. Buffers rows in memory and flushes them on a fixed timer
 * or when a per-table threshold is exceeded. Each flush is a single INSERT
 * statement so the database side stays cheap.
 */
export class Writer {
  private snapshots: BookSnapshotRow[] = [];
  private bbo: BboRow[] = [];
  private trades: TradeRow[] = [];
  private orderEvents: OrderEventRow[] = [];
  private openOrders: OpenOrdersRow[] = [];
  private health: HealthRow[] = [];
  private metrics: MetricsRow[] = [];
  private presence: PresenceRow[] = [];

  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly flushIntervalMs: number = 500) {}

  start(): void {
    this.timer = setInterval(() => { void this.flush(); }, this.flushIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }

  enqueueSnapshot(r: BookSnapshotRow): void   { this.snapshots.push(r); }
  enqueueBbo(r: BboRow): void                 { this.bbo.push(r); }
  enqueueTrade(r: TradeRow): void             { this.trades.push(r); }
  enqueueOrderEvent(r: OrderEventRow): void   { this.orderEvents.push(r); }
  enqueueOpenOrders(r: OpenOrdersRow): void   { this.openOrders.push(r); }
  enqueueHealth(r: HealthRow): void           { this.health.push(r); }
  enqueueMetrics(r: MetricsRow): void         { this.metrics.push(r); }
  enqueuePresence(r: PresenceRow): void       { this.presence.push(r); }

  private async flush(): Promise<void> {
    try {
      await Promise.all([
        this.flushSnapshots(),
        this.flushBbo(),
        this.flushTrades(),
        this.flushOrderEvents(),
        this.flushOpenOrders(),
        this.flushHealth(),
        this.flushMetrics(),
        this.flushPresence(),
      ]);
    } catch (err) {
      log.error('flush failed', { error: String(err) });
    }
  }

  private async flushSnapshots(): Promise<void> {
    const rows = this.snapshots; if (rows.length === 0) return;
    this.snapshots = [];
    const values: unknown[] = [];
    const placeholders: string[] = [];
    for (const r of rows) {
      const i = values.length;
      placeholders.push(`($${i+1},$${i+2},$${i+3},$${i+4},$${i+5}::jsonb,$${i+6}::jsonb)`);
      values.push(r.localTs, r.exchangeTs, r.venue, r.symbol,
                  JSON.stringify(r.bids), JSON.stringify(r.asks));
    }
    await query(
      `INSERT INTO l2_book_snapshot
         (local_ts, exchange_ts, venue, symbol, bids, asks)
       VALUES ${placeholders.join(',')}
       ON CONFLICT DO NOTHING`,
      values,
    );
  }

  private async flushBbo(): Promise<void> {
    const rows = this.bbo; if (rows.length === 0) return;
    this.bbo = [];
    const values: unknown[] = [];
    const placeholders: string[] = [];
    for (const r of rows) {
      const i = values.length;
      placeholders.push(`($${i+1},$${i+2},$${i+3},$${i+4},$${i+5},$${i+6},$${i+7},$${i+8})`);
      values.push(r.localTs, r.exchangeTs, r.venue, r.symbol,
                  r.bidPx, r.bidSz, r.askPx, r.askSz);
    }
    await query(
      `INSERT INTO bbo
         (local_ts, exchange_ts, venue, symbol, bid_px, bid_sz, ask_px, ask_sz)
       VALUES ${placeholders.join(',')}
       ON CONFLICT DO NOTHING`,
      values,
    );
  }

  private async flushTrades(): Promise<void> {
    const rows = this.trades; if (rows.length === 0) return;
    this.trades = [];
    const values: unknown[] = [];
    const placeholders: string[] = [];
    for (const r of rows) {
      const i = values.length;
      placeholders.push(`($${i+1},$${i+2},$${i+3},$${i+4},$${i+5},$${i+6},$${i+7},$${i+8})`);
      values.push(r.localTs, r.exchangeTs, r.venue, r.symbol,
                  r.side, r.price, r.size, r.tradeId);
    }
    await query(
      `INSERT INTO trade
         (local_ts, exchange_ts, venue, symbol, side, price, size, trade_id)
       VALUES ${placeholders.join(',')}
       ON CONFLICT DO NOTHING`,
      values,
    );
  }

  private async flushOrderEvents(): Promise<void> {
    const rows = this.orderEvents; if (rows.length === 0) return;
    this.orderEvents = [];
    const values: unknown[] = [];
    const placeholders: string[] = [];
    for (const r of rows) {
      const i = values.length;
      placeholders.push(`($${i+1},$${i+2},$${i+3},$${i+4},$${i+5},$${i+6},$${i+7},$${i+8},$${i+9},$${i+10},$${i+11}::jsonb)`);
      values.push(r.localTs, r.exchangeTs, r.venue, r.symbol, r.address,
                  r.orderId, r.side, r.price, r.size, r.status, JSON.stringify(r.raw));
    }
    await query(
      `INSERT INTO mm_order_event
         (local_ts, exchange_ts, venue, symbol, address,
          order_id, side, price, size, status, raw)
       VALUES ${placeholders.join(',')}
       ON CONFLICT DO NOTHING`,
      values,
    );
  }

  private async flushOpenOrders(): Promise<void> {
    const rows = this.openOrders; if (rows.length === 0) return;
    this.openOrders = [];
    const values: unknown[] = [];
    const placeholders: string[] = [];
    for (const r of rows) {
      const i = values.length;
      placeholders.push(`($${i+1},$${i+2},$${i+3},$${i+4},$${i+5}::jsonb,$${i+6}::jsonb)`);
      values.push(r.localTs, r.venue, r.symbol, r.address,
                  JSON.stringify(r.bids), JSON.stringify(r.asks));
    }
    await query(
      `INSERT INTO mm_open_orders
         (local_ts, venue, symbol, address, bids, asks)
       VALUES ${placeholders.join(',')}
       ON CONFLICT DO NOTHING`,
      values,
    );
  }

  private async flushHealth(): Promise<void> {
    const rows = this.health; if (rows.length === 0) return;
    this.health = [];
    const values: unknown[] = [];
    const placeholders: string[] = [];
    for (const r of rows) {
      const i = values.length;
      placeholders.push(`($${i+1},$${i+2},$${i+3},$${i+4},$${i+5},$${i+6},$${i+7})`);
      values.push(r.localTs, r.venue, r.symbol, r.wsConnected,
                  r.lastMsgAgeMs, r.bookState, r.note);
    }
    await query(
      `INSERT INTO venue_health
         (local_ts, venue, symbol, ws_connected, last_msg_age_ms, book_state, note)
       VALUES ${placeholders.join(',')}
       ON CONFLICT DO NOTHING`,
      values,
    );
  }

  private async flushMetrics(): Promise<void> {
    const rows = this.metrics; if (rows.length === 0) return;
    this.metrics = [];
    const values: unknown[] = [];
    const placeholders: string[] = [];
    for (const r of rows) {
      const m = r.metrics;
      const i = values.length;
      placeholders.push(`($${i+1},$${i+2},$${i+3},$${i+4},$${i+5},$${i+6},$${i+7},$${i+8}::numeric[],$${i+9}::numeric[],$${i+10}::numeric[],$${i+11})`);
      values.push(
        r.bucketTs, r.venue, r.symbol,
        m.bestBid, m.bestAsk, m.mid, m.spreadBps,
        m.depthBps, m.depthBid, m.depthAsk,
        r.sampleCount,
      );
    }
    await query(
      `INSERT INTO book_metrics_100ms
         (bucket_ts, venue, symbol, best_bid, best_ask, mid, spread_bps,
          depth_bps, depth_bid, depth_ask, sample_count)
       VALUES ${placeholders.join(',')}
       ON CONFLICT DO NOTHING`,
      values,
    );
  }

  private async flushPresence(): Promise<void> {
    const rows = this.presence; if (rows.length === 0) return;
    this.presence = [];
    const values: unknown[] = [];
    const placeholders: string[] = [];
    for (const r of rows) {
      const p = r.metrics;
      const i = values.length;
      placeholders.push(`($${i+1},$${i+2},$${i+3},$${i+4},$${i+5},$${i+6},$${i+7},$${i+8},$${i+9},$${i+10})`);
      values.push(
        r.bucketTs, r.venue, r.symbol, r.address,
        p.bidPresent, p.askPresent,
        p.bidDistanceBps, p.askDistanceBps,
        p.bidSizeNearTouch, p.askSizeNearTouch,
      );
    }
    await query(
      `INSERT INTO mm_presence_100ms
         (bucket_ts, venue, symbol, address,
          bid_present, ask_present,
          bid_distance_bps, ask_distance_bps,
          bid_size_near_touch, ask_size_near_touch)
       VALUES ${placeholders.join(',')}
       ON CONFLICT DO NOTHING`,
      values,
    );
  }
}
