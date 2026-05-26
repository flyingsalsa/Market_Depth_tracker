// Subset of the Hyperliquid websocket message shapes that we actually use.
// Reference: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket

export type HlBookLevel = {
  px: string;     // price as decimal string
  sz: string;     // size as decimal string
  n: number;      // number of orders at this level
};

export type HlL2BookMsg = {
  channel: 'l2Book';
  data: {
    coin: string;
    time: number;            // exchange-side ms timestamp
    levels: [HlBookLevel[], HlBookLevel[]];  // [bids, asks], best-first
  };
};

export type HlBboMsg = {
  channel: 'bbo';
  data: {
    coin: string;
    time: number;
    bbo: [HlBookLevel | null, HlBookLevel | null];  // [bid, ask]
  };
};

export type HlTradeMsg = {
  channel: 'trades';
  data: Array<{
    coin: string;
    side: 'A' | 'B';   // 'A' = ask filled (taker sold), 'B' = bid filled (taker bought)
    px: string;
    sz: string;
    time: number;
    hash: string;
    tid: number;
  }>;
};

export type HlOrderUpdateMsg = {
  channel: 'orderUpdates';
  data: Array<{
    order: {
      coin: string;
      side: 'A' | 'B';   // 'A' = sell, 'B' = buy
      limitPx: string;
      sz: string;
      oid: number;
      timestamp: number;
      origSz: string;
    };
    status: string;     // 'open' | 'filled' | 'canceled' | 'triggered' | ...
    statusTimestamp: number;
    user?: string;      // some envelopes include the address
  }>;
};

export type HlSubAck = {
  channel: 'subscriptionResponse';
  data: unknown;
};

export type HlPong = {
  channel: 'pong';
};

export type HlInboundMsg =
  | HlL2BookMsg
  | HlBboMsg
  | HlTradeMsg
  | HlOrderUpdateMsg
  | HlSubAck
  | HlPong
  | { channel: string; data: unknown };

export type HlSubscription =
  | { type: 'l2Book'; coin: string }
  | { type: 'bbo'; coin: string }
  | { type: 'trades'; coin: string }
  | { type: 'orderUpdates'; user: string };
