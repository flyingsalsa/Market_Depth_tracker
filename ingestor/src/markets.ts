import { config } from './config.js';
import { fetchCatalog } from './hyperliquid/catalog.js';

/**
 * Print Hyperliquid market identifiers that match the search term, with the
 * exact string to put in HL_MARKETS. Use this when you want to find the
 * correct ticker for a token without writing a one-off curl command.
 *
 *   npm run markets                # list everything
 *   npm run markets BASED          # filter, case-insensitive
 *   npm run markets PURR --type spot
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let search = '';
  let kindFilter: 'all' | 'perp' | 'spot' = 'all';
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--type') {
      const v = args[++i] ?? 'all';
      if (v !== 'all' && v !== 'perp' && v !== 'spot') {
        throw new Error(`--type must be all|perp|spot, got ${v}`);
      }
      kindFilter = v;
    } else if (!a.startsWith('--')) {
      search = a.toLowerCase();
    }
  }

  const catalog = await fetchCatalog(config.hl.infoUrl);

  const perpRows: Array<{ kind: string; useInEnv: string; wsCoin: string; note: string }> = [];
  if (kindFilter === 'all' || kindFilter === 'perp') {
    for (const coin of catalog.perpCoins) {
      if (search && !coin.toLowerCase().includes(search)) continue;
      perpRows.push({ kind: 'perp',   useInEnv: coin, wsCoin: coin, note: 'default USDC perp dex' });
    }
  }

  const spotRows: Array<{ kind: string; useInEnv: string; wsCoin: string; note: string }> = [];
  if (kindFilter === 'all' || kindFilter === 'spot') {
    catalog.spot.universe.forEach((p, i) => {
      const baseTok = catalog.spot.tokens[p.tokens[0]];
      const quoteTok = catalog.spot.tokens[p.tokens[1]];
      const friendly = baseTok && quoteTok ? `${baseTok.name}/${quoteTok.name}` : p.name;
      const ws = p.name;     // canonical name or "@N"
      const matches =
        !search ||
        friendly.toLowerCase().includes(search) ||
        ws.toLowerCase().includes(search) ||
        (baseTok && baseTok.name.toLowerCase().includes(search));
      if (!matches) return;
      spotRows.push({
        kind: 'spot',
        useInEnv: friendly,
        wsCoin: ws,
        note: `index ${i}${p.isCanonical ? ' (canonical)' : ''}`,
      });
    });
  }

  const all = [...perpRows, ...spotRows];
  if (all.length === 0) {
    process.stdout.write(`No markets matched ${JSON.stringify(search)}\n`);
    return;
  }

  // Tabular output.
  const pad = (s: string, n: number): string => s.length >= n ? s : s + ' '.repeat(n - s.length);
  const w = {
    kind: Math.max(4, ...all.map(r => r.kind.length)),
    env:  Math.max(28, ...all.map(r => r.useInEnv.length)),
    ws:   Math.max(7, ...all.map(r => r.wsCoin.length)),
  };
  // Both `HL_MARKETS` and the SLA `--symbol` flag take the friendly form,
  // so we surface that explicitly to avoid confusion with the WS coin value
  // (which is what the WebSocket subscribes with, but never stored).
  const header1 = `${pad('KIND', w.kind)}  ${pad('HL_MARKETS / --symbol', w.env)}  ${pad('WS coin', w.ws)}  notes`;
  process.stdout.write(header1 + '\n');
  for (const r of all) {
    process.stdout.write(`${pad(r.kind, w.kind)}  ${pad(r.useInEnv, w.env)}  ${pad(r.wsCoin, w.ws)}  ${r.note}\n`);
  }
  process.stdout.write(`\nTotal: ${all.length}\n`);
  process.stdout.write(
    `\nUse the "HL_MARKETS / --symbol" column for both .env entries and\n` +
    `the SLA CLI's --symbol flag. The "WS coin" column is informational\n` +
    `only — the ingestor uses it internally for the WebSocket subscription.\n`,
  );
}

main().catch(err => {
  console.error(String(err));
  process.exitCode = 1;
});
