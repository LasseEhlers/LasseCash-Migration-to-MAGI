# LasseCash → MAGI — Launch-Day Runbook

> The whole migration, in order, with the command for each step and what must
> be true before the next. Written 2026-08-21 for the CLAIM-based migration.
> If anything here disagrees with CLAUDE.md, CLAUDE.md wins — fix this file.
>
> Money facts: the production deploy costs **10 HBD on Hive L1**; the three
> owner transactions cost a few thousand RC; the pool seed draws the HBD you
> choose. **Every step marked 💸 spends real money or is irreversible.**

---

## 0. GO / NO-GO — all of these must be true before T-7

- [ ] **Wallet evening passed** on a mainnet throwaway: Keychain signed a
      `claim_migration` with a real proof, a `mint`, a `post`, a `vote`, and an
      `add_liquidity` with its HBD intent. (The one thing neither simulator
      nor devnet can prove.)
- [ ] **Devnet measurements recorded** in `tools/devnet/README.md` and the
      `RC_LIMITS` table in `api/src/aioha-signer.ts` updated from them
      (claim_migration, record_burn, advance across the migration maturity
      day). `npm test` pins the headroom.
- [ ] `./build.sh` all green: engine, contract, simulator, API, typecheck.
- [ ] `FUZZ_ROUNDS=100000 go test -run TestFuzzEconomy ./state/` clean on the
      final contract code.
- [ ] **Production WASM is the MAINNET build**: `./build.sh wasm` (NOT
      `wasm-test`; NOT `-tags push`). `contract/artifacts/main.wasm` has 26
      entrypoints. Record its size and sha256 here: ______
- [ ] Spec `.odt` updated from `docs/Spec changes since v1.md`; `.md` regenerated.
- [ ] Final announcement drafted (block X, the 3-month rule, how to stay
      alive, how to claim, the 150-day window, Hive-Engine token is dead).
- [ ] Hive-Engine token info text drafted.
- [ ] `@lasseehlers` (the deployer/owner) holds: **≥ 12 HBD on Hive L1**
      (deploy fee + margin), **≥ 15 HBD on MAGI** (RC for init, set_snapshot,
      claim, pool seed ≈ 12k RC — 10k free + HBD), plus the **pool HBD** (100).
- [ ] `deploy-data/config/identityConfig.json` holds the ACTIVE key of the
      owner account; `./deploy.sh preflight` passes.

## 1. T-7 days — the final announcement

Post from **@lasseehlers** on lassecash.com/Hive. Must contain:
block X (snapshot height), the 3-month rule with the exact qualifying
operations, "voting/posting do NOT count", the one-week roll call, "claim on
lassecash.com within 150 days of genesis", "unclaimed goes to the reward
pool", "Hive-Engine LASSECASH is dead after block X — do not buy it".
Pin it. Update the Hive-Engine token info tab to point at it.

## 2. T-0 — block X passes: take the snapshot

Hive-Engine has no historical balance query, so the snapshot IS the moment
you fetch. Do it promptly at X and record the Hive-Engine block you saw.

```bash
cd tools/snapshot
python3 fetch.py balances            # every LASSECASH holder, ~1 min
python3 fetch.py activity            # signed-ops liveness, ~1 h, resumable
python3 apply_criteria.py --write    # 6-month C6 window → migration_set.json
python3 check_snapshot.py            # INVARIANTS — must exit 0
python3 build_status.py              # /check shards for the roll-call page
```

**`check_snapshot.py` is not optional and its failure is a stop.** Every
serious defect in this pipeline was previously found by a human reading
terminal output, which is not a control: on 2026-08-23 a resuming balance scan
double-counted ~74,000 LASSECASH and pushed the snapshot 81,150 over the
hardcap, and it was caught only because someone happened to read the line.

Do NOT widen a tolerance to make it pass. The two baselines it pins — the
Hive-Engine supply drift and the snapshot total — are CONSTANTS unless our
capture changed, because nothing issues or burns LASSECASH on Hive-Engine any
more. A move means tokens counted twice or a holding bucket missed. Re-baseline
only with a written reason, and re-run the injected-fault self-test after any
change to the checks (an assertion that has never failed is not known to work —
the first version of these checks passed a 72,023 LASSECASH phantom balance
because there was hardcap headroom to hide in).

Re-run `fetch.py activity` once more if the first run reported any
`search_truncated` accounts with no signal (see CLAUDE.md; retry resolves
node failures).

```bash
cd ../.. && ./build.sh tree          # root.json, leaves.json, proofs/*.json
(cd node && go test ./migtree/)      # published root reproduces from files
python3 tools/snapshot/make_admin_data.py
```
Record: root ______ · qualifier_total ______ · burn_total ______ · leaves ______

**Publish the record (irreversible, public):**
```bash
git add -A && git commit -m "Migration snapshot at Hive block X: root <root>" && git push
```
Then a Hive post from @lasseehlers: the root, the GitHub commit hash, the
totals, and the leaf count. This post + the commit are the permanent proof of
who held what.

## 3. 💸 Deploy the production contract (10 HBD)

```bash
sha256sum contract/artifacts/main.wasm      # must match §0
./deploy.sh preflight
./deploy.sh deploy                          # 10 HBD from Hive L1
```
Record the contract id ______ and code CID ______. Verify with
`getStateByKeys` that the contract has NO state yet (virgin), and that the
CID's bytes hash to the WASM above.

Put the id in `web/.env.production` (`VITE_CONTRACT_ID`, `VITE_MAGI_NET_ID=
vsc-mainnet`, `VITE_CHAIN_URL=https://api.vsc.eco/api/v1/graphql`, and NO
`VITE_TESTWINDOWS`).

## 4. 💸 Genesis — two owner transactions, in this order

Genesis height = the Hive height at which you broadcast `init`. Emission,
the 30-day migration mints, the 150-day claim window and the share-rate
ratchet all count from it. Read it from `localNodeInfo.last_processed_block`
right before broadcasting and use that exact number.

```
init            <genesisHeight>                         rc_limit  1000
set_snapshot    <root>|<qualifier_total>|<burn_total>   rc_limit  2000
```
Verify after each (read state, not the output's ok:true — see the RC-freeze
trap in CLAUDE.md): `cfg_init="1"`, `cfg_genesis=<height>`, then
`cfg_migroot=<root>` and `bal_hive:null=<burn_total>`.

**Do NOT broadcast anything else from the owner account until §6.**

## 5. Ship the site and claim

Deploy the frontend with the `migration/` static files. Then, as a normal
user on lassecash.com: sign in with Keychain, **Claim** your migration.
Verify your mint card appears and `shr_hive:lasseehlers` reads your staked
figure. Let a friend claim too before announcing "claims are open".

## 6. 💸 Seed the pool

Look up the Hive-Engine price of the day. On the Pool page: opening price,
your HBD, LASSECASH derives. One click. Verify `amm_lc` / `amm_hbd` read
back exactly what you entered.

## 7. 💸 Burn the owner keys — IRREVERSIBLE — at DAY 40

DECIDED 2026-08-21, MOVED 35 -> 40 ON 2026-08-23: the key is destroyed at a
block height announced in the genesis post, ≈ day 40 after genesis.
**Block Y = genesis + 40 × 28,800 = genesis + 1,152,000.**

**Why day 40 and not 35.** Day 35 left the first FULL monthly Proof-of-Brain
mint — the one on the 1st of the second month, with a real month of pending
balances behind it — only one day of margin before the burn. A mainnet code
update carries a 48-hour timelock (below), so a defect found in that payout
could not have been fixed in time. Day 40 gives roughly a week. The margin is
free; the burn is the single most irreversible act in the project.

By block Y these have all happened on the real chain: the first claims, the
first daily accruals, the first monthly PoB mint (a near-empty smoke test a
day or two after genesis), the migration mints maturing on day 30 (~233
retirements drained across five `advance` calls), and the first monthly PoB
mint carrying real value.

**What the key can and cannot do until then.** It cannot touch anyone's
tokens — there is no entrypoint that lets the owner move another account's
balance. Its only power is to propose a code update, and on mainnet that is:

| | |
|---|---|
| fee | 10 HBD (`params.CONTRACT_DEPLOYMENT_FEE`) |
| timelock | 57,600 blocks ≈ **48 hours** (`params.CONTRACT_UPDATE_TIMELOCK_BLOCKS`) |
| in force? | yes — gated on `Version0_2_0Active`; mainnet is at protocol_version 3 |
| visible while queued | `findPendingContractUpdates` — id, code, proposer, creation_height, activation_height |
| cancellable | yes, `vsc.cancel_contract_update`, owner-gated, free |
| effect on state | **none** — the handler sets `Code` and `Runtime` and re-registers the SAME contract id; contract state is a separate store and is untouched |

So every update is public for two days before it can take effect, and state
survives it. That is the recovery path for anything found in the first weeks.

**If a defect is NOT fixable in place**, the fallback is a redeploy against the
same snapshot: the Merkle tree does not change, so every holder claims again
from identical leaves at their own free RC.

**Pool HBD is NOT stranded by a redeploy**, and this was checked rather than
assumed: `RemoveLiquidity` -> `closeTranche` has no accrual precondition — it
never reads the accrual clock, the monthly payout or the emission schedule. The
old contract also keeps running forever, since nothing on a chain can be
deleted. So a defect anywhere in the reward machinery still leaves every LP able
to withdraw their LASSECASH and HBD in full from the old contract. HBD is only
at risk if the defect is IN the custody or pool path itself, which is the one
area to re-verify hardest before the production deploy.

The only value genuinely lost in a redeploy is therefore the emission earned in
the dead days (~9,132 LC/day in era 1). Lasse has DECIDED 2026-08-23 that the
announcement carries no refund PROMISE — "use this chain at your own risk", and
he makes people whole where he can. A promise scales with someone else's
deposit size; a stated risk does not.

**The announced text** (genesis post):

> The owner key is destroyed at block **Y** (≈ day 40), after the migration
> mints have matured and the first full monthly Proof-of-Brain payout has
> settled. Until then the key can do exactly one thing: propose a code update.
> It cannot touch anyone's tokens. Every proposed update is visible on-chain
> for 48 hours before it can activate — query `findPendingContractUpdates` for
> contract `<id>` — and can be cancelled inside that window. After block Y no
> update can ever be proposed by anyone, including me. The burn transaction id
> will be published.

**Procedure.** Change the owner account's owner, active, posting and memo
authorities to the Hive null public key
(`STM1111111111111111111111111111111114T1Anm`) via `account_update`, with the
owner key, after a final `./deploy.sh preflight` confirms the contract's owner
is that account. Verify afterwards that no operation from the account can be
signed. Announce the burn with the transaction id.

## 8. After launch

**RC — keep HBD on MAGI on @lasseehlers, always.** RC capacity is
`MAGI HBD × 1,000 + 10,000 free`, thawing over 5 days; the HBD is never spent,
it is the meter. 85 HBD ≈ 95,000 RC ≈ 40 votes or 10 mints per 5-day window.
**Day 30 after genesis** (the migration mints mature): the walk retires
~1,600 accounts in `advance` slices of 50 (~6,500 RC each, ~32 calls). The
site bundles slices ahead of every mint/claim, so the crowd normally clears
it; to be able to clear it alone, hold ~200 HBD on MAGI that week.

- Hive-Engine: update the token info tab; ask Hive-Engine to delist.
- Run an `advance` bot so accrual never lags (permissionless; ~100 RC/day).
- Day 150 + 1: anyone calls `sweep_unclaimed`. Announce the amount recycled.
- Anyone may `record_burn` receipts for burned accounts over time.
- Keep `tools/migrate.py` (push, `-tags push` build) only as historical
  fallback; it is not part of this runbook.

## Rollback

Before §7 there is no rollback *need*: a broken deploy is abandoned (10 HBD)
and redeployed — exactly what the throwaways were for. After §7 there is no
rollback at all. That is the point, and it is why §0 exists.
