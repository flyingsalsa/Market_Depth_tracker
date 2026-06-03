<script lang="ts">
  import { onMount } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import type { PageServerData } from './$types';

  let { data }: { data: PageServerData } = $props();

  function fmtNum(s: string | null, digits = 2): string {
    if (s === null || s === undefined) return '—';
    const n = Number(s);
    if (!Number.isFinite(n)) return '—';
    return n.toLocaleString(undefined, { maximumFractionDigits: digits });
  }

  function bookStateClass(state: string, connected: boolean): string {
    if (!connected || state === 'DISCONNECTED' || state === 'GAP_DETECTED') return 'tag-bad';
    if (state === 'SNAPSHOT' || state === 'RESYNCING') return 'tag-warn';
    return 'tag-good';
  }

  function shorten(addr: string): string {
    if (addr.length <= 12) return addr;
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  }

  function venueLabel(venue: string): string {
    if (venue === 'hyperliquid_perp') return 'perp (USDC)';
    if (venue === 'hyperliquid_spot') return 'spot';
    if (venue.startsWith('hyperliquid_perp_')) {
      return `perp (${venue.slice('hyperliquid_perp_'.length).toUpperCase()})`;
    }
    return venue;
  }

  function marketKey(venue: string, symbol: string): string {
    return `${venue}|${symbol}`;
  }

  let lastRefresh = $state(new Date());

  onMount(() => {
    const timer = setInterval(async () => {
      await invalidateAll();
      lastRefresh = new Date();
    }, 1000);
    return () => clearInterval(timer);
  });

  const healthByMarket = $derived(new Map(data.health.map(h => [marketKey(h.venue, h.symbol), h])));
  const presenceByMarket = $derived.by(() => {
    const m = new Map<string, typeof data.presence>();
    for (const p of data.presence) {
      const k = marketKey(p.venue, p.symbol);
      const list = m.get(k) ?? [];
      list.push(p);
      m.set(k, list);
    }
    return m;
  });
</script>

<h1>Live</h1>
<p class="muted">refreshed at {lastRefresh.toISOString().slice(11, 19)} UTC</p>

<div class="grid">
  {#each data.symbols as s (marketKey(s.venue, s.symbol))}
    {@const h = healthByMarket.get(marketKey(s.venue, s.symbol))}
    {@const wsOk = h?.ws_connected ?? false}
    {@const bookState = h?.book_state ?? 'DISCONNECTED'}
    {@const presList = presenceByMarket.get(marketKey(s.venue, s.symbol)) ?? []}
    <section class="panel">
      <h2>
        {s.symbol}
        <span class="tag">{venueLabel(s.venue)}</span>
        <span class="tag {bookStateClass(bookState, wsOk)}">{bookState}</span>
      </h2>
      <div class="kv numerals">
        <span class="k">best bid</span><span>{fmtNum(s.best_bid)}</span>
        <span class="k">best ask</span><span>{fmtNum(s.best_ask)}</span>
        <span class="k">mid</span>     <span>{fmtNum(s.mid)}</span>
        <span class="k">spread (bps)</span><span>{fmtNum(s.spread_bps, 3)}</span>
        <span class="k">last msg age (ms)</span>
        <span>{h?.last_msg_age_ms ?? '—'}</span>
      </div>

      {#if s.depth_bps && s.depth_bid && s.depth_ask}
        <table style="margin-top:0.75rem">
          <thead>
            <tr>
              <th>distance (bps)</th>
              <th>bid depth</th>
              <th>ask depth</th>
            </tr>
          </thead>
          <tbody>
            {#each s.depth_bps as bps, i}
              <tr class="numerals">
                <td>{bps}</td>
                <td>{fmtNum(s.depth_bid[i] ?? null, 4)}</td>
                <td>{fmtNum(s.depth_ask[i] ?? null, 4)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}

      {#if presList.length > 0}
        <table style="margin-top:0.75rem">
          <thead>
            <tr>
              <th>tracked MM</th>
              <th>bid</th>
              <th>ask</th>
              <th>bid Δ (bps)</th>
              <th>ask Δ (bps)</th>
            </tr>
          </thead>
          <tbody>
            {#each presList as p}
              <tr class="numerals">
                <td title={p.address}>{shorten(p.address)}</td>
                <td>{p.bid_present ? '✓' : '—'}</td>
                <td>{p.ask_present ? '✓' : '—'}</td>
                <td>{fmtNum(p.bid_distance_bps, 2)}</td>
                <td>{fmtNum(p.ask_distance_bps, 2)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </section>
  {/each}
  {#if data.symbols.length === 0}
    <section class="panel">
      <h2>no data yet</h2>
      <p class="muted">
        The ingestor has not written any rows in the last five minutes.
        Check <code>npm run dev</code> in the ingestor folder.
      </p>
    </section>
  {/if}
</div>
