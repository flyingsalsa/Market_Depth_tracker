<script lang="ts">
  import '../lib/style.css';
  let { children } = $props();
</script>

<nav class="nav">
  <span class="brand">mm-monitor</span>
  <a href="/">live</a>
  <a href="/history">history</a>
  <a href="/report">report</a>
  <span class="spacer"></span>
  <span class="muted">Hyperliquid MVP</span>
</nav>

<main>
  {@render children()}
</main>
