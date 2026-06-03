<script lang="ts">
  import type { PageServerData } from './$types';
  let { data }: { data: PageServerData } = $props();
  const r = $derived(data.result);

  let venue  = $state(data.result.params.venue);
  let symbol = $state(data.result.params.symbol);

  // "venue\u0000symbol" key for the market dropdown. Empty keeps the current
  // values so a market not in the list can still be typed by hand.
  const SEP = '\u0000';
  let selectedMarket = $state(
    data.markets.some(m => m.venue === data.result.params.venue && m.symbol === data.result.params.symbol)
      ? data.result.params.venue + SEP + data.result.params.symbol
      : '',
  );

  function onMarketChange() {
    if (!selectedMarket) return;
    const i = selectedMarket.indexOf(SEP);
    venue  = selectedMarket.slice(0, i);
    symbol = selectedMarket.slice(i + 1);
  }

  function pct(x: number | null): string {
    if (x === null) return '—';
    return `${(x * 100).toFixed(3)} %`;
  }
  function pctTag(x: number | null, threshold = 0.99): string {
    if (x === null) return 'tag';
    return x >= threshold ? 'tag tag-good' : (x >= threshold - 0.02 ? 'tag tag-warn' : 'tag tag-bad');
  }
</script>

<h1>SLA report</h1>

<form class="params" method="get">
  <label>market
    <select bind:value={selectedMarket} onchange={onMarketChange}>
      <option value="">— custom —</option>
      {#each data.markets as m}
        <option value={m.venue + SEP + m.symbol}>{m.venue} / {m.symbol}</option>
      {/each}
    </select>
  </label>
  <label>venue          <input name="venue"           bind:value={venue}  placeholder="hyperliquid_perp" /></label>
  <label>symbol         <input name="symbol"          bind:value={symbol} /></label>
  <label>hours          <input name="hours"           type="number" step="0.1" value={r.params.hours} /></label>
  <label>max spread bps <input name="max-spread-bps" type="number" step="0.1" value={r.params.maxSpreadBps} /></label>
  <label>min depth      <input name="min-depth"      type="number" step="0.01" value={r.params.minDepth} /></label>
  <label>depth @ bps    <input name="depth-at-bps"   type="number" step="1"   value={r.params.depthAtBps} /></label>
  <label>address        <input name="address"         value={r.params.trackedAddress ?? ''} placeholder="0x… (optional)" style="min-width: 22rem" /></label>
  <label>both sides     <input name="presence-both-sides" type="checkbox" checked={r.params.presenceBothSides} value="true" /></label>
  <button type="submit">evaluate</button>
</form>

<section class="panel">
  <div class="kv">
    <span class="k">Venue / symbol</span><span>{r.params.venue} / {r.params.symbol}</span>
    <span class="k">Window</span>     <span>{r.params.start} → {r.params.end}</span>
    <span class="k">Bucket</span>     <span>{r.params.bucketMs} ms</span>
    <span class="k">Stale thresh</span><span>{r.params.healthStaleMs} ms</span>
    <span class="k">Total buckets</span><span class="numerals">{r.totalBuckets.toLocaleString()}</span>
    <span class="k">Evaluated</span>   <span class="numerals">{r.evaluatedBuckets.toLocaleString()}</span>
    <span class="k">Excluded</span>    <span class="numerals">{r.excludedBuckets.toLocaleString()} ({pct(r.excludedFraction)})</span>
  </div>
</section>

<div class="grid" style="margin-top:1rem">
  <section class="panel">
    <h2>Spread SLA</h2>
    <p>≤ {r.params.maxSpreadBps} bps</p>
    <p><span class={pctTag(r.spreadCompliance)}>{pct(r.spreadCompliance)}</span></p>
    <p class="muted numerals">breaches: {r.spreadBreaches.toLocaleString()}</p>
  </section>

  <section class="panel">
    <h2>Depth SLA</h2>
    <p>≥ {r.params.minDepth} each side at {r.params.depthAtBps} bps</p>
    <p><span class={pctTag(r.depthCompliance)}>{pct(r.depthCompliance)}</span></p>
    <p class="muted numerals">breaches: {r.depthBreaches.toLocaleString()}</p>
  </section>

  <section class="panel">
    <h2>Presence SLA</h2>
    {#if r.params.trackedAddress}
      <p>{r.params.presenceBothSides ? 'both sides' : 'either side'} for {r.params.trackedAddress}</p>
      <p><span class={pctTag(r.presenceCompliance)}>{pct(r.presenceCompliance)}</span></p>
      <p class="muted numerals">breaches: {r.presenceBreaches.toLocaleString()}</p>
    {:else}
      <p class="muted">no address provided — presence SLA skipped</p>
    {/if}
  </section>
</div>

<section class="panel" style="margin-top:1rem">
  <h2>evidence</h2>
  <p class="muted">
    This report was computed at request time directly from
    <code>book_metrics_100ms</code>, <code>mm_presence_100ms</code> and
    <code>venue_health</code>. Re-evaluating the same window on the SLA CLI
    (<code>cd sla &amp;&amp; npm run report -- --symbol {r.params.symbol} --hours {r.params.hours} …</code>)
    must produce matching numbers; this is the replay-determinism check.
  </p>
</section>
