<script lang="ts">
  import { invalidate } from '$app/navigation';
  import type { PageServerData } from './$types';
  let { data }: { data: PageServerData } = $props();

  // SVG sparkline — kept dependency-free on purpose. Renders mid + spread + excluded seconds.
  const W = 1100, H = 220, PAD = 30;

  function buildSeries(): {
    midPath: string;
    spreadPath: string;
    excludedBars: Array<{x: number; w: number; secs: number}>;
    midMin: number; midMax: number; spreadMax: number;
    tMin: number; tMax: number;
  } {
    const ms = data.metrics;
    if (ms.length === 0) {
      return { midPath: '', spreadPath: '', excludedBars: [],
        midMin: 0, midMax: 0, spreadMax: 0, tMin: 0, tMax: 0 };
    }
    const ts = ms.map(r => r.bucket_ts.getTime());
    const mids = ms.map(r => r.mid !== null ? Number(r.mid) : NaN);
    const spreads = ms.map(r => r.spread_bps !== null ? Number(r.spread_bps) : NaN);
    const tMin = ts[0]!;
    const tMax = ts[ts.length - 1]!;
    const midFinite = mids.filter(Number.isFinite);
    const midMin = Math.min(...midFinite);
    const midMax = Math.max(...midFinite);
    const spreadFinite = spreads.filter(Number.isFinite);
    const spreadMax = Math.max(0.5, ...spreadFinite);

    const sx = (t: number) => PAD + (W - 2*PAD) * (tMax === tMin ? 0.5 : (t - tMin) / (tMax - tMin));
    const sy = (v: number) => H - PAD - (H - 2*PAD) * (midMax === midMin ? 0.5 : (v - midMin) / (midMax - midMin));
    const sy2 = (v: number) => H - PAD - (H - 2*PAD) * (v / spreadMax);

    const midPath = mids.map((v, i) => {
      if (!Number.isFinite(v)) return null;
      return `${i === 0 ? 'M' : 'L'}${sx(ts[i]!).toFixed(1)},${sy(v).toFixed(1)}`;
    }).filter((s): s is string => s !== null).join(' ');
    const spreadPath = spreads.map((v, i) => {
      if (!Number.isFinite(v)) return null;
      return `${i === 0 ? 'M' : 'L'}${sx(ts[i]!).toFixed(1)},${sy2(v).toFixed(1)}`;
    }).filter((s): s is string => s !== null).join(' ');

    const excludedBars = data.excluded.map(e => {
      const tStart = e.bucket_ts.getTime();
      const tEnd   = tStart + 60_000;
      return {
        x: sx(tStart),
        w: Math.max(1, sx(tEnd) - sx(tStart)),
        secs: Number(e.excluded_seconds),
      };
    }).filter(b => b.secs > 0);

    return { midPath, spreadPath, excludedBars, midMin, midMax, spreadMax, tMin, tMax };
  }

  const s = $derived(buildSeries());
  let venue  = $state(data.venue);
  let symbol = $state(data.symbol);
  let hours  = $state(data.hours);

  // "venue\u0000symbol" key for the market dropdown. Empty string keeps the
  // current values so a market not in the list can still be typed by hand.
  const SEP = '\u0000';
  let selectedMarket = $state(
    data.markets.some(m => m.venue === data.venue && m.symbol === data.symbol)
      ? data.venue + SEP + data.symbol
      : '',
  );

  function onMarketChange() {
    if (!selectedMarket) return;
    const i = selectedMarket.indexOf(SEP);
    venue  = selectedMarket.slice(0, i);
    symbol = selectedMarket.slice(i + 1);
  }

  // Quick window presets. Values are in hours (server clamps 5 min .. 7 days).
  let formEl: HTMLFormElement;
  const presets = [
    { label: '5m',  hours: 0.0833 },
    { label: '15m', hours: 0.25 },
    { label: '1h',  hours: 1 },
    { label: '6h',  hours: 6 },
    { label: '1d',  hours: 24 },
    { label: '7d',  hours: 168 },
  ];
  function applyPreset(h: number) {
    hours = h;
    formEl.requestSubmit();
  }
  const presetActive = (h: number) => Math.abs(data.hours - h) < 1e-3;

  // Live refresh: re-run this page's loader on an interval so the chart keeps
  // moving (and the operator can see the feed is alive). Toggleable + the
  // cadence is selectable so long windows don't poll the DB needlessly.
  let live = $state(true);
  let intervalMs = $state(1000);
  let lastUpdated = $state(new Date());
  let refreshing = $state(false);

  // Re-runs whenever `live` or `intervalMs` change: the old timer is torn down
  // and a new one started with the new cadence.
  $effect(() => {
    if (!live) return;
    const id = setInterval(async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        await invalidate('mm:history');
        lastUpdated = new Date();
      } finally {
        refreshing = false;
      }
    }, intervalMs);
    return () => clearInterval(id);
  });
</script>

<h1>History — {data.venue} / {data.symbol} ({data.hours.toFixed(2)} h)</h1>

<p class="muted" style="margin:-0.4rem 0 0.9rem; display:flex; align-items:center; gap:0.5rem; font-size:0.8rem">
  <label style="display:inline-flex; align-items:center; gap:0.35rem; cursor:pointer">
    <input type="checkbox" bind:checked={live} />
    <span class="live-dot" class:live-on={live && !refreshing} class:live-busy={refreshing}></span>
    {live ? 'live' : 'paused'}
  </label>
  <label style="display:inline-flex; align-items:center; gap:0.3rem">
    every
    <select bind:value={intervalMs} disabled={!live} class="inline-select">
      <option value={1000}>1s</option>
      <option value={2000}>2s</option>
      <option value={5000}>5s</option>
      <option value={10000}>10s</option>
      <option value={30000}>30s</option>
    </select>
  </label>
  <span>•</span>
  <span>1&nbsp;s resolution · {data.hours.toFixed(2)}&nbsp;h window</span>
  <span>•</span>
  <span>updated {lastUpdated.toLocaleTimeString()}</span>
</p>

<form class="params" method="get" bind:this={formEl}>
  <label>
    market
    <select bind:value={selectedMarket} onchange={onMarketChange}>
      <option value="">— custom —</option>
      {#each data.markets as m}
        <option value={m.venue + SEP + m.symbol}>{m.venue} / {m.symbol}</option>
      {/each}
    </select>
  </label>
  <label>
    venue
    <input name="venue" bind:value={venue} placeholder="hyperliquid_perp" />
  </label>
  <label>
    symbol
    <input name="symbol" bind:value={symbol} />
  </label>
  <label>
    hours
    <input name="hours" type="number" min="0.0833" step="any" bind:value={hours} />
  </label>
  <button type="submit">apply</button>
  <span class="presets">
    {#each presets as p}
      <button type="button" class="preset" class:preset-active={presetActive(p.hours)}
              onclick={() => applyPreset(p.hours)}>{p.label}</button>
    {/each}
  </span>
</form>

<section class="panel">
  {#if data.metrics.length === 0}
    <p class="muted">no metric rows in this window</p>
  {:else}
    <div class="legend">
      <span class="legend-item"><span class="swatch" style="background:#58a6ff"></span>mid price&nbsp;<span class="muted">(left axis)</span></span>
      <span class="legend-item"><span class="swatch swatch-dashed" style="color:#d29922"></span>spread, bps&nbsp;<span class="muted">(right axis)</span></span>
      <span class="legend-item"><span class="swatch" style="background:#f85149;opacity:0.5"></span>excluded window&nbsp;<span class="muted">(no SLA evaluation)</span></span>
    </div>
    <svg viewBox={`0 0 ${W} ${H}`} style="width:100%; height:auto">
      <!-- excluded windows (shaded, drawn first so the lines sit on top) -->
      {#each s.excludedBars as b}
        <rect x={b.x} y={PAD} width={b.w} height={H - 2*PAD}
              fill="#f85149" opacity={Math.min(0.5, 0.1 + b.secs / 60)} />
      {/each}
      <path d={s.midPath}    fill="none" stroke="#58a6ff" stroke-width="1.4" />
      <path d={s.spreadPath} fill="none" stroke="#d29922" stroke-width="1.0" stroke-dasharray="3 2" />

      <!-- left axis (mid price) -->
      <text x={PAD} y={PAD - 6} fill="#58a6ff" font-size="11">mid price</text>
      <text x={PAD} y={PAD + 4} fill="#8b949e" font-size="10">{s.midMax.toFixed(2)}</text>
      <text x={PAD} y={H - PAD} fill="#8b949e" font-size="10">{s.midMin.toFixed(2)}</text>

      <!-- right axis (spread bps) -->
      <text x={W - PAD} y={PAD - 6} text-anchor="end" fill="#d29922" font-size="11">spread (bps)</text>
      <text x={W - PAD} y={PAD + 4} text-anchor="end" fill="#8b949e" font-size="10">{s.spreadMax.toFixed(2)}</text>
      <text x={W - PAD} y={H - PAD} text-anchor="end" fill="#8b949e" font-size="10">0</text>
    </svg>
  {/if}
</section>

<section class="panel" style="margin-top:1rem">
  <h2>excluded windows</h2>
  {#if data.excluded.filter(e => Number(e.excluded_seconds) > 0).length === 0}
    <p class="muted">no excluded seconds in this window</p>
  {:else}
    <table>
      <thead><tr><th>minute</th><th>excluded seconds</th></tr></thead>
      <tbody>
        {#each data.excluded.filter(e => Number(e.excluded_seconds) > 0) as e}
          <tr class="numerals">
            <td>{e.bucket_ts.toISOString().slice(0, 16).replace('T', ' ')}</td>
            <td>{Number(e.excluded_seconds).toFixed(1)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</section>
