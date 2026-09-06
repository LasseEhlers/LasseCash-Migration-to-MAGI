# Could LASSECASH be a standard `magi_token`? — spike, 2026-09-06

Prompted by TibFox (MAGI, vsc-devs) on 6 Sep: *"if you would have used the
tools we have nobody had to do anything to make your pool or token work with
our indexer or the altera interface and the cross-chain swaps. btc to
lassecash would have been a simple flag we had to turn on."*

Fair, and the 20 Aug decision never evaluated `vsc-eco/magi_token-contract`.
This is what the SOURCE says, before any measurement. Read at
`vsc-eco/magi_token-contract` (main, Sep 2026) and go-vsc-node
`modules/contract/execution-context/execution-context.go`.

## ✅ A contract CAN own and drive a magi_token — confirmed from source

1. **A cross-contract call re-labels the caller.** `ContractCall` builds the
   child environment with `Caller: "contract:" + ctx.env.ContractId` and
   `Sender: ctx.env.Sender` — so inside the token, `msg.caller` is the CALLING
   CONTRACT, while the original human stays as `sender`. Recursion depth is
   capped at 20 (`CONTRACT_CALL_MAX_RECURSION_DEPTH`).
2. **The token's owner check is `stored owner == msg.caller`** (`getOwner()`
   in `contract/main.go`), and `ChangeOwner` validates only length and the
   absence of `|` — so `contract:vsc1…` is a perfectly good owner.
3. **Therefore:** deploy the token, `init` it as `hive:lassecashmagi` (init
   requires `msg.caller == contract.owner`), then `changeOwner` to
   `contract:<core id>`. From then on the core mints as owner, and no human
   can.

So the mechanism exists. The cost is in the shape.

## ⚠️ What the standard does NOT do, and it matters for THIS contract

| | |
|---|---|
| **`mint` credits the OWNER, not an address** — `incBalance(owner, amount)` | Paying a user is **two** cross-contract calls: mint to core, then transfer core → user. Our current payout is one state write. |
| **Taking a user's tokens needs `approve` then `transferFrom`** (allowance keyed by `msg.caller` as spender) | Every value-TAKING action (mint/lock, promote, add_liquidity) becomes approve + action. Bundleable in one Hive transaction — the site already does exactly that for the BTC swap (`increaseAllowance` + `execute`) — but it is still two calls, both charged. |
| **No batch anything.** Entrypoints are init, mint, burn, transfer, transferFrom, approve, increase/decreaseAllowance, changeOwner, pause, unpause + 6 read-only | ⚠️ **MEASURED 2026-09-06 AND LARGELY WITHDRAWN — see below.** Only ONE balance movement in the whole contract sits inside a loop. |
| **JSON + `big.Int`** throughout | Heavier per call than our pipe-delimited fixed-point. Gas is charged to the user's RC. |

## ✅ THE BULK WORRY IS WITHDRAWN — checked 2026-09-06

Every `credit()`/`debit()` call site was examined for an enclosing loop. There
are 22 (11 outside `ledger.go`, across four files) and **exactly one is inside
a loop: `CreditMigrationBatch` (ledger.go:418)** — the owner-only push import.

Every runtime path — payout, claim, mint, claim_mint, transfer, burn, swap,
add/remove liquidity, claim_pool — moves **one account's balance per call**.
Curation drains, `SettlePending` and the expiry walk work on *pending
balances* and *shares*, which are core-internal state and would not move to
the token at all.

So "no batch transfer" bites exactly one thing: the one-time ledger
migration, which we run ourselves and can cut into batches of ten. **The live
contract never needs a batch transfer.** This was the strongest objection to
the whole idea and it does not survive contact with the code.

## ✅ MEASURED ON THE DEVNET, 2026-09-06 — it is cheap, and ownership works

`tools/devnet/measure-token-ledger.sh`, against a real `magi_token` built from
vsc-eco's source and a probe contract that does *n* of one thing, so the fixed
entry cost cancels in the subtraction `(gas(n=5) − gas(n=1)) / 4`.

| one operation | marginal gas | RC | |
|---|---|---|---|
| local state write (what a credit costs today) | 9,701,766 | **97** | |
| **cross-contract `transfer` into the token** | 30,131,556 | **301** | 3.1x a local write |
| cross-contract state READ | 1,700,778 | **17** | cheaper than a local write |
| entry/parse floor (`noop`) | 0 | 0 | |

**A balance movement costs +204 RC.** Projected onto real actions:

| | today | with a token ledger |
|---|---|---|
| `claim_migration` | 4,017–5,892 RC | **4,221–6,096 RC** |
| `mint` (lock: approve + transferFrom) | 1,976 RC | ~2,385 RC |
| `transfer` | 285 RC | ~489 RC |

**A claim still fits a fresh account's free 10,000 RC with ~3,900 to spare.**
The concern that opened this spike does not materialise — nobody has to buy
HBD to claim. (Lasse had already ruled it a non-blocker either way; it turns
out not to be a cost at all.)

Reads being cheaper than local writes is a design lever: the core can read
balances straight out of the token (`ContractStateGet`, 17 RC) and pay the
301 only when it moves value.

### ✅ A CONTRACT CAN OWN THE TOKEN — proven on-chain, not inferred

`changeOwner` to `contract:vsc1BcHL18…` was CONFIRMED; the token's `owner`
key then read `contract:vsc1BcHL18…`, and the previous human owner was
refused: **`Must be owner to mint`**. That is the load-bearing claim of the
whole design, and it holds against a running node.

⚠️ Devnet caveat (CLAUDE.md): the devnet charges ACTUAL RC while mainnet
freezes the full `rc_limit`. Gas is the trustworthy figure here, and RC is
derived from it at the fixed 100,000 gas = 1 RC. Re-validate budgets on a
mainnet throwaway before committing.

## 🟡 The original framing — no longer a veto

**Lasse's call, 2026-09-06:** the free-RC claim ceiling is NOT a blocker.
*"I dont care if new people can claim with 10000 or not… we can make a clear
message to make them buy hbd if they want to claim… having the token as
native is much more important than that temporary claim process."* He is
right on the weighting: the claim window closes ~March 2027
(`MigrationMintDays 30 + GraceDays 90 + BleedDays 90` from genesis), so it is
a temporary friction on a shrinking group, against a permanent property of
the token. Recorded so it is not re-litigated.

The measurement still runs, because the cost of every ordinary action (post,
vote, mint, swap) is a real UX price worth knowing — but it is a price to
accept or reject, not a viability test.

### Original framing, kept for the record

**What does a `claim_migration` cost in RC once the balance lives in another
contract?** Today it is 4,017–5,892 RC, inside a fresh account's free 10,000,
and *that is the whole premise of claim-based migration*: every holder claims
their own leaf paying nothing. A claim credits liquid AND creates a mint, so
on the new shape it is core state + mint call + transfer call, each with JSON
and big.Int.

**If it crosses 10,000, fresh accounts can no longer claim for free and the
migration model breaks.** 2,692,167 LASSECASH is still unclaimed by people who
will claim exactly that way. Measure before anything else; the local devnet
(`tools/devnet/`) does it for free.

Second measurement, same run: a monthly PoB payout and a `settle` walk, which
are the bulk paths.

## 🔴 The frozen-dependency problem, sharpened

If the core owns the token and the core's key burns, `changeOwner` can never
be called again — by anyone. The core can only speak v1's interface with v1's
payloads. **If MAGI ships a token v2 and their indexer keys on it, we are
frozen on v1 with no migration path.** Partial mitigation: keep the token's
contract id in a STATE key rather than hardcoded, so a compatible redeploy can
be pointed at. A breaking v2 remains unfixable — which is the same class of
risk that kept the pool in-contract, and this time it is structural rather
than a preference.

## What is NOT in question

The pool stays ours regardless. Their router charges 0.08% (our 0% is a
hardcoded promise), and their LP tokens are fungible and ageless — no tranche,
no loyalty curve, no 180-day eviction, so the 25% emission slice could not be
paid through them. Mints, Proof-of-Brain, thresholds and the claim tree have
no standard at all. TibFox is not claiming otherwise; his point is the LEDGER,
and on the ledger he is right.

## Options, and what each really buys

| | Recovers | Costs |
|---|---|---|
| **Hardfork to a standard ledger before the burn** | everything, natively, no second token | A rewrite of the money layer of a live contract; owner-push import of ~353 accounts (cheap at this size, rehearsed in Aug); 2 LPs re-add manually; burn date moves ~November; the RC risk above; the frozen-v1 weld |
| **Wrapper dApp after the burn** — own key, holds LASSECASH on our ledger, issues a 1:1 `magi_token` | Altera, their indexer, token-sdk wallets, the BTC flag — for the WRAPPED token | Two tokens for the core's life; an unwrap step (bundleable into the next action); wrapped pool is thin unless seeded |
| **Do nothing** | — | Invisible to their tools; no BTC route |

**Lasse's position (6 Sep): the wrapper is a last resort — with 4 days of
history a hardfork is at its cheapest, and he wants it right the first time.
Agreed on the principle; the RC measurement decides whether it is possible.**

## Next

1. TibFox: can a magi_token be a router pool asset against HBD, and is that
   what turns on the cross-chain-swap flag? Is v1 what the indexer keys on?
   (Asked 6 Sep.)
2. Devnet: measure a claim, a payout and a settle walk on the cross-contract
   shape. This is the go/no-go.
