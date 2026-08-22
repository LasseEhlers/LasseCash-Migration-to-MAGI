# MAGI / go-vsc-node — findings from building a large contract

Context: I'm migrating LasseCash (a 2019 Hive-Engine token, ~31M supply) to MAGI.
The core contract is ~90KB of TinyGo WASM with 28 entrypoints, and the migration
puts ~2,000 accounts through a Merkle-proof claim. Three throwaway deploys on
mainnet plus a local devnet so far.

Four things came out of that. Two are verifiable in your own source, one is a
question I can't cleanly answer, one is an API request.

---

## 1. `rc_limit` freezes the full declared limit, not the RC actually used

`modules/block-producer/blockProducer.go:437`

    didConsume, _ := rcSession.Consume(payer, slotHeight, int64(tx.RcLimit))

The declared limit is consumed at admission. Consumed RC thaws linearly over 5
days, so an over-declared `rc_limit` locks the account for days regardless of
what the call actually cost.

What it cost me: six calls at `rc_limit: 100,000` took `@lassecashmagi` from
usable to 0 available and locked it out for days. The account's capacity was
~22,000 RC (12 HBD + the 10,000 free), so the first call alone over-committed it.

Worse, one of those calls reported `ok: true` in its output and its state was
silently discarded at settlement. From the client side there is no way to tell
that apart from a success.

Second-order trap in the same area: `rc_limit` also reserves HBD (`PullBalance`
reserves `rc_limit − free_rc`), so a call that draws HBD needs a LOW `rc_limit`
or it starves its own draw. That one took a while to work out.

**Ask:** document it prominently — "declare what you're willing to lock for 5
days, not a safe upper bound" is the opposite of the intuition every EVM user
brings. Refunding the unused portion at settlement would be better, if that's
compatible with how admission works.

---

## 2. A missing state key reads as a non-nil pointer to an empty string

This one permanently bricked a real deploy.

`sdk.StateGetObject` returns `*string`. For a key that was never written, it
returns a valid pointer to `""` — not `nil`. So the obvious guard is wrong:

    func IsInit(s Store) bool { return s.Get(keyInit) != nil }   // always true

On my in-memory test store a virgin contract looked uninitialised and 40 tests
passed. On MAGI the same contract reported "already initialised" on its first
call, so `init` could never run. The contract was unusable from birth:

    vsc1BhcH9JyH8VGHJHpHF6XFAxyiAnXkWXHDy8   (10 HBD, dead on arrival)

The SDK itself already knows — `StateGetU64` checks `val == nil || *val == ""`.
The knowledge is in the code but not in the docs or the contract template, so
every new contract author gets to rediscover it by spending 10 HBD.

**Ask:** either collapse empty to absent in the SDK's own getter, or put a
warning in the go-contract-template README. This is the cheapest fix on the list
and it's the one that stops someone bricking a deploy.

Worth stating plainly why I care: LasseCash burns its owner keys at launch, so
the contract can never be updated. If those keys had been burned before I found
this, the project would have been permanently dead with no recovery path.

---

## 3. Question, not a claim: nested (`/`) keys and state that never lands

I don't have a clean attribution here, so I'm reporting the observation rather
than asserting a bug.

Observed on a mainnet throwaway whose state keys contained `/` (`bal/hive:alice`,
`shr/hive:alice`, …):

- calls executed, outputs reported `ok: true`
- `metadata.currentSize` grew
- `state_merkle` stayed at the empty-root CID `QmX4ymp…`
- no key was ever readable back via `getStateByKeys`

I re-keyed every key to flat `_` separators (`bal_hive:alice`), redeployed, and
state persisted immediately — real merkle CID, everything readable. That contract
is `vsc1BqLfLpKdMSfmHCe4o15ssWMiWJZw3yoZ8C` and it has been working since.

**The confound:** I lowered my `rc_limit` defaults at the same time, and per
finding #1 an RC-starved tx has its state discarded while still reporting
`ok: true`. Two variables changed together, so I can't honestly say the `/` was
the cause.

What makes me still think it's worth your time: `DataBin.Set` splits paths on
`/` into real directories (`lib/datalayer/dir.go:149`), nested directories are
what produce HAMT shards, and HEAD carries `materializeGetNode` fixing a HAMT
"two-path serialization divergence that causes non-deterministic CIDs" — dated
19 Aug 2026, days before I hit this. Non-deterministic CIDs across witnesses
would produce exactly the symptom I saw: execution fine, consensus on the
resulting state impossible, output still `ok: true`.

**Questions:**
1. Do the mainnet witnesses currently run that fix, or do deployed nodes lag HEAD?
2. Is `/` in contract state keys supported and intended? Every working mainnet
   contract I looked at (`hive_hbd_lp` etc.) uses flat keys, which is either
   convention or everyone else learning the same lesson quietly.
3. If it is supported, a round-trip test — write nested keys, save, reload, read
   back — would settle it permanently.

I've moved to flat keys and I'm staying there regardless, so this isn't blocking
me. It's the next person I'd worry about.

---

## 4. Contract outputs carry no error text over GraphQL

For a real (non-simulated) call, `results { ok ret }` is the whole type. When a
call fails there is no error string anywhere in the normal API — the only way to
get one is dropping to the raw DAG:

    getDagByCID(output.id)   →   errMsg

`simulateContractCalls` does return `ErrMsg` (`modules/gql/gqlgen/schema.resolvers.go`),
so the field exists on the simulate path but not on real outputs. Diagnosing a
failed mainnet call currently means knowing the DAG trick exists.

**Ask:** surface `errMsg` on contract outputs in GraphQL.

---

## 5. A request: `RC_HIVE_FREE_AMOUNT` is load-bearing for us

`modules/common/params/params.go:194`

    var RC_HIVE_FREE_AMOUNT int64 = 10_000   // 5 HBD worth of RCs for Hive accounts

The LasseCash migration is pull-based: one Merkle root on-chain, and ~2,000
holders each claim their own leaf paying their own RC. Measured on the devnet, a
staked claim costs 4,017 RC and 5,892 worst case, so it fits inside a fresh
account's free tier with headroom. That is the entire reason the design works —
the alternative (owner pushes every account) needs ~8.8M RC, which is thousands
of HBD parked on MAGI, which I do not have.

So this parameter is a hard external dependency for us, and it is a `var` that
moves in node releases.

**The ask:** if `RC_HIVE_FREE_AMOUNT` is ever going to drop, I would like to know
before it happens rather than from support messages. Anything below ~6,000 breaks
claiming for staked positions. I am not asking anyone to freeze a parameter for
me — advance notice is enough, because I can extend the claim window or publish
guidance if I know it is coming.

Related question while I am asking: **is there a channel where node releases and
consensus-parameter changes are announced?** I could not find one, and I would
subscribe to it.

## 6. Question: does anything in MAGI assume a contract still has an owner?

LasseCash burns its owner keys at an announced height shortly after launch, so
the contract can never be updated again. That is a deliberate product decision,
not something I want talked out of — but it means I cannot adapt to anything
afterwards.

What I would like to know before that height:

1. **What version do mainnet witnesses currently run**, and how far do deployed
   nodes typically lag HEAD? (This is also what would settle finding #3.)
2. **Does any part of the protocol require a contract owner to act, ever?** For
   example a future migration, a re-registration, a storage-renewal, or anything
   where an ownerless contract would be treated as abandoned. If such a thing is
   planned or even considered, an ownerless contract is a landmine and I need to
   know now rather than after the keys are gone.
3. Is there any precedent for an ownerless contract on MAGI, or would mine be the
   first?

Nobody may have thought about this case yet, which is exactly why I am asking
early. Happy to be told "no idea, you are the first" — that is a useful answer.

---

Everything above is reproducible and I am glad to provide tx ids, CIDs, or a
minimal repro for any of it.

---

## 7. `simulateContractCalls` under-reports what settlement charges

Measured on mainnet 2026-08-22 (contract `vsc1BoLgTEZhcQKSGi9vCZN12yVjmM4mnvWrLB`):

| call | simulated gas | real outcome |
|---|---|---|
| `mint` | 314M (≈3,142 RC) | `gas_limit_hit` at `rc_limit` 4,000 |
| `claim_migration` (worst case) | 556M (≈5,563 RC) | `gas_limit_hit` at 9,500 on one account; CONFIRMED at 9,500 on another |

The simulator appears not to apply the IO weighting (`WRITE_IO_GAS_RC_COST`)
that settlement applies, so write-heavy calls land well above their simulated
figure — by more than 1.3x in the mint case. Clients cannot size `rc_limit`
from the simulation without a large fudge factor, which (per finding 1) then
over-freezes the account.

Request: either apply the same cost model in simulation, or return both
figures (`gas_used` and the RC that settlement would charge).

## 8. A failed output carries no gas figure

`getDagByCID(output)` for a `gas_limit_hit` result carries only
`{err, errMsg, ok, ret}`. There is no way to learn how much gas the call used
before it died, so the gap in finding 7 cannot be measured from the chain;
it can only be bracketed by trial. `gas_used` on outputs (success and
failure) would make RC budgeting an engineering question instead of a guess.
