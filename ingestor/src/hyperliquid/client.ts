import WebSocket, { type RawData } from 'ws';
import { log } from '../logger.js';
import type { HlInboundMsg, HlSubscription } from './types.js';

export type ClientState =
  | 'CONNECTING'
  | 'OPEN'
  | 'CLOSING'
  | 'CLOSED'
  | 'BACKOFF';

export interface HyperliquidClientOptions {
  url: string;
  subscriptions: HlSubscription[];
  onMessage: (msg: HlInboundMsg) => void;
  onStateChange: (state: ClientState, info?: { lastMsgAgeMs: number }) => void;
  // Heartbeat tick interval in ms. The client uses this to update the parent
  // about staleness even when no messages are arriving.
  heartbeatMs?: number;
}

const PING_INTERVAL_MS = 30_000;
const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;

/**
 * Resilient single-connection wrapper around the Hyperliquid websocket.
 *
 * Responsibilities:
 *  - Open the connection and resubscribe on reconnect.
 *  - Track time since the last message and surface that to the parent so the
 *    health table can be populated.
 *  - Reconnect with exponential backoff on any drop.
 *
 * Order-book consistency is NOT this layer's job. Hyperliquid sends full
 * snapshots on the `l2Book` channel, so the book is "resynchronised" simply
 * by replacing the in-memory copy with the next snapshot after reconnect.
 * The first snapshot received after a reconnect is tagged book_state='SNAPSHOT'
 * by the handler so downstream code can mark the boundary if it cares.
 */
export class HyperliquidClient {
  private ws: WebSocket | null = null;
  private state: ClientState = 'CLOSED';
  private lastMsgAt = 0;
  private backoffMs = MIN_BACKOFF_MS;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private justReconnected = false;

  constructor(private readonly opts: HyperliquidClientOptions) {}

  start(): void {
    this.stopped = false;
    this.connect();
    const interval = this.opts.heartbeatMs ?? 500;
    this.heartbeatTimer = setInterval(() => this.tickHeartbeat(), interval);
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pingTimer)      clearInterval(this.pingTimer);
    this.heartbeatTimer = null;
    this.pingTimer = null;
    if (this.ws) {
      this.setState('CLOSING');
      try { this.ws.close(); } catch { /* ignore */ }
    }
  }

  /** True if the next message we forward to handlers is the first after a reconnect. */
  consumeReconnectFlag(): boolean {
    if (this.justReconnected) {
      this.justReconnected = false;
      return true;
    }
    return false;
  }

  private connect(): void {
    this.setState('CONNECTING');
    log.info('WS connecting', { url: this.opts.url });
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;

    ws.on('open', () => {
      log.info('WS open');
      this.backoffMs = MIN_BACKOFF_MS;
      this.justReconnected = true;
      this.setState('OPEN');
      for (const sub of this.opts.subscriptions) {
        ws.send(JSON.stringify({ method: 'subscribe', subscription: sub }));
      }
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify({ method: 'ping' })); } catch { /* ignore */ }
        }
      }, PING_INTERVAL_MS);
    });

    ws.on('message', (raw: RawData) => {
      this.lastMsgAt = Date.now();
      let parsed: HlInboundMsg;
      try {
        parsed = JSON.parse(raw.toString()) as HlInboundMsg;
      } catch (err) {
        log.warn('WS bad JSON', { error: String(err) });
        return;
      }
      try {
        this.opts.onMessage(parsed);
      } catch (err) {
        log.error('Handler threw', { error: String(err) });
      }
    });

    ws.on('close', (code, reason) => {
      log.warn('WS closed', { code, reason: reason.toString() });
      this.setState('CLOSED');
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (!this.stopped) this.scheduleReconnect();
    });

    ws.on('error', err => {
      log.warn('WS error', { error: String(err) });
    });
  }

  private scheduleReconnect(): void {
    this.setState('BACKOFF');
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    log.info('WS reconnect scheduled', { delayMs: delay });
    setTimeout(() => {
      if (!this.stopped) this.connect();
    }, delay);
  }

  private tickHeartbeat(): void {
    const ageMs = this.lastMsgAt === 0 ? Number.MAX_SAFE_INTEGER : Date.now() - this.lastMsgAt;
    this.opts.onStateChange(this.state, { lastMsgAgeMs: ageMs });
  }

  private setState(s: ClientState): void {
    if (s === this.state) return;
    this.state = s;
    const ageMs = this.lastMsgAt === 0 ? Number.MAX_SAFE_INTEGER : Date.now() - this.lastMsgAt;
    this.opts.onStateChange(s, { lastMsgAgeMs: ageMs });
  }
}
