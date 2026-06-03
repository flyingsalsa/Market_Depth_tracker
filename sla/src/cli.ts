import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { evaluateSla, closeSlaPool, type SlaParams, type SlaResult } from './evaluate.js';

interface Cli {
  venue: string;
  symbol: string;
  hours: number;
  maxSpreadBps: number;
  minDepth: number;
  depthAtBps: number;
  address: string | null;
  presenceBothSides: boolean;
  out: string;
}

function parseArgs(argv: string[]): Cli {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args.set(key, 'true');
      } else {
        args.set(key, next);
        i++;
      }
    }
  }
  return {
    venue:        args.get('venue')  ?? 'hyperliquid_perp',
    symbol:       args.get('symbol') ?? 'BTC',
    hours:        Number(args.get('hours') ?? '1'),
    maxSpreadBps: Number(args.get('max-spread-bps') ?? '5'),
    minDepth:     Number(args.get('min-depth') ?? '0'),
    depthAtBps:   Number(args.get('depth-at-bps') ?? '10'),
    address:      args.get('address') ?? null,
    presenceBothSides: (args.get('presence-both-sides') ?? 'true') !== 'false',
    out:          args.get('out') ?? 'exports',
  };
}

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(3)} %`;
}

function fmtResultText(r: SlaResult): string {
  const p = r.params;
  const lines = [
    `SLA report`,
    `===========`,
    `Venue:           ${p.venue}`,
    `Symbol:          ${p.symbol}`,
    `Window:          ${p.start.toISOString()}  ..  ${p.end.toISOString()}`,
    `Bucket size:     ${p.bucketMs ?? 100} ms`,
    `Health stale:    ${p.healthStaleMs ?? 2000} ms`,
    ``,
    `Buckets total:       ${r.totalBuckets}`,
    `Buckets evaluated:   ${r.evaluatedBuckets}`,
    `Buckets excluded:    ${r.excludedBuckets}  (${fmtPct(r.excludedFraction)})`,
    ``,
    `Spread SLA  ( <= ${p.maxSpreadBps} bps ):       ${fmtPct(r.spreadComplianceFraction)}    breaches: ${r.spreadBreaches}`,
    `Depth SLA   ( >= ${p.minDepth} each side @ ${p.depthAtBps} bps ): ${fmtPct(r.depthComplianceFraction)}    breaches: ${r.depthBreaches}`,
  ];
  if (r.presenceComplianceFraction !== null) {
    lines.push(
      `Presence SLA ( ${p.presenceBothSidesRequired ? 'both' : 'either'} side, addr ${p.trackedAddress} ): ${fmtPct(r.presenceComplianceFraction)}    breaches: ${r.presenceBreaches}`,
    );
  }
  return lines.join('\n') + '\n';
}

function fmtResultCsv(r: SlaResult): string {
  const p = r.params;
  const headers = [
    'venue','symbol','window_start','window_end','bucket_ms','health_stale_ms',
    'buckets_total','buckets_evaluated','buckets_excluded','excluded_fraction',
    'max_spread_bps','spread_compliance','spread_breaches',
    'min_depth','depth_at_bps','depth_compliance','depth_breaches',
    'tracked_address','presence_required','presence_compliance','presence_breaches',
  ];
  const row = [
    p.venue, p.symbol, p.start.toISOString(), p.end.toISOString(),
    p.bucketMs ?? 100, p.healthStaleMs ?? 2000,
    r.totalBuckets, r.evaluatedBuckets, r.excludedBuckets, r.excludedFraction.toFixed(6),
    p.maxSpreadBps, r.spreadComplianceFraction.toFixed(6), r.spreadBreaches,
    p.minDepth, p.depthAtBps, r.depthComplianceFraction.toFixed(6), r.depthBreaches,
    p.trackedAddress ?? '',
    p.presenceBothSidesRequired ? 'both' : 'either',
    r.presenceComplianceFraction === null ? '' : r.presenceComplianceFraction.toFixed(6),
    r.presenceBreaches,
  ];
  return headers.join(',') + '\n' + row.join(',') + '\n';
}

async function main(): Promise<void> {
  const c = parseArgs(process.argv.slice(2));
  const end = new Date();
  const start = new Date(end.getTime() - c.hours * 3600_000);
  const params: SlaParams = {
    venue: c.venue,
    symbol: c.symbol,
    start, end,
    maxSpreadBps: c.maxSpreadBps,
    minDepth: c.minDepth,
    depthAtBps: c.depthAtBps,
    trackedAddress: c.address ?? undefined,
    presenceBothSidesRequired: c.presenceBothSides,
  };
  const result = await evaluateSla(params);

  process.stdout.write(fmtResultText(result));

  await mkdir(c.out, { recursive: true });
  const stamp = end.toISOString().replace(/[:.]/g, '-');
  const base = join(c.out, `sla_${c.venue}_${c.symbol}_${stamp}`);
  await writeFile(`${base}.txt`,  fmtResultText(result), 'utf8');
  await writeFile(`${base}.csv`,  fmtResultCsv(result),  'utf8');
  await writeFile(`${base}.json`, JSON.stringify(result, null, 2), 'utf8');
  process.stdout.write(`\nExports written under ${c.out}/\n`);
}

main()
  .catch(err => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeSlaPool());
