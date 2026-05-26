-- Convert the time-series tables to TimescaleDB hypertables.
-- `if_not_exists => TRUE` keeps this migration idempotent if applied twice.

SELECT create_hypertable('l2_book_snapshot',     by_range('local_ts',  INTERVAL '1 day'), if_not_exists => TRUE);
SELECT create_hypertable('bbo',                  by_range('local_ts',  INTERVAL '1 day'), if_not_exists => TRUE);
SELECT create_hypertable('trade',                by_range('local_ts',  INTERVAL '1 day'), if_not_exists => TRUE);
SELECT create_hypertable('mm_order_event',       by_range('local_ts',  INTERVAL '1 day'), if_not_exists => TRUE);
SELECT create_hypertable('mm_open_orders',       by_range('local_ts',  INTERVAL '1 day'), if_not_exists => TRUE);
SELECT create_hypertable('venue_health',         by_range('local_ts',  INTERVAL '1 day'), if_not_exists => TRUE);
SELECT create_hypertable('book_metrics_100ms',   by_range('bucket_ts', INTERVAL '1 day'), if_not_exists => TRUE);
SELECT create_hypertable('mm_presence_100ms',    by_range('bucket_ts', INTERVAL '1 day'), if_not_exists => TRUE);
