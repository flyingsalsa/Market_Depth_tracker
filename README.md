# MM Monitoring — Hyperliquid MVP

A market-maker monitoring system that ingests Hyperliquid L2 order book data over
WebSockets, stores it in TimescaleDB, computes SLA-aligned metrics, and surfaces
the results through a SvelteKit dashboard.

This is the MVP scope:

- **Venue:** Hyperliquid perps only.
- **Assets:** `BTC` and `SOL` perps by default (configurable).
- **Tracked MM:** one wallet address (configurable) plus the aggregate book.
- **SLA metrics:** two-sided depth within N bps of mid, bid-ask spread in bps,
  and quote-presence uptime for the tracked address.
- **Evaluation cadence:** 100 ms wall-clock buckets, evaluated against
  `local_ts` (the ingestion-side receive timestamp).
- **Evidence:** every dashboard number is reproducible from the raw tables.

Anything outside this list is intentionally out of scope for the MVP. See the
parent design document for the full reasoning.

## Layout

```
.
├── docker-compose.yml      # TimescaleDB
├── .env.example            # Copy to .env and edit
├── db/migrations/          # SQL migrations (applied in order)
├── ingestor/               # TS service: WS -> normalise -> TimescaleDB
├── sla/                    # TS CLI: evaluate SLA over a window, export CSV
└── dashboard/              # SvelteKit dashboard (live, history, report)
```

## Quick start

Prerequisites: Docker Desktop, Node.js 20+, npm.

```powershell
# 1. Configure
Copy-Item .env.example .env
# edit .env if you want to change the tracked symbols or MM address

# 2. One-off setup (installs all three packages, brings the DB up,
#    waits for the healthcheck, applies migrations).
npm install            # installs the root concurrently helper
npm run setup

# 3. Run the whole MVP (ingestor + dashboard, with the DB ensured up first).
npm run dev
# Dashboard at http://localhost:5173
# Ctrl-C kills both child processes at once.
```

Once the ingestor has been running for a few minutes, evaluate the SLA from
the same root directory:

```powershell
npm run report -- --symbol BTC --hours 1
```

### Root scripts

All commands are run from the project root. Internally they delegate to the
relevant subpackage via `npm --prefix`, so the per-folder commands in the
table below still work if you prefer to run them directly.

| Root command | What it does |
|---|---|
| `npm run setup`     | Bring DB up, install all three subpackages, apply migrations. Run once on a new machine. |
| `npm run dev`       | Ensure the DB is healthy, apply migrations idempotently, then run ingestor and dashboard in parallel. Ctrl-C stops both. |
| `npm run ingestor`  | Run just the ingestor (useful while iterating on the SQL schema). |
| `npm run dashboard` | Run just the dashboard. |
| `npm run migrate`   | Apply / re-apply DB migrations. Idempotent. |
| `npm run report -- --symbol BTC --hours 1` | Run an SLA report; arguments after `--` are passed through. |
| `npm run db:up`     | `docker compose up -d --wait`. |
| `npm run db:down`   | `docker compose down` (keeps the data volume). |
| `npm run db:reset`  | Drop the data volume, bring the DB back up, re-run migrations. |
| `npm run db:psql`   | Open a psql shell inside the container. |
| `npm run typecheck` | Type-check ingestor and SLA packages. |

## Configuring tracked market makers

The `HL_TRACKED_ADDRESSES` env var is **optional**. With it empty (the
default in `.env.example`) the ingestor collects the **aggregate book
metrics** — depth, spread, mid, venue health — and that's all. This is the
"aggregate book SLA" mode, which is what most CEX deployments are stuck with
anyway because they cannot attribute resting size to a specific MM.

If you want the **per-MM quote-presence SLA**, populate the variable with
one or more Hyperliquid wallets:

```
HL_TRACKED_ADDRESSES=0xabc...,0xdef...
```

Pick addresses from the on-chain leaderboard at
[`https://app.hyperliquid.xyz/leaderboard`](https://app.hyperliquid.xyz/leaderboard).
Restart `npm run dev` after editing — the `mm_presence_100ms` table will
start filling for each address, and the live dashboard will show one
"tracked MM" row per (symbol, address).

## Verifying ingestion is healthy

After `npm run dev` is running, use these queries from another terminal to
check that data is actually flowing and the connection is in a healthy
state. (You can also just open the dashboard at
[`http://localhost:5173`](http://localhost:5173) and look at the colour
of the per-symbol status tag — but the queries below are the ground truth.)

### a) Is data coming in at all?

```powershell
docker exec mm_timescaledb psql -U mm -d mm_monitoring -c "
  SELECT symbol, count(*) AS rows, max(local_ts) AS latest
  FROM l2_book_snapshot
  GROUP BY symbol;"
```

Run it twice 10 seconds apart. `rows` should grow and `latest` should be
within a second or two of now. If neither happens, the WS connection isn't
delivering snapshots.

### b) Is the connection healthy?

```powershell
docker exec mm_timescaledb psql -U mm -d mm_monitoring -c "
  SELECT symbol, ws_connected, last_msg_age_ms, book_state, local_ts
  FROM venue_health
  WHERE local_ts > now() - interval '30 seconds'
  ORDER BY symbol, local_ts DESC
  LIMIT 10;"
```

Expected shape per row: `ws_connected = t`, `last_msg_age_ms` under a few
hundred, `book_state = LIVE` (or `SNAPSHOT` briefly right after start /
reconnect).

### c) Do the metrics look sane?

```powershell
docker exec mm_timescaledb psql -U mm -d mm_monitoring -c "
  SELECT symbol, mid, spread_bps, depth_bps, depth_bid, depth_ask
  FROM book_metrics_100ms
  WHERE bucket_ts > now() - interval '5 seconds'
  ORDER BY symbol, bucket_ts DESC
  LIMIT 4;"
```

For BTC, `mid` should be the current BTC perp price, `spread_bps` typically
under 1, and `depth_bid` / `depth_ask` should be small positive arrays in
units of the underlying asset.

## Day-to-day workflow

```powershell
# one-off, once per machine:
npm install
npm run setup

# whenever you want to collect data + look at it:
npm run dev                                  # ingestor + dashboard together

# whenever you want a defensible SLA number:
npm run report -- --symbol BTC --hours 1
```

Leave `npm run dev` running in the background as long as you want the data
window to grow. There is no harm in starting and stopping it repeatedly —
gaps are recorded in `venue_health` and become *excluded windows* in any
subsequent SLA report rather than fake breaches.

## Troubleshooting

- **`Missing required env var DATABASE_URL`** — your `.env` is missing or
  has not been picked up. The subpackages load `.env` from the project
  root, so the file must live next to `docker-compose.yml`. Copy from
  `.env.example` if you haven't.
- **`error: relation "l2_book_snapshot" does not exist`** (or any other
  table name) — migrations haven't been applied yet. Run
  `cd ingestor && npm run migrate` and look for `All migrations applied`.
- **WS keeps connecting and closing with `code 1006`** — Hyperliquid is
  rejecting one of the subscriptions and dropping the whole connection.
  This is now caught at startup by the catalog validator, which prints a
  message naming the offending market and the reason (alt-dex perps are
  not subscribable via `l2Book`; unknown spot pairs must be added to
  `spotMeta` first; perp names must match the canonical ticker). Fix the
  bad entry in `HL_MARKETS` and restart.
- **Migration error like `syntax error at or near …`** — the migration
  files are wrapped in a single transaction, so the schema is rolled back
  cleanly. Fix the SQL, then re-run `npm run migrate`. The `CREATE … IF NOT
  EXISTS` guards make it safe to run repeatedly.
- **Want to start over from a clean database?**
  ```powershell
  docker exec mm_timescaledb psql -U mm -d postgres -c "DROP DATABASE IF EXISTS mm_monitoring;"
  docker exec mm_timescaledb psql -U mm -d postgres -c "CREATE DATABASE mm_monitoring;"
  cd ingestor; npm run migrate
  ```

## Design notes that matter for review

- All cross-component analytics use `local_ts` (the ingestion-side receive
  timestamp). The venue-reported `exchange_ts` is retained on every row for
  audit but is never used as the analytics clock. This is the only policy
  that survives a contract dispute.
- The ingestor writes both raw L2 snapshots **and** pre-bucketed 100 ms metric
  rows. The raw rows are the source of truth for replay; the bucketed rows
  exist to keep the dashboard fast. The SLA evaluator can be run against
  either and is expected to agree.
- Venue health is recorded as a first-class table. Any 100 ms bucket whose
  health row reports `ws_connected = false` or `last_msg_age_ms` over the
  configured threshold is treated by the SLA evaluator as an *excluded
  window*, not as a market-maker breach.
- Hyperliquid attribution is public: every order on `orderUpdates` is tagged
  with the wallet address, so MM-specific metrics do not require any private
  feed or venue cooperation. This is the reason Hyperliquid was chosen as
  the MVP venue.

## What this MVP does *not* do

- No cross-venue support, no clock-skew handling beyond `local_ts`/`exchange_ts`.
- No alerting, paging, or notifications. Degraded venue state is shown on
  the dashboard only.
- No downsampling beyond the 100 ms bucketed metric table. Retention policies
  are documented but commented out — turn them on once you've decided your
  dispute-window length.
- No authentication on the dashboard. Run it behind a VPN or on localhost.
