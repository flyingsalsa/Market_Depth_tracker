# ingestor

Hyperliquid WebSocket -> TimescaleDB ingestor.

## Running

```powershell
npm install
npm run migrate     # one-off; idempotent
npm run dev         # watch mode
# or
npm start           # one-shot
```

## What it writes

For every configured symbol the ingestor subscribes to `l2Book`, `bbo` and
`trades`, plus `orderUpdates` for every address in `HL_TRACKED_ADDRESSES`.

Every received message is written verbatim to the corresponding raw table.
On top of that, the ingestor maintains an in-memory view of:

- the latest book per symbol;
- the current open-order set for each tracked MM address;
- the current 100 ms wall-clock bucket;

and on every bucket boundary it emits one row to `book_metrics_100ms` per
symbol and one row to `mm_presence_100ms` per (symbol, tracked address).
These bucketed rows are what the dashboard and SLA evaluator read.

A `venue_health` row is written every ~`bucketMs/2` per symbol, capturing
the websocket connection state, the age of the most recent message, and the
inferred book state. This is the signal the SLA evaluator uses to mark
windows as excluded.

## Design choices that matter

- **`local_ts` is the analytics clock.** Every metric / health row uses
  `Date.now()` on the ingestion host. The venue-reported `exchange_ts` is
  preserved on every raw row but is *only* used for audit, never for
  bucketing.
- **Hyperliquid sends full L2 snapshots**, so there is no incremental delta
  state to corrupt on reconnect. The first snapshot after a reconnect is
  tagged `book_state='SNAPSHOT'` in the health table so the boundary is
  visible.
- **Health degradation wins.** If the connection layer reports
  `DISCONNECTED` or `GAP_DETECTED`, that overrides any symbol-level `LIVE`
  state immediately, so SLA exclusion happens at the first moment data
  stops arriving — not when the next snapshot would have arrived.

## Layout

```
src/
  index.ts            # main loop, dispatch
  config.ts           # env -> typed config
  logger.ts
  db.ts               # pg pool
  migrate.ts          # apply ../db/migrations
  writer.ts           # batched INSERTs
  metrics.ts          # depth/spread/presence math (pure functions)
  state.ts            # per-symbol bucketing
  hyperliquid/
    client.ts         # resilient WS client
    types.ts          # subset of HL message shapes
```
