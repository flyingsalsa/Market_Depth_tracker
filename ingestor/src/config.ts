import { config as dotenvConfig } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Load the project-root .env regardless of which directory the script was
// invoked from. dotenv silently ignores a missing file, which is what we
// want for production where env vars come from the orchestrator instead.
const here = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(here, '..', '..', '.env') });

function envStr(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var ${name}`);
  }
  return v;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} is not a number: ${v}`);
  return n;
}

function envList(name: string, fallback: string[] = []): string[] {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

/**
 * A market is identified by its Hyperliquid `coin` string verbatim (the same
 * string the UI shows and the WebSocket expects). We classify the *kind* of
 * market — perp, spot, alt-dex perp — by the shape of the string, so a single
 * `HL_MARKETS` env var is all that's ever needed:
 *
 *   plain alnum, e.g. "BTC"            -> default USDC perp dex
 *   contains "/" or starts with "@",   -> spot
 *     e.g. "BASED/USDC", "@1"
 *   contains "-", e.g. "BASED-USDE"    -> alt-dex perp; venue tag derived
 *                                         from the suffix (e.g. perp_usde)
 *
 * The `venue` value below is what gets written to the `venue` column of every
 * table. Default USDC perps are tagged `"hyperliquid_perp"`.
 */
export type MarketKind = 'perp' | 'spot' | 'perp_alt';

export interface Market {
  /** Exact Hyperliquid identifier — sent verbatim as the WS `coin` field
   *  and stored verbatim in the `symbol` column. */
  id: string;
  kind: MarketKind;
  /** Database `venue` tag. */
  venue: string;
}

export function parseMarket(raw: string): Market {
  const id = raw.trim();
  if (id.length === 0) throw new Error('Empty market identifier');

  if (id.includes('/') || id.startsWith('@')) {
    return { id, kind: 'spot', venue: 'hyperliquid_spot' };
  }
  if (id.includes('-')) {
    // Treat anything after the last "-" as the dex suffix, lowercased.
    // e.g. "BASED-USDE" -> dex suffix "usde" -> venue "hyperliquid_perp_usde"
    const suffix = id.slice(id.lastIndexOf('-') + 1).toLowerCase();
    if (suffix.length === 0) throw new Error(`Malformed alt-dex perp id: ${id}`);
    return { id, kind: 'perp_alt', venue: `hyperliquid_perp_${suffix}` };
  }
  return { id, kind: 'perp', venue: 'hyperliquid_perp' };
}

function parseMarkets(): Market[] {
  // Prefer the new HL_MARKETS. Fall back to the older HL_SYMBOLS (perps only)
  // so .env files written before this change still work.
  const explicit = envList('HL_MARKETS');
  const fallback = envList('HL_SYMBOLS', ['BTC', 'SOL']);
  const source = explicit.length > 0 ? explicit : fallback;
  return source.map(parseMarket);
}

export const config = {
  databaseUrl: envStr('DATABASE_URL'),
  hl: {
    wsUrl:    envStr('HL_WS_URL',   'wss://api.hyperliquid.xyz/ws'),
    infoUrl:  envStr('HL_INFO_URL', 'https://api.hyperliquid.xyz/info'),
    markets:  parseMarkets(),
    trackedAddresses: envList('HL_TRACKED_ADDRESSES').map(a => a.toLowerCase()),
  },
  healthStaleMs:  envInt('HEALTH_STALE_MS', 2000),
  bucketMs:       envInt('METRIC_BUCKET_MS', 100),
  depthBps:       envList('DEPTH_BPS', ['5', '10', '25']).map(s => Number(s)),
};

export type Config = typeof config;
