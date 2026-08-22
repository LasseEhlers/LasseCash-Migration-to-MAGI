/**
 * "≈ X HBD" beside a LASSECASH figure.
 *
 * WHY THIS EXISTS. LASSECASH is the unit of account everywhere on this site,
 * and it should stay that way — but nobody has an intuition for what 3,400 LC
 * is worth. HBD is pegged to a dollar, so one extra line turns every reward
 * figure into something a reader can size up.
 *
 * WHERE THE NUMBER COMES FROM. `engine.lcToHbd`, in Go, at the pool's spot
 * price. Nothing here divides anything: a price conversion is money math, and
 * money math has exactly one implementation (CLAUDE.md, golden rule). This file
 * holds the *preference* — whether to show it at all — and nothing else.
 *
 * IT IS AN ESTIMATE, always. The reserves move between reading and acting, so
 * every rendered figure carries the "≈" and dim styling that says so.
 */
import { lcToHbd, toBaseUnitArg, type Amount } from "$api/index.js";
import { chain } from "$lib/chain.svelte.js";

const KEY = "lassecash:showHbd";

/**
 * Whether to show HBD equivalents. DEFAULT ON.
 *
 * Stored per browser. Every access is wrapped: a private window can throw on
 * read, and a preference is never worth an error dialog.
 */
class HbdPreference {
  show = $state(true);

  /** Call once, in the browser. localStorage does not exist during SSR. */
  restore() {
    try {
      // Only an explicit "0" turns it off — an absent key means "never chose",
      // which is the default, which is on.
      if (localStorage.getItem(KEY) === "0") this.show = false;
    } catch {
      /* no stored preference is a fine state to be in */
    }
  }

  toggle() {
    this.show = !this.show;
    try {
      localStorage.setItem(KEY, this.show ? "1" : "0");
    } catch {
      /* not worth an error */
    }
  }
}

export const hbdPref = new HbdPreference();

/**
 * A LASSECASH amount at the pool's spot price, or null when there is nothing
 * honest to show.
 *
 * Null covers four different "no": the reader turned it off, the engine has
 * not loaded, the chain has not been read yet, and — the one that matters —
 * THE POOL IS UNSEEDED. Before the first `add_liquidity` there is no price at
 * all, and printing "≈ 0.000 HBD" would read as "worthless" rather than "not
 * known yet". Callers render nothing on null.
 */
export function hbdValue(amount: Amount | null | undefined): Amount | null {
  if (!hbdPref.show || !amount) return null;
  if (!chain.ready || !chain.info) return null;
  try {
    return lcToHbd(
      toBaseUnitArg(amount),
      toBaseUnitArg(chain.info.amm_lc),
      toBaseUnitArg(chain.info.amm_hbd),
    );
  } catch {
    // A malformed amount is a caller bug, not something to blow up a page over.
    return null;
  }
}
