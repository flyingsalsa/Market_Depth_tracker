-- Continuous aggregates and (commented-out) retention policies.
--
-- The MVP keeps everything at full resolution. These aggregates exist so the
-- dashboard's historical view stays responsive at minute / hour zoom levels
-- without scanning the raw 100 ms metric table.

CREATE MATERIALIZED VIEW IF NOT EXISTS book_metrics_1s
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 second', bucket_ts) AS bucket_ts,
    venue,
    symbol,
    avg(mid)            AS mid,
    avg(spread_bps)     AS spread_bps,
    avg(best_bid)       AS best_bid,
    avg(best_ask)       AS best_ask,
    count(*)            AS sample_count
FROM book_metrics_100ms
GROUP BY 1, 2, 3
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS book_metrics_1m
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 minute', bucket_ts) AS bucket_ts,
    venue,
    symbol,
    avg(mid)            AS mid,
    avg(spread_bps)     AS spread_bps,
    min(spread_bps)     AS spread_bps_min,
    max(spread_bps)     AS spread_bps_max,
    count(*)            AS sample_count
FROM book_metrics_100ms
GROUP BY 1, 2, 3
WITH NO DATA;

-- Refresh policies: poll every 30 s, keeping the last hour up to date.
SELECT add_continuous_aggregate_policy('book_metrics_1s',
    start_offset => INTERVAL '1 hour',
    end_offset   => INTERVAL '1 second',
    schedule_interval => INTERVAL '30 seconds',
    if_not_exists => TRUE);

SELECT add_continuous_aggregate_policy('book_metrics_1m',
    start_offset => INTERVAL '6 hours',
    end_offset   => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute',
    if_not_exists => TRUE);

-- Retention. Left commented out intentionally: the MVP should run for at
-- least one full dispute-window before any data is dropped. Uncomment and
-- adjust the interval once that policy decision has been made.
--
-- SELECT add_retention_policy('l2_book_snapshot',   INTERVAL '30 days', if_not_exists => TRUE);
-- SELECT add_retention_policy('bbo',                INTERVAL '30 days', if_not_exists => TRUE);
-- SELECT add_retention_policy('trade',              INTERVAL '90 days', if_not_exists => TRUE);
-- SELECT add_retention_policy('book_metrics_100ms', INTERVAL '90 days', if_not_exists => TRUE);
