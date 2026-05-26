import type { HlBookLevel } from './hyperliquid/types.js';

export interface BookMetrics {
  bestBid: number | null;
  bestAsk: number | null;
  mid:     number | null;
  spreadBps: number | null;
  // depthBid[i] / depthAsk[i] is the cumulative size resting within
  // depthBps[i] basis points of mid on that side.
  depthBps: number[];
  depthBid: number[];
  depthAsk: number[];
}

/**
 * Compute mid, spread (bps) and cumulative depth on each side at the
 * configured bps distances from mid.
 *
 * `bids` and `asks` are best-first.
 */
export function computeBookMetrics(
  bids: HlBookLevel[],
  asks: HlBookLevel[],
  depthBps: number[],
): BookMetrics {
  if (bids.length === 0 || asks.length === 0) {
    return {
      bestBid: null, bestAsk: null, mid: null, spreadBps: null,
      depthBps,
      depthBid: depthBps.map(() => 0),
      depthAsk: depthBps.map(() => 0),
    };
  }
  const bestBid = Number(bids[0]!.px);
  const bestAsk = Number(asks[0]!.px);
  const mid = (bestBid + bestAsk) / 2;
  const spread = bestAsk - bestBid;
  const spreadBps = mid > 0 ? (spread / mid) * 10_000 : null;

  const depthBid: number[] = [];
  const depthAsk: number[] = [];
  for (const bps of depthBps) {
    const bidFloor = mid * (1 - bps / 10_000);
    const askCeil  = mid * (1 + bps / 10_000);
    let sumBid = 0;
    for (const lvl of bids) {
      const p = Number(lvl.px);
      if (p < bidFloor) break;
      sumBid += Number(lvl.sz);
    }
    let sumAsk = 0;
    for (const lvl of asks) {
      const p = Number(lvl.px);
      if (p > askCeil) break;
      sumAsk += Number(lvl.sz);
    }
    depthBid.push(sumBid);
    depthAsk.push(sumAsk);
  }
  return { bestBid, bestAsk, mid, spreadBps, depthBps, depthBid, depthAsk };
}

export interface PresenceMetrics {
  bidPresent: boolean;
  askPresent: boolean;
  bidDistanceBps: number | null;
  askDistanceBps: number | null;
  bidSizeNearTouch: number;
  askSizeNearTouch: number;
}

/**
 * Decide whether the tracked MM is "present" relative to a reference mid.
 *
 * "Near touch" is parameterised by `nearTouchBps`; size resting within that
 * window on either side is summed and reported.
 */
export function computePresence(
  mid: number | null,
  bids: Array<[number, number]>,  // [px, sz]
  asks: Array<[number, number]>,
  nearTouchBps: number,
): PresenceMetrics {
  if (mid === null || mid <= 0) {
    return {
      bidPresent: false, askPresent: false,
      bidDistanceBps: null, askDistanceBps: null,
      bidSizeNearTouch: 0, askSizeNearTouch: 0,
    };
  }
  const bestBid = bids.length > 0
    ? bids.reduce((acc, b) => Math.max(acc, b[0]), -Infinity)
    : null;
  const bestAsk = asks.length > 0
    ? asks.reduce((acc, a) => Math.min(acc, a[0]),  Infinity)
    : null;

  const bidDistanceBps = bestBid !== null && bestBid > 0 && Number.isFinite(bestBid)
    ? ((mid - bestBid) / mid) * 10_000
    : null;
  const askDistanceBps = bestAsk !== null && bestAsk > 0 && Number.isFinite(bestAsk)
    ? ((bestAsk - mid) / mid) * 10_000
    : null;

  const bidFloor = mid * (1 - nearTouchBps / 10_000);
  const askCeil  = mid * (1 + nearTouchBps / 10_000);

  const bidSizeNearTouch = bids
    .filter(([px]) => px >= bidFloor)
    .reduce((acc, [, sz]) => acc + sz, 0);
  const askSizeNearTouch = asks
    .filter(([px]) => px <= askCeil)
    .reduce((acc, [, sz]) => acc + sz, 0);

  return {
    bidPresent: bidDistanceBps !== null && bidDistanceBps <= nearTouchBps,
    askPresent: askDistanceBps !== null && askDistanceBps <= nearTouchBps,
    bidDistanceBps, askDistanceBps,
    bidSizeNearTouch, askSizeNearTouch,
  };
}
