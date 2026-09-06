# Throwaway #10 — the token ledger on MAINNET

Everything below has already passed on the local devnet
(`tools/devnet/prove-token-ledger.sh`) and in 500,000 fuzzed economies. This
is the part the devnet cannot answer: **mainnet consensus, real Keychain, and
whether one wallet confirm can carry an allowance to one contract and a call
to another.**

TibFox's caveat applies in reverse here too — treat "devnet says X" as strong
evidence and confirm consensus-critical behaviour against mainnet, because
mainnet witnesses may run a different node version than our checkout.

## Cost and the reason to only do this once

**A retry costs 10, not 20.** The token is vsc-eco's code, unmodified — any
bug found will be in OUR core, so only the core is redeployed. The token
deploy is a one-time cost.

Two deploys at 10 HBD each = **20 HBD**, from @lassecashmagi's **Hive L1**
balance (31.898 HBD on 2026-09-06 — the fee is an L1 transfer; MAGI HBD
cannot pay it). That leaves ~12, which is not enough for a second attempt.
**So the fuzzer finishes first.** If it finds a supply leak the build changes,
and a throwaway of the old build teaches nothing about the new one.

## Order — and it is not the obvious one

`migrate_ledger` MINTS, and only the owner can mint, so **the token's
ownership must be handed to the core BEFORE any migration**. Writing the
devnet proof is what caught this; the plan originally had it backwards.

```
1. ./build.sh wasm                      # the mainnet build, from this branch
2. deploy the TOKEN      (10 HBD)       # magi-token.wasm
3. token: init                          # decimals 8, maxSupply 5_100_000_000_000_000
4. deploy the CORE       (10 HBD)       # main.wasm, token-ledger branch
5. core:  init <genesisHeight>
6. token: changeOwner -> contract:<core>    ← NO HUMAN CAN MINT AFTER THIS
7. core:  set_token <tokenId>
8. core:  set_snapshot <root>|<total>|<burn>
9. verify: token totalSupply == core sup_migrated, and balanceOf(hive:null)
           equals the burn total
```

## What only mainnet can prove

| | why the devnet cannot answer it |
|---|---|
| ~~One Keychain confirm signs an allowance on one contract and a call on another~~ | ✅ **ALREADY PROVEN ON MAINNET** — Lasse's BTC swap of 2026-09-03 was CONFIRMED carrying `increaseAllowance` -> `vsc1BdrQ6Etb…` and `execute` -> `vsc1Brvi4YZ…`, two calls to two different contracts in one confirm. That was the single largest assumption in the design and it was retired by an ordinary swap. What remains is confirming OUR specific flow, not whether the mechanism exists |
| A real `claim_migration` from a fresh account's free 10,000 RC | mainnet FREEZES the full `rc_limit` for 5 days; the devnet charges only what is used |
| `state-snapshot.py diff` across a code update | the update timelock is a mainnet mechanism |
| `entrypoint-sweep/sweep.py` — every entrypoint answers as before, plus the two new ones | consensus behaviour |

## The wallet test, in order (this is the point of the exercise)

1. Sign in on a build pointed at the throwaway.
2. **Mint a small amount.** Watch for ONE prompt. Two prompts, or a refusal,
   means the bundling is wrong and the design needs the site to ask twice —
   worth knowing before the burn, not after.
3. Transfer to another account; confirm the balance moves in the TOKEN
   (`balanceOf`, not `getStateByKeys` — the node destroys the raw bytes).
4. Add liquidity: allowance for LASSECASH **and** the HBD intent in the same
   transaction. The most complex signed call in the product.
5. Sell into the pool (`swap_lc_hbd`), which debits LASSECASH.
6. Claim a migration position from a FRESH account with untouched RC.

## Then, and only then

The production sequence in `docs/TOKEN-LEDGER-PLAN.md`: deploy the real
token, queue the core update behind its 48-hour public timelock, hand the
token over, sweep the rows, and announce the burn height.

## Rollback

Nothing here touches production. The throwaway is a separate contract id with
its own owner key; the live contract cannot be affected by anything in this
document.
