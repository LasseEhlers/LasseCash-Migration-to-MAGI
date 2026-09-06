# Who has still not claimed — full audit, 6 Sep 2026

Every claimable account in the published snapshot, checked against `mig_<acct>`
on the production contract.

## The headline

| | |
|---|---|
| Claimable accounts in the snapshot | 353 |
| **Claimed** | **28 (7.9%)** |
| **Not claimed** | **325 (92.1%)** |
| LASSECASH still unclaimed | **2,692,167.41** |
| Share of value claimed | 77.1% |

**7.9% of people, 77.1% of the value.** The gap is the founder: one account is
most of what has been claimed. By headcount almost nobody has come.

### The arithmetic reconciles exactly

| | |
|---|---|
| snapshot claimable total | 11,730,692.25 |
| chain `sup_claimed` | 9,038,524.84 |
| unclaimed, summed from this audit | 2,692,167.41 |
| claimed + unclaimed | **11,730,692.25** |
| difference | **0.00** |

It also equals `cfg_migtotal`, the figure committed on chain at genesis. So the
list is complete and nothing is missing or double-counted.

## The part that decides what to do next

| segment | accounts | LASSECASH | contacted in round 1? |
|---|---|---|---|
| holds ≥ 1,000 | 70 | 2,667,623.79 | **all 70, yes** |
| holds < 1,000 | 255 | 24,543.62 | none |

**Round 1 was well targeted and it did not work.** Every single account holding
1,000 or more was already written to on 1 September, and every one of them has
still not claimed. The 255 never contacted hold 0.9% of the value between them.

So a second copy of the same letter is not the move. Those 70 people received a
message, and either did not see it, could not act on it, or chose not to.

Top of the list: `airanmilian` 413,066 · `aggroed` 308,855 · `eonwarped`
251,852 · `vocup` 226,848 · `fighter4-freedom` 218,514 · `marshmellowman`
140,000 · `patif2025` 107,022 · `cedricguillas` 100,000. The top 20 are 84% of
everything unclaimed. Full ranked list with contact status:
`tools/unclaimed-2026-09-06.json`.

## ~~Something in round 1 is now FALSE~~ — RETRACTED the same evening

This section claimed the round-1 letter's "keys burn on 10 October" was now
wrong. **It is not. 10 October stands.** The claim rested on a stale line in
the plan written when the ledger looked like weeks of work; Lasse caught it
within the hour. Nothing in the letter needs correcting, and nobody should be
written to about a date change. Kept here struck through rather than deleted
so the record shows what was nearly sent.

## What the second round should actually say

Not "claim your tokens" again. Three things they do not know:

1. **LASSECASH is now a standard MAGI token** — it works with MAGI's own
   wallets, indexer and cross-chain swaps, and the 10 October burn is
   unchanged.
2. **30 September is now three weeks away**, not four, and it is the line
   between a position that earns and one that merely exists.
3. **Claiming costs nothing** — it fits inside the free resource allowance
   every Hive account already has. Nobody has to buy anything to collect.

## Two operational notes before any second run

- **`tools/outreach.js` will skip all of them.** It filters against
  `deploy-data/outreach-progress.json` by mode, and `comment` and `memo`
  already list these accounts. A second round needs its own mode key, or it
  will report "nothing to do" and look like a success.
- **The comment path needs the POSTING key** in `deploy-data/postingKey.txt`,
  not the active key. Verified on mainnet: Hive does not let active stand in
  for posting here.

## The uncomfortable read

The migration is technically finished and socially barely started. 325 people
have tokens they have not collected, three weeks before the terms get worse,
and the one group we know received a letter is exactly the group that did not
act. Whatever is stopping them, it is not that they were not told.

Worth answering before 30 September rather than after.
