import { config } from './config.js';
import { log } from './logger.js';
import { Writer } from './writer.js';
import { HyperliquidClient, type ClientState } from './hyperliquid/client.js';
import type { HlInboundMsg, HlSubscription } from './hyperliquid/types.js';
import { fetchCatalog, validateMarkets } from './hyperliquid/catalog.js';
import { SymbolState, bookStateFromConnection } from './state.js';
import { close as closeDb } from './db.js';

async function main(): Promise<void> {
  log.info('Starting ingestor', {
    markets: config.hl.markets.map(m => `${m.venue}:${m.id}`),
    trackedAddresses: config.hl.trackedAddresses,
    bucketMs: config.bucketMs,
    depthBps: config.depthBps,
  });

  // Validate every HL_MARKETS entry against the live catalog BEFORE opening
  // the WebSocket. Hyperliquid drops the entire connection on any malformed
  // or non-existent subscription, so a single typo would otherwise prevent
  // every other market from receiving data. Failing here is much louder.
  const catalog = await fetchCatalog(config.hl.infoUrl);
  const validated = validateMarkets(config.hl.markets, catalog);
  log.info('Markets validated', {
    markets: validated.map(m =>
      m.wsCoin === m.symbol
        ? `${m.venue}:${m.symbol}`
        : `${m.venue}:${m.symbol} (ws=${m.wsCoin})`,
    ),
  });

  const writer = new Writer(500);
  writer.start();

  // Per-market state, keyed on the WebSocket `coin` value because that's
  // what messages from the venue echo back. The `symbol` column stored in
  // the database is the human-readable form (e.g. "BASED/USDC") even when
  // the WS coin is "@305".
  const marketStates = new Map<string, SymbolState>();
  const nearTouchBps = Math.max(...config.depthBps);
  for (const m of validated) {
    marketStates.set(m.wsCoin, new SymbolState(
      m.venue, m.symbol, writer, config.bucketMs, config.depthBps,
      config.hl.trackedAddresses, nearTouchBps,
    ));
  }

  const subs: HlSubscription[] = [];
  for (const m of validated) {
    // The l2Book / bbo / trades subscriptions all take a `coin` field that
    // accepts perp symbols and spot pair strings ("BASE/QUOTE" or "@N").
    // Alt-dex perps cannot be used here — validateMarkets() rejects them
    // before we get this far.
    subs.push({ type: 'l2Book', coin: m.wsCoin });
    subs.push({ type: 'bbo',    coin: m.wsCoin });
    subs.push({ type: 'trades', coin: m.wsCoin });
  }
  for (const user of config.hl.trackedAddresses) {
    subs.push({ type: 'orderUpdates', user });
  }

  let lastConnectionState: ClientState = 'CLOSED';
  let lastMsgAgeMs = Number.MAX_SAFE_INTEGER;

  const hl = new HyperliquidClient({
    url: config.hl.wsUrl,
    subscriptions: subs,
    onMessage: msg => handleMessage(msg, hl, marketStates, writer),
    onStateChange: (state, info) => {
      lastConnectionState = state;
      if (info) lastMsgAgeMs = info.lastMsgAgeMs;
    },
    heartbeatMs: 500,
  });

  hl.start();

  // Tick loop: every `bucketMs / 2` ms we close any expired bucket and emit
  // a health row per (venue, market). Health is per-market because in a
  // multi-venue setup the same WebSocket can serve markets that degrade
  // independently of one another (e.g. spot data stops while perp data
  // continues to flow on the same connection).
  const tickInterval = Math.max(50, Math.floor(config.bucketMs / 2));
  const ticker = setInterval(() => {
    const now = Date.now();
    const wsConnected = lastConnectionState === 'OPEN';
    for (const st of marketStates.values()) {
      st.tick(now);
      const inferred = bookStateFromConnection(wsConnected, lastMsgAgeMs, config.healthStaleMs);
      const reported = st.bookStateLabel();
      // GAP_DETECTED/DISCONNECTED from the connection layer wins over LIVE
      // from the market state, so health degrades immediately on drop.
      const bookState = (inferred === 'LIVE') ? reported : inferred;
      st.onConnectionState(bookState);
      writer.enqueueHealth({
        localTs: new Date(now),
        venue: st.venue,
        symbol: st.symbol,
        wsConnected,
        lastMsgAgeMs: Math.min(lastMsgAgeMs, 2_147_483_647),
        bookState,
        note: null,
      });
    }
  }, tickInterval);

  const shutdown = async (sig: string): Promise<void> => {
    log.info(`Shutting down (${sig})`);
    clearInterval(ticker);
    hl.stop();
    await writer.stop();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT',  () => { void shutdown('SIGINT');  });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}

function handleMessage(
  msg: HlInboundMsg,
  hl: HyperliquidClient,
  marketStates: Map<string, SymbolState>,
  writer: Writer,
): void {
  const firstAfterReconnect = hl.consumeReconnectFlag();
  const now = new Date();
  const channel = (msg as { channel?: string }).channel;
  switch (channel) {
    case 'l2Book': {
      const d = (msg as { data: { coin: string; time: number; levels: unknown[] } }).data;
      const st = marketStates.get(d.coin);
      if (!st) return;
      const levels = d.levels as Array<Array<{ px: string; sz: string; n: number }>>;
      const bids = levels[0] ?? [];
      const asks = levels[1] ?? [];
      writer.enqueueSnapshot({
        localTs: now,
        exchangeTs: new Date(d.time),
        venue: st.venue,
        symbol: st.symbol,
        bids,
        asks,
      });
      st.applyL2Snapshot(bids, asks, firstAfterReconnect);
      break;
    }
    case 'bbo': {
      const d = (msg as { data: { coin: string; time: number; bbo: Array<{ px: string; sz: string } | null> } }).data;
      const st = marketStates.get(d.coin);
      if (!st) return;
      const bid = d.bbo[0];
      const ask = d.bbo[1];
      if (!bid || !ask) return;
      writer.enqueueBbo({
        localTs: now,
        exchangeTs: new Date(d.time),
        venue: st.venue,
        symbol: st.symbol,
        bidPx: Number(bid.px), bidSz: Number(bid.sz),
        askPx: Number(ask.px), askSz: Number(ask.sz),
      });
      break;
    }
    case 'trades': {
      const d = (msg as { data: Array<{ coin: string; side: 'A' | 'B'; px: string; sz: string; time: number; hash?: string; tid?: number }> }).data;
      for (const t of d) {
        const st = marketStates.get(t.coin);
        if (!st) continue;
        writer.enqueueTrade({
          localTs: now,
          exchangeTs: new Date(t.time),
          venue: st.venue,
          symbol: st.symbol,
          side: t.side === 'B' ? 'buy' : 'sell',
          price: Number(t.px),
          size:  Number(t.sz),
          tradeId: t.hash ?? (t.tid !== undefined ? String(t.tid) : ''),
        });
      }
      break;
    }
    case 'orderUpdates': {
      const d = (msg as { data: Array<{ order: { coin: string; side: 'A' | 'B'; limitPx: string; sz: string; oid: number }; status: string; statusTimestamp: number; user?: string }> }).data;
      for (const u of d) {
        const address = (u.user ?? '').toLowerCase();
        if (address === '') continue;
        const st = marketStates.get(u.order.coin);
        if (!st) continue;
        const side: 'buy' | 'sell' = u.order.side === 'B' ? 'buy' : 'sell';
        const price = Number(u.order.limitPx);
        const size  = Number(u.order.sz);
        writer.enqueueOrderEvent({
          localTs: now,
          exchangeTs: new Date(u.statusTimestamp),
          venue: st.venue,
          symbol: st.symbol,
          address,
          orderId: String(u.order.oid),
          side, price, size,
          status: u.status,
          raw: u,
        });
        st.applyOrderUpdate(address, String(u.order.oid), side, price, size, u.status);
      }
      break;
    }
    case 'subscriptionResponse':
    case 'pong':
      return;
    default:
      // Unknown / informational frames are intentionally ignored. Anything
      // we depend on for SLA evaluation is whitelisted above.
      return;
  }
}

main().catch(err => {
  log.error('Fatal', { error: String(err) });
  process.exit(1);
});
