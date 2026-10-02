# Where the test world is kinder than MAGI

Two bugs that would have been fatal after a key burn came from the same place,
and neither was a formula:

| | the fake | the chain | cost |
|---|---|---|---|
| 2026-08-20 | `MemStore` returned nil for a missing key | MAGI returns a pointer to an empty string | a deploy bricked from birth |
| 2026-10-02 | token and core were ONE in-memory world | two contracts, one adopted eight days late | 9.19M of backing never minted |

So the audit is not "look for more bugs in the economics" (that is the best-tested
part of the project: 75 simulated years, 500,000 fuzzed economies, three mainnet
throwaways). It is: **list every way the test environment is nicer than the
chain, and close each one, or measure it on the chain.**

Status is one of: CLOSED (a test or monitor now covers it), VERIFIED ON CHAIN
(observed on production or a throwaway), OPEN.

## 1. A missing key reads as an empty string — CLOSED
`MemStore.Get` returns `&""` for a missing key and every read goes through
`get()`. Pinned by `TestMissingKeysBehaveTheWayMagiReportsThem`.

## 2. The token and the core are separate contracts — CLOSED, two layers
- `float_test.go` (`adoptTokenLate`) reproduces the late adoption in a test.
- `tools/audit-production.py` asks the live chain the supply invariant. It
  would have gone red on 8 September. Run it after EVERY update and on a timer.

## 3. A cross-contract call can fail — VERIFIED ON CHAIN (one observation)
`tokenLedger` assumes `sdk.ContractCall` aborts and unwinds the whole
transaction when the callee fails, and its bool returns therefore never see
`false`. MemStore cannot test that: it has no callee that fails.

Production gave one real observation on 2 October. The claim of 7,005,065 was
refused by the token (`Insufficient balance`). Afterwards, read from state:
`mint_hive:lasseehlers_1` is `700506573374918|700506573374918|109512118|30|0|0|0|0`
— field 6 (`Ended`) is `0`, the principal is intact, and `mig_hive:lasseehlers`
is untouched. So a failure on the token side left NO partial write. A claim that
fails is retryable by design, not by luck.
Limit of the evidence: one failure, of one kind (insufficient balance), on one
path (claim). It says nothing yet about a failed `mint` into the float or a
failed transfer in the middle of a pool call. OPEN for those.

## 4. Gas and RC — VERIFIED ON CHAIN per path, OPEN at the extremes
MemStore has infinite gas. Measured on mainnet: transfer, mint, claim, drain,
the 1200-day walk (unpayable in one call, hence `advance` slices). Not measured:
anything at a state size the chain has not reached yet — the board at 20 seats
all contested, a curation queue at exactly `MaxCurationDrain` deep, a claim
landing in the same block as many others (same-block mints cost up to 3x their
simulation; seen on throwaway #8).

## 5. `ctx.Height` is the transaction's anchor height, not the block's — KNOWN
Matters to anything that predicts a payout off-chain.

## 6. Sender namespacing (`hive:alice`, never `alice`) — CLOSED
Contract refuses an unqualified recipient. `TestTransferRefusesUnqualifiedRecipient`.

## 7. Units at a seam (HBD milli vs 1e8) — CLOSED
`HbdDrawMilli` / `HbdPayMilli`, pinned. Found by a mainnet broadcast, not a test.
The token is decimals=8 so LASSECASH has no conversion; keep it that way.

## 8. Flat keys only (no `/` in a state key) — CLOSED
Slashes are silently dropped on the deployed node. Every key is flat.

## 9. State written by an older version of the code — OPEN, and the sharpest one
Every test starts from state the CURRENT code wrote. Production holds state
written by FOUR different code versions (launch, token ledger, rename, and the
float fix on Sunday). The float shortfall was exactly this: state from before an
upgrade that no later code revisited. `tools/state-snapshot.py` diffs state
across an update and catches keys that MOVE; it cannot see a key that is simply
missing something it should have. Candidate test: for every `MemStore` test,
also run it from a state seeded by the LAUNCH-era layout and migrated forward.

## 10. The first era boundary (halving, 2029) — OPEN, needs a real chain
Emission is a closed form pinned to real heights, so a test build cannot
compress it. `TestSeventyFiveYearRun` crosses it in MemStore only. A throwaway
initialised with a genesis backdated ~3 years would put the chain across the
boundary immediately. Costs 10 HBD plus RC for the catch-up slices. Ask first.

## What I would do next, in order
1. Item 3, the rest: simulate on a throwaway a token failure in the middle of a
   pool call and a monthly mint. Free if done through `simulateContractCalls`.
2. Item 9: the launch-layout migration test. Free, Go only.
3. Cron for `tools/audit-production.py`. Free.
4. Item 10 on a throwaway, only after you say so.
