<script lang="ts">
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
  let symbol = $state(data.symbol);
  let hours  = $state(data.hours);
</script>

<h1>History — {data.venue} / {data.symbol} ({data.hours.toFixed(2)} h)</h1>

<form class="params" method="get">
  <label>
    venue
    <input name="venue" value={data.venue} placeholder="hyperliquid" />
  </label>
  <label>
    symbol
    <input name="symbol" bind:value={symbol} />
  </label>
  <label>
    hours
    <input name="hours" type="number" min="0.1" step="0.1" bind:value={hours} />
  </label>
  <button type="submit">apply</button>
</form>

<section class="panel">
  {#if data.metrics.length === 0}
    <p class="muted">no metric rows in this window</p>
  {:else}
    <svg viewBox={`0 0 ${W} ${H}`} style="width:100%; height:auto">
      <!-- excluded windows (shaded, drawn first so the lines sit on top) -->
      {#each s.excludedBars as b}
        <rect x={b.x} y={PAD} width={b.w} height={H - 2*PAD}
              fill="#f85149" opacity={Math.min(0.5, 0.1 + b.secs / 60)} />
      {/each}
      <path d={s.midPath}    fill="none" stroke="#58a6ff" stroke-width="1.4" />
      <path d={s.spreadPath} fill="none" stroke="#d29922" stroke-width="1.0" stroke-dasharray="3 2" />
      <text x={PAD} y={20} fill="#8b949e" font-size="11">
        mid: {s.midMin.toFixed(2)} … {s.midMax.toFixed(2)}  •  spread (bps, dashed) max: {s.spreadMax.toFixed(2)}
      </text>
      <text x={W - PAD} y={20} text-anchor="end" fill="#8b949e" font-size="11">
        red shading = excluded windows (no SLA evaluation)
      </text>
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
