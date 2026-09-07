# What is left before 10 October — six dates, not full-time

Written 2026-09-07, when the question became "are we done?" rather than
"does it work?".

## The code is finished. What remains is TIME.

Nothing on the list below is a hunt for bugs. Every one is an event that
cannot be made to happen early, so the only way to see it is to be there.

**Proven and closed:** 500,000 fuzzed economies with zero failures · every
entrypoint answering on mainnet · every wallet flow signed by a real Keychain ·
the update mechanism preserving state byte-identically, twice · the token
ledger byte-identical to the artifact going live · claim, mint, transfer,
burn, add liquidity, swap, early end all confirmed on chain with supply
conserving exactly · the sweep linear at 822 RC per account.

**The two findings that justified the last two weeks**, both landing 8 Sep:
`fund`, which lets any future dApp feed the four reward pools from outside;
and the standard-token ledger, which is what makes LASSECASH work with MAGI's
own wallets, indexer and cross-chain swaps.

## The six dates

| when | what | why it cannot be tested early |
|---|---|---|
| **Mon 7 Sep 21:21** | first post payout window closes | the 7-day viral window; also the only chance to measure the curation drain against a genuinely payable backlog (baseline 2,467 RC at depth 13 is recorded in CLAUDE.md) |
| **Tue 8 Sep 17:02** | the 1-day mint on throwaway #10 matures | the last untested shape: a matured mint paying principal + yield OUT of the token |
| **Tue 8 Sep 21:23** | production update activates | then, in order: state diff + sweep, `changeOwner`, `set_token`, `migrate_ledger` (21 rows, one call) |
| **Wed 30 Sep 18:00** | day 30 — every migration mint matures together | **now small**: `explc_30` holds 2 chunks, so ~2 `advance` calls clear it. The scale risk evaporated because only 28 accounts claimed. It grows if the outreach lands more claims, and throwaway #8 already proved the retire budget resumes across calls |
| **Thu 1 Oct** | first monthly Proof-of-Brain mint | **the one thing that can never be compressed.** TESTWINDOWS shrinks days, not calendars. A month boundary happens when it happens |
| **Sat 10 Oct** | the key burn | |

## Why the burn date still holds

If 1 October surprises us, the last moment to queue a corrective update is
**8 Oct 18:00 UTC** — a seven-day margin between the last untestable event and
the point of no return. That is why 10 October is defensible rather than
brave.

## The honest allocation

**Not full time.** There is nothing left to hunt; there is something to
attend. Be present on those six dates, and spend the rest on music.

The one thing worth more than testing between now and 30 September is
**getting more people to claim**. Only 28 of 353 have. Every extra claimer
makes day 30 a slightly bigger event, which is exactly the kind of load worth
having before the door closes rather than after.
