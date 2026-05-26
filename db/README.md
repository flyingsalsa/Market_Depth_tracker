# db

SQL migrations for the MM monitoring schema.

Files in `migrations/` are applied in lexical order by the ingestor's
`npm run migrate` script. Each file is wrapped in a single transaction so a
partial failure leaves the schema untouched.

## Adding a migration

1. Create `migrations/NNNN_description.sql` with the next sequence number.
2. Make sure every `CREATE` is `IF NOT EXISTS` and every `ALTER` is idempotent
   where possible. The migration runner does not yet track applied state, so
   re-running migrations must be safe.
3. Run `cd ingestor && npm run migrate`.

## Tables at a glance

| Table | Purpose | Source of truth? |
|---|---|---|
| `l2_book_snapshot` | Raw L2 snapshots from the venue | yes |
| `bbo` | Top-of-book stream | no, derivable from snapshots |
| `trade` | Public trades for cross-check | yes |
| `mm_order_event` | Per-MM order state changes | yes |
| `mm_open_orders` | Ingestor's view of MM open orders after applying events | no |
| `venue_health` | Connectivity / staleness / book-state heartbeat | yes |
| `book_metrics_100ms` | Pre-bucketed depth/spread/mid | no, derivable from snapshots |
| `mm_presence_100ms` | Pre-bucketed MM presence | no, derivable from open orders + BBO |

The "no" rows exist solely for performance and dashboard convenience. Any SLA
number computed from them must be reproducible from the "yes" rows.
