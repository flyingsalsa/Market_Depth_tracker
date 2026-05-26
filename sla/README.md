# sla

Deterministic SLA evaluator for the MM monitoring MVP.

`evaluate.ts` exposes a single function `evaluateSla(params)` that:

1. Walks the time window in `bucketMs` increments.
2. For each bucket, consults `venue_health` to decide whether the bucket is
   *excluded* (no analytics, no breach).
3. For every non-excluded bucket, joins `book_metrics_100ms` and (if a
   tracked address is provided) `mm_presence_100ms` to test:
   - spread <= `maxSpreadBps`
   - depth on **both** sides >= `minDepth` at the `depthAtBps` slot
   - presence of the tracked MM (either side / both sides per param)
4. Reports `compliance_fraction = (evaluated - breaches) / evaluated` per
   metric, plus the excluded fraction.

The same function is used by the dashboard "report" view and by the CLI, so
internal and external numbers cannot drift.

## CLI usage

```powershell
# default: BTC, last 1h, max spread 5 bps, depth slot 10 bps, min depth 0
npm run report

# typical contract-style invocation
npm run report -- --symbol BTC --hours 24 --max-spread-bps 4 --min-depth 5 --depth-at-bps 10 --address 0xabc...

# disable presence-both-sides (require quote on either side only)
npm run report -- --symbol SOL --hours 1 --address 0xabc... --presence-both-sides false
```

Outputs land in `./exports/` as `.txt`, `.csv` and `.json` triples named by
the run timestamp. The CSV column set is stable and intended to be diffable
across runs and reproducible from the raw tables.

## Replay test (recommended part of the MVP definition of done)

The evaluator is deterministic over the database state. To verify:

```powershell
npm run report -- --symbol BTC --hours 1 --out exports
# wait a few seconds, do not let the ingestor catch up further
npm run report -- --symbol BTC --hours 1 --out exports
# diff the two CSV outputs
```

The two CSVs must be identical (modulo the file name's timestamp suffix).
