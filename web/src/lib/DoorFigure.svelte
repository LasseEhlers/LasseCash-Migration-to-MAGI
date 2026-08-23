<script lang="ts">
  /**
   * The three doors — Write, Lock, Provide — as pictures.
   *
   * One idea per drawing, and each drawing answers the same two questions the
   * paragraph beside it answers: what do I put in, what comes out. Gold is the
   * protocol paying, dim is the person, cyan is reserved for machine chrome
   * and appears only where the chain itself is the subject (the "forever"
   * block in Write). Red is nowhere: nothing in the short version is value
   * being lost, and the one place it could be — breaking a lock early — is a
   * choice the reader makes, not something done to them.
   */
  let { kind }: { kind: "write" | "lock" | "provide" } = $props();
</script>

<figure class="door">
  {#if kind === "write"}
    <svg viewBox="0 0 320 150" role="img" aria-label="Write: an article on the chain, votes flowing in, payment flowing out to the author and the voters.">
      <!-- the article, on a block that stays -->
      <rect x="18" y="28" width="104" height="94" rx="6" class="paper" />
      <line x1="32" y1="48" x2="108" y2="48" class="txt" />
      <line x1="32" y1="62" x2="96" y2="62" class="txt" />
      <line x1="32" y1="76" x2="104" y2="76" class="txt" />
      <line x1="32" y1="90" x2="84" y2="90" class="txt" />
      <rect x="18" y="122" width="104" height="10" rx="2" class="chain" />
      <text x="18" y="144" class="lbl cyan">stays on the chain, forever</text>
      <!-- votes coming in -->
      {#each [44, 70, 96] as y, i}
        <path d="M{190} {y} L{136} {y}" class="flow in" />
        <polygon points="136,{y} 144,{y - 4} 144,{y + 4}" class="arrow in" />
        <circle cx="206" cy={y} r="9" class="voter" />
        <text x="206" y={y + 4} class="lbl ink" text-anchor="middle">{i + 1}</text>
      {/each}
      <text x="206" y="122" class="lbl dim" text-anchor="middle">people vote</text>
      <text x="206" y="134" class="lbl dim" text-anchor="middle">with their mints</text>
      <!-- payment flowing out, to author AND voters -->
      <path d="M236 70 Q 270 70 282 40" class="flow out" />
      <path d="M236 70 Q 270 70 282 100" class="flow out" />
      <circle cx="290" cy="34" r="12" class="coin" /><text x="290" y="38" class="lbl coin-txt" text-anchor="middle">L</text>
      <circle cx="290" cy="106" r="12" class="coin" /><text x="290" y="110" class="lbl coin-txt" text-anchor="middle">L</text>
      <text x="290" y="16" class="lbl gold" text-anchor="middle">author</text>
      <text x="290" y="130" class="lbl gold" text-anchor="middle">voters</text>
    </svg>
    <figcaption>You write, they vote, both of you are paid.</figcaption>

  {:else if kind === "lock"}
    <svg viewBox="0 0 320 150" role="img" aria-label="Lock: LASSECASH goes into a time lock and new tokens flow out for as long as it stays locked; longer and bigger locks earn more.">
      <!-- coins going in -->
      <circle cx="30" cy="75" r="12" class="coin" /><text x="30" y="79" class="lbl coin-txt" text-anchor="middle">L</text>
      <path d="M48 75 L88 75" class="flow in" />
      <polygon points="92,75 84,71 84,79" class="arrow in" />
      <!-- the lock / mint -->
      <rect x="98" y="52" width="74" height="56" rx="8" class="vault" />
      <path d="M120 52 V 40 a15 15 0 0 1 30 0 V 52" class="shackle" />
      <circle cx="135" cy="80" r="6" class="keyhole" />
      <text x="135" y="124" class="lbl gold" text-anchor="middle">a mint</text>
      <text x="135" y="136" class="lbl dim" text-anchor="middle">1 day … 3 years</text>
      <!-- time axis with growing yield -->
      <line x1="190" y1="108" x2="306" y2="108" class="axis" />
      {#each [0, 1, 2, 3, 4] as i}
        <rect x={196 + i * 22} y={104 - (i + 1) * 12} width="14" height={(i + 1) * 12} rx="2" class="bar" />
      {/each}
      <text x="248" y="124" class="lbl dim" text-anchor="middle">longer → more</text>
      <text x="248" y="136" class="lbl dim" text-anchor="middle">bigger → more</text>
      <text x="248" y="30" class="lbl gold" text-anchor="middle">new tokens, every block</text>
      <path d="M180 80 L190 80" class="flow out" />
    </svg>
    <figcaption>Lock it, and every new token pays you a share while it stays locked.</figcaption>

  {:else}
    <svg viewBox="0 0 320 150" role="img" aria-label="Provide: LASSECASH and HBD go into the pool together; new tokens flow out, and the share grows with time up to ninety days.">
      <!-- two coins in -->
      <circle cx="30" cy="52" r="12" class="coin" /><text x="30" y="56" class="lbl coin-txt" text-anchor="middle">L</text>
      <circle cx="30" cy="98" r="12" class="coin hbd" /><text x="30" y="102" class="lbl coin-txt" text-anchor="middle">$</text>
      <text x="30" y="30" class="lbl dim" text-anchor="middle">LASSECASH</text>
      <text x="30" y="128" class="lbl dim" text-anchor="middle">HBD</text>
      <path d="M48 52 Q 80 52 92 70" class="flow in" />
      <path d="M48 98 Q 80 98 92 80" class="flow in" />
      <!-- the pool -->
      <ellipse cx="135" cy="75" rx="40" ry="26" class="pool" />
      <path d="M103 70 q 8 -6 16 0 t 16 0 t 16 0 t 16 0" class="wave" />
      <path d="M103 82 q 8 -6 16 0 t 16 0 t 16 0 t 16 0" class="wave" />
      <text x="135" y="118" class="lbl gold" text-anchor="middle">the pool</text>
      <text x="135" y="130" class="lbl dim" text-anchor="middle">no fee, ever</text>
      <!-- loyalty ramp -->
      <path d="M182 75 L194 75" class="flow out" />
      <polyline points="200,104 240,104 240,80 280,80 280,56 306,56" class="ramp" />
      <line x1="200" y1="108" x2="306" y2="108" class="axis" />
      <text x="253" y="124" class="lbl dim" text-anchor="middle">day 1 → day 90</text>
      <text x="253" y="136" class="lbl dim" text-anchor="middle">+1% a day, then flat</text>
      <text x="253" y="40" class="lbl gold" text-anchor="middle">your share grows</text>
    </svg>
    <figcaption>Both sides in together, and the longer it sits the more of every block is yours.</figcaption>
  {/if}
</figure>

<style>
  .door { margin: 0.6rem 0 1.6rem; padding: 0; }
  /* The SVG scales with the column — that is what a viewBox is for. It is
     capped at 560px so the labels stay legible rather than growing into
     posters on a wide monitor, and `overflow: visible` guarantees nothing
     near an edge is ever clipped whatever the font renders at. */
  svg { width: 100%; max-width: 560px; height: auto; display: block; overflow: visible; }
  figcaption { margin-top: 0.4rem; font-size: 0.82rem; color: var(--dim); }

  .lbl { font-size: 9px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .lbl.dim { fill: var(--dim); }
  .lbl.gold { fill: var(--gold); font-weight: 700; }
  .lbl.cyan { fill: var(--cyan); }
  .lbl.ink { fill: var(--ink); font-weight: 700; }
  .lbl.coin-txt { fill: #0d1117; font-weight: 800; font-size: 11px; }

  .paper { fill: var(--panel-2); stroke: var(--line-hot); stroke-width: 1; }
  .txt { stroke: var(--dim); stroke-width: 2; stroke-linecap: round; }
  /* the one cyan element: the chain the article lives on */
  .chain { fill: var(--cyan); opacity: 0.55; }
  .voter { fill: var(--panel-2); stroke: var(--dim); stroke-width: 1.2; }
  .coin { fill: var(--gold); }
  .coin.hbd { fill: var(--gold-dim); }
  .flow { fill: none; stroke-width: 1.6; stroke-linecap: round; }
  .flow.in { stroke: var(--dim); stroke-dasharray: 3 3; }
  .flow.out { stroke: var(--gold); }
  .arrow.in { fill: var(--dim); }

  .vault { fill: var(--panel-2); stroke: var(--gold); stroke-width: 1.5; }
  .shackle { fill: none; stroke: var(--gold); stroke-width: 3; }
  .keyhole { fill: var(--gold); }
  .axis { stroke: var(--line-hot); stroke-width: 1; }
  .bar { fill: var(--gold); opacity: 0.85; }

  .pool { fill: var(--panel-2); stroke: var(--gold); stroke-width: 1.5; }
  .wave { fill: none; stroke: var(--gold); stroke-width: 1.2; opacity: 0.7; }
  .ramp { fill: none; stroke: var(--gold); stroke-width: 2; }
</style>
