-- Base schema for MM monitoring MVP.
--
-- Conventions:
--   * local_ts  = receive timestamp on the ingestion host. This is the analytics clock.
--   * exchange_ts = venue-reported timestamp. Retained for audit only.
--   * Every row carries (venue, symbol) so the same schema generalises beyond Hyperliquid.

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ---------------------------------------------------------------------------
-- Raw L2 book snapshots, one row per snapshot message from the venue.
-- Bids and asks are stored as JSONB arrays of [price, size, n_orders] tuples,
-- ordered best-first. This is the source of truth for replay.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS l2_book_snapshot (
    local_ts     TIMESTAMPTZ      NOT NULL,
    exchange_ts  TIMESTAMPTZ      NOT NULL,
    venue        TEXT             NOT NULL,
    symbol       TEXT             NOT NULL,
    bids         JSONB            NOT NULL,
    asks         JSONB            NOT NULL,
    PRIMARY KEY (venue, symbol, local_ts)
);

-- ---------------------------------------------------------------------------
-- Best bid / offer stream. Separate from l2_book_snapshot so the dashboard
-- live view can query a narrow table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bbo (
    local_ts     TIMESTAMPTZ      NOT NULL,
    exchange_ts  TIMESTAMPTZ      NOT NULL,
    venue        TEXT             NOT NULL,
    symbol       TEXT             NOT NULL,
    bid_px       NUMERIC          NOT NULL,
    bid_sz       NUMERIC          NOT NULL,
    ask_px       NUMERIC          NOT NULL,
    ask_sz       NUMERIC          NOT NULL,
    PRIMARY KEY (venue, symbol, local_ts)
);

-- ---------------------------------------------------------------------------
-- Trades, kept for cross-checking the book reconstruction and for analytics
-- that need volume context.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trade (
    local_ts     TIMESTAMPTZ      NOT NULL,
    exchange_ts  TIMESTAMPTZ      NOT NULL,
    venue        TEXT             NOT NULL,
    symbol       TEXT             NOT NULL,
    side         TEXT             NOT NULL CHECK (side IN ('buy', 'sell')),
    price        NUMERIC          NOT NULL,
    size         NUMERIC          NOT NULL,
    -- Empty string is the explicit sentinel for "venue did not give us an id".
    -- This keeps trade_id usable as part of the primary key, which requires
    -- a plain column list and rejects function expressions.
    trade_id     TEXT             NOT NULL DEFAULT '',
    PRIMARY KEY (venue, symbol, local_ts, trade_id)
);

-- ---------------------------------------------------------------------------
-- Per-MM order events.
-- Hyperliquid's orderUpdates feed delivers one row per state change on an
-- order belonging to the tracked address.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mm_order_event (
    local_ts     TIMESTAMPTZ      NOT NULL,
    exchange_ts  TIMESTAMPTZ      NOT NULL,
    venue        TEXT             NOT NULL,
    symbol       TEXT             NOT NULL,
    address      TEXT             NOT NULL,
    order_id     TEXT             NOT NULL,
    side         TEXT             NOT NULL CHECK (side IN ('buy', 'sell')),
    price        NUMERIC          NOT NULL,
    size         NUMERIC          NOT NULL,
    status       TEXT             NOT NULL,
    raw          JSONB            NOT NULL,
    PRIMARY KEY (venue, address, order_id, local_ts, status)
);

-- ---------------------------------------------------------------------------
-- Open orders snapshot for the tracked address.
-- The ingestor maintains an in-memory view of the tracked address's open
-- orders by applying orderUpdates, and writes a row here on every change.
-- This gives the SLA evaluator a single table to query for quote presence
-- without having to re-derive the open-order set from events.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mm_open_orders (
    local_ts     TIMESTAMPTZ      NOT NULL,
    venue        TEXT             NOT NULL,
    symbol       TEXT             NOT NULL,
    address      TEXT             NOT NULL,
    bids         JSONB            NOT NULL,  -- [[px, sz], ...] ordered best-first
    asks         JSONB            NOT NULL,
    PRIMARY KEY (venue, symbol, address, local_ts)
);

-- ---------------------------------------------------------------------------
-- Venue health, one row written per heartbeat tick by the ingestor.
-- This is the table the SLA evaluator consults to decide which buckets are
-- excluded from evaluation.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS venue_health (
    local_ts          TIMESTAMPTZ NOT NULL,
    venue             TEXT        NOT NULL,
    symbol            TEXT        NOT NULL,
    ws_connected      BOOLEAN     NOT NULL,
    last_msg_age_ms   INTEGER     NOT NULL,
    book_state        TEXT        NOT NULL CHECK (book_state IN
                          ('LIVE', 'SNAPSHOT', 'RESYNCING', 'GAP_DETECTED', 'DISCONNECTED')),
    note              TEXT,
    PRIMARY KEY (venue, symbol, local_ts)
);

-- ---------------------------------------------------------------------------
-- Pre-bucketed 100 ms metrics. Written by the ingestor on a timer.
-- The dashboard reads this for the live and history views; the SLA evaluator
-- can read either this table or the raw l2_book_snapshot data and is
-- expected to agree.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS book_metrics_100ms (
    bucket_ts        TIMESTAMPTZ NOT NULL,
    venue            TEXT        NOT NULL,
    symbol           TEXT        NOT NULL,
    best_bid         NUMERIC,
    best_ask         NUMERIC,
    mid              NUMERIC,
    spread_bps       NUMERIC,
    -- Depth columns are NUMERIC arrays aligned with the configured bps levels.
    -- The array index matches the order of the DEPTH_BPS env var.
    depth_bps        NUMERIC[]   NOT NULL,
    depth_bid        NUMERIC[]   NOT NULL,
    depth_ask        NUMERIC[]   NOT NULL,
    sample_count     INTEGER     NOT NULL,
    PRIMARY KEY (venue, symbol, bucket_ts)
);

-- ---------------------------------------------------------------------------
-- Pre-bucketed 100 ms MM presence metrics, written by the ingestor.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mm_presence_100ms (
    bucket_ts            TIMESTAMPTZ NOT NULL,
    venue                TEXT        NOT NULL,
    symbol               TEXT        NOT NULL,
    address              TEXT        NOT NULL,
    bid_present          BOOLEAN     NOT NULL,
    ask_present          BOOLEAN     NOT NULL,
    bid_distance_bps     NUMERIC,
    ask_distance_bps     NUMERIC,
    -- Sum of MM resting size within the configured "near touch" window.
    bid_size_near_touch  NUMERIC     NOT NULL DEFAULT 0,
    ask_size_near_touch  NUMERIC     NOT NULL DEFAULT 0,
    PRIMARY KEY (venue, symbol, address, bucket_ts)
);

CREATE INDEX IF NOT EXISTS idx_bbo_symbol_ts        ON bbo (symbol, local_ts DESC);
CREATE INDEX IF NOT EXISTS idx_metrics_symbol_ts    ON book_metrics_100ms (symbol, bucket_ts DESC);
CREATE INDEX IF NOT EXISTS idx_presence_addr_ts     ON mm_presence_100ms (address, bucket_ts DESC);
CREATE INDEX IF NOT EXISTS idx_health_symbol_ts     ON venue_health (symbol, local_ts DESC);
