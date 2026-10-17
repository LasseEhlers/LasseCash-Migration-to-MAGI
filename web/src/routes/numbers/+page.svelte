<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import Seo from "$lib/Seo.svelte";
  import { SITE_OG_IMAGE, SITE_URL } from "$lib/site.js";

  // Crawlers read the tags above and stop; a person lands on the live page.
  onMount(() => { void goto("/stats", { replaceState: true }); });
</script>

<Seo
  title="LasseCash numbers, live from the chain"
  description="Who has minted, who provides liquidity and who posts on LasseCash, read live from the chain. Every figure comes from the contract itself."
  canonical={`${SITE_URL}/stats`}
  image={SITE_OG_IMAGE}
  noindex
/>

<p class="dim">Opening the live numbers… <a href="/stats">Stats →</a></p>
