<script lang="ts">
  /**
   * A call summary with its references made clickable.
   *
   * `describeCall` returns plain text with `@author/permlink` and `@name`
   * tokens in it; this turns exactly those tokens into links — the post page
   * and the profile page — and renders everything else as the text it is.
   * No {@html}: payloads are other people's data, and the href is built only
   * from the characters the token regex matched (Hive's own name/permlink
   * alphabet), never from raw payload.
   */
  let { text }: { text: string } = $props();

  const TOKEN = /@([a-z0-9][a-z0-9.-]{2,15})(\/[a-z0-9-]+)?/g;

  const parts = $derived.by(() => {
    const out: { t: string; href?: string }[] = [];
    let last = 0;
    for (const m of text.matchAll(TOKEN)) {
      const at = m.index ?? 0;
      if (at > last) out.push({ t: text.slice(last, at) });
      out.push({ t: m[0], href: `/@${m[1]}${m[2] ?? ""}` });
      last = at + m[0].length;
    }
    if (last < text.length) out.push({ t: text.slice(last) });
    return out;
  });
</script>

{#each parts as p, i (i)}{#if p.href}<a href={p.href}>{p.t}</a>{:else}{p.t}{/if}{/each}

<style>
  a { color: var(--gold); text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
