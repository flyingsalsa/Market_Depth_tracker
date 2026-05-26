# dashboard

SvelteKit dashboard for the MM monitoring MVP.

## Running

```powershell
npm install
npm run dev    # http://localhost:5173
```

The dashboard expects the ingestor to be writing into the same TimescaleDB
that `DATABASE_URL` points at. It reads in-process from a `pg` pool; there
is no separate API server.

## Pages

| Path        | Source                          | Purpose |
|-------------|----------------------------------|---------|
| `/`         | `+page.server.ts`                | Live state per symbol: BBO, depth table, MM presence, venue health. Auto-refreshes every second. |
| `/history`  | `history/+page.server.ts`        | Time-series sparkline of mid and spread with excluded windows shaded. Backed by the `book_metrics_1s` continuous aggregate. |
| `/report`   | `report/+page.server.ts`         | On-demand SLA evaluation. Implements the same algorithm as `sla/src/evaluate.ts`; the two must agree byte-for-byte on overlapping windows. |

## Honest limitations

- No auth. Bind to localhost or run behind a VPN.
- The report page re-implements the SLA algorithm rather than importing the
  `sla` package; this duplication is acknowledged in the route file and
  should be resolved by extracting a shared `mm-core` package post-MVP.
- The history sparkline is dependency-free SVG. It is adequate for an MVP
  review meeting; it is not a substitute for a real charting library if you
  need pan/zoom.
