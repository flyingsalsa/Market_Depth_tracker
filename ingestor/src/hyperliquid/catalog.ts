import { log } from '../logger.js';

// Subset of the /info responses we care about.
interface PerpMeta {
  universe: Array<{ name: string }>;
}
interface SpotToken {
  name: string;
  index: number;
}
interface SpotPair {
  name: string;
  tokens: [number, number];
  index: number;
  isCanonical: boolean;
}
interface SpotMeta {
  tokens: SpotToken[];
  universe: SpotPair[];
}

export interface MarketCatalog {
  /** Set of valid `coin` strings for the default USDC perp dex. */
  perpCoins: Set<string>;
  /** Set of valid `coin` strings for spot markets, includes both
   *  canonical names (e.g. "PURR/USDC") and the `@N` form. */
  spotCoins: Set<string>;
  /** Map from human-friendly "BASE/QUOTE" form to the actual coin string
   *  Hyperliquid expects on WS subscriptions. For canonical pairs the two
   *  are equal ("PURR/USDC" -> "PURR/USDC"); for non-canonical pairs the
   *  friendly form maps to "@N" (e.g. "BASED/USDC" -> "@305"). */
  spotFriendlyToWs: Map<string, string>;
  /** Reverse of the above so dashboards / SLA exports can show the friendly
   *  name even when the WS coin is "@N". */
  spotWsToFriendly: Map<string, string>;
  spot: SpotMeta;
}

async function postInfo<T>(infoUrl: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(infoUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`info endpoint ${JSON.stringify(body)} returned HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchCatalog(infoUrl: string): Promise<MarketCatalog> {
  log.info('Fetching Hyperliquid market catalog');
  const [perp, spot] = await Promise.all([
    postInfo<PerpMeta>(infoUrl, { type: 'meta' }),
    postInfo<SpotMeta>(infoUrl, { type: 'spotMeta' }),
  ]);

  const perpCoins = new Set<string>();
  for (const u of perp.universe) perpCoins.add(u.name);

  // For spot, the WS `coin` is either the canonical "BASE/QUOTE" name (when
  // present) or the "@N" index form. We accept both as valid identifiers
  // and build a translation table so the user can write the friendly form
  // (e.g. "BASED/USDC") even when only "@N" is what the WS will accept.
  const spotCoins = new Set<string>();
  const spotFriendlyToWs = new Map<string, string>();
  const spotWsToFriendly = new Map<string, string>();

  spot.universe.forEach((u, i) => {
    const wsCoin = u.name;            // what Hyperliquid expects on WS
    const indexForm = `@${i}`;
    spotCoins.add(wsCoin);
    spotCoins.add(indexForm);
    spotWsToFriendly.set(wsCoin, wsCoin);
    spotWsToFriendly.set(indexForm, wsCoin);

    // Derive the human-friendly "BASE/QUOTE" form from the token list.
    const baseTok = spot.tokens[u.tokens[0]];
    const quoteTok = spot.tokens[u.tokens[1]];
    if (baseTok && quoteTok) {
      const friendly = `${baseTok.name}/${quoteTok.name}`;
      spotFriendlyToWs.set(friendly, wsCoin);
      // Use the friendly form for display; overwrite anything we put above.
      spotWsToFriendly.set(wsCoin, friendly);
      spotWsToFriendly.set(indexForm, friendly);
    }
  });

  log.info('Catalog ready', {
    perpCount: perpCoins.size,
    spotCount: spot.universe.length,
  });
  return { perpCoins, spotCoins, spotFriendlyToWs, spotWsToFriendly, spot };
}

export interface ValidatedMarket {
  /** Exact `coin` string to use in WebSocket subscriptions and to key the
   *  in-memory state map (Hyperliquid echoes this verbatim on every message). */
  wsCoin: string;
  /** Human-friendly identifier used as the `symbol` column value in every
   *  database row and on the dashboard. Equal to `wsCoin` for canonical
   *  pairs and bare-perp tickers; for non-canonical spot pairs this is the
   *  "BASE/QUOTE" form even though `wsCoin` is "@N". */
  symbol: string;
  venue: string;
  kind: 'perp' | 'spot';
}

/**
 * Cross-check every HL_MARKETS entry against the live catalog. Throws on the
 * first invalid entry with a message that tells the operator exactly what's
 * wrong. The l2Book subscription has no `dex` parameter, so alt-dex perps
 * (anything containing "-") are rejected outright — they would silently kill
 * the WebSocket connection if we let them through.
 */
export function validateMarkets(
  raw: Array<{ id: string; venue: string; kind: string }>,
  catalog: MarketCatalog,
): ValidatedMarket[] {
  const out: ValidatedMarket[] = [];
  for (const m of raw) {
    if (m.kind === 'perp_alt' || m.id.includes('-')) {
      throw new Error(
        `Market "${m.id}" looks like an alt-dex perp. Hyperliquid's l2Book ` +
        `subscription does not accept a dex parameter, so alt-dex perp books ` +
        `cannot be ingested via this WebSocket. Remove it from HL_MARKETS.`,
      );
    }
    if (m.kind === 'spot') {
      // Three accepted spellings:
      //  1. friendly "BASE/QUOTE" form        -> translate via spotFriendlyToWs
      //  2. exact ws name (canonical or @N)   -> use as-is
      let wsCoin: string | undefined;
      let symbol: string;
      if (catalog.spotFriendlyToWs.has(m.id)) {
        wsCoin = catalog.spotFriendlyToWs.get(m.id)!;
        symbol = m.id;
      } else if (catalog.spotCoins.has(m.id)) {
        wsCoin = m.id;
        symbol = catalog.spotWsToFriendly.get(m.id) ?? m.id;
      } else {
        const sampleFriendly = [...catalog.spotFriendlyToWs.keys()].slice(0, 5).join(', ');
        throw new Error(
          `Spot market "${m.id}" is not in spotMeta. Known spot pairs ` +
          `(friendly form) include: ${sampleFriendly}. Use the exact name ` +
          `shown in the Hyperliquid UI, or the @N index form.`,
        );
      }
      out.push({ wsCoin, symbol, venue: 'hyperliquid_spot', kind: 'spot' });
      continue;
    }
    if (!catalog.perpCoins.has(m.id)) {
      throw new Error(
        `Perp market "${m.id}" is not in meta. Either it doesn't exist on ` +
        `the default perp dex or the name is wrong. Check ` +
        `https://app.hyperliquid.xyz/trade for the canonical ticker.`,
      );
    }
    out.push({ wsCoin: m.id, symbol: m.id, venue: 'hyperliquid_perp', kind: 'perp' });
  }
  return out;
}
