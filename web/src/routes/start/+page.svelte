<script lang="ts">
  /**
   * Start here — for someone who has never held a Hive account.
   *
   * Nearly every newcomer is stopped before the mint form: they have no
   * account, no wallet and no LASSECASH, and nothing on the site said where to
   * begin. This is the whole path in order, in plain words.
   *
   * It states no live figure (a yield, a price, a share) because those change
   * within a day and this page is permanent. The one number it does give —
   * what an HBD adds in action credits — is a rule of the network, not a
   * market reading, and is the same sentence the credits banner shows.
   */
  import Seo from "$lib/Seo.svelte";
  import { HIVE_SIGNUP_URL, SITE_OG_IMAGE, SITE_URL } from "$lib/site.js";
</script>

<Seo
  title="Start here"
  description="How to begin with LasseCash if you have no Hive account yet: create the account, add a wallet, get a little HBD, buy LASSECASH and open your first mint."
  canonical={`${SITE_URL}/start`}
  image={SITE_OG_IMAGE}
/>

<div class="start">
  <h1>Start here</h1>
  <p class="lede">
    LasseCash runs on Hive, so you need a Hive account. If you have one, skip to
    step 3. Everything below is free to try except the LASSECASH you choose to buy.
  </p>

  <ol>
    <li class="panel">
      <h2>1 · Create a Hive account</h2>
      <p>
        Hive shows you your keys once, when the account is made. Save them
        somewhere safe: nobody, including us, can recover them for you.
      </p>
      <p>
        <a class="button" href={HIVE_SIGNUP_URL} target="_blank" rel="noopener">Create a Hive account →</a>
      </p>
      <p class="dim">
        This link names @lasseehlers as your referrer. You can create an account
        at signup.hive.io without it, and LasseCash works the same either way.
      </p>
    </li>

    <li class="panel">
      <h2>2 · Install a wallet</h2>
      <p>
        Hive Keychain is a browser extension and a phone app that holds your keys.
        LasseCash never sees them: it asks the wallet to sign each action, and
        anything that moves value asks for your approval at that moment.
      </p>
      <p>
        <a class="button" href="https://hive-keychain.com" target="_blank" rel="noopener">Get Hive Keychain →</a>
      </p>
    </li>

    <li class="panel">
      <h2>3 · Sign in</h2>
      <p>
        Use <b>sign in</b> at the top right of any page, type your Hive account
        name and pick your wallet.
      </p>
    </li>

    <li class="panel">
      <h2>4 · Get a little HBD, and move it to MAGI</h2>
      <p>
        HBD is Hive's dollar-pegged token. You need some for two things: to buy
        LASSECASH, and as action credits on MAGI, where 1 HBD adds 1,000 credits
        and is held as collateral, never spent. A new account starts with 10,000
        free credits — enough for one mint or a handful of votes, refilling over five days.
      </p>
      <p>
        <b>How much to keep on MAGI.</b> Credits are used by every action and come
        back in full over five days, so the right amount depends on how much you do
        in a typical week:
      </p>
      <table class="tiers">
        <tbody>
          <tr><td class="mono">10 HBD</td><td class="mono">20,000 credits</td><td>An occasional mint, vote or trade</td></tr>
          <tr><td class="mono">25 HBD</td><td class="mono">35,000 credits</td><td>Voting and posting most days</td></tr>
          <tr><td class="mono">100 HBD</td><td class="mono">110,000 credits</td><td>Active curating, trading or liquidity, with almost no waiting</td></tr>
        </tbody>
      </table>
      <p class="dim">
        For scale: a vote uses about 1,000 credits, a post 1,000–2,000, a mint
        about 6,000. Keep this amount apart from the HBD you buy LASSECASH with,
        because HBD that goes into a swap or leaves MAGI takes its credits with it.
      </p>
      <p>
        Exchanges that list Hive let you buy HIVE or HBD and withdraw it to your
        account name. If you end up with HIVE, swap it for HBD in your Hive wallet.
        Then move HBD over on the <a href="/wallet">Wallet</a> page.
      </p>
    </li>

    <li class="panel">
      <h2>5 · Buy LASSECASH, then mint</h2>
      <p>
        Swap HBD for LASSECASH in the <a href="/pool">pool</a>. Then
        <a href="/mint">mint</a>: lock it for anything from a day to three years.
        The longer you lock, the more shares each LASSECASH earns, and the mint
        page shows the current estimate as you move the sliders. The estimate
        changes as other people mint, so treat it as a live reading and not a
        promise.
      </p>
    </li>
  </ol>

  <p>
    <b>Vote here to make it count.</b> Posts are on Hive and readable on every
    site, but only a vote cast on LasseCash moves LasseCash rewards — a vote on
    PeakD or another Hive site stays a Hive vote.
  </p>

  <p class="dim">
    A new account can mint and trade straight away. To post, you first need
    L-Shares, which you get by minting. See
    <a href="/thresholds">Thresholds</a> for the exact amounts, and
    <a href="/about">How it works</a> for the full rules.
  </p>
</div>

<style>
  .start { max-width: 46rem; margin: 0 auto; padding: 1rem 0 3rem; }
  h1 { margin: 0 0 0.5rem; }
  .lede { margin: 0 0 1.4rem; color: var(--dim); }
  ol { list-style: none; padding: 0; margin: 0 0 1.4rem; display: grid; gap: 0.8rem; }
  li.panel { padding: 1rem 1.1rem; }
  li h2 { margin: 0 0 0.45rem; font-size: 1.05rem; }
  li p { margin: 0 0 0.6rem; }
  li p:last-child { margin-bottom: 0; }
  .dim { color: var(--dim); font-size: 0.9rem; }
  /* In-text links must read as links: the body copy is the same colour family. */
  .start p a:not(.button) { text-decoration: underline; text-underline-offset: 2px; }
  .tiers { width: 100%; border-collapse: collapse; margin: 0 0 0.6rem; font-size: 0.92rem; }
  .tiers td { padding: 0.35rem 0.5rem; border-top: 1px solid var(--line, rgba(255, 255, 255, 0.08)); vertical-align: top; }
  .tiers td.mono { font-family: var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; color: var(--gold); }
  .button {
    display: inline-block; padding: 0.5rem 0.9rem; border: 1px solid var(--gold-dim);
    border-radius: var(--r-sm, 4px); text-decoration: none; color: var(--gold);
  }
  .button:hover, .button:focus-visible { border-color: var(--gold); }
</style>
