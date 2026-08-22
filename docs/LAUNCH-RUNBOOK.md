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
python3 apply_criteria.py --write    # 3-month window → migration_set.json
```
Check the printed HARDCAP line (migrated + 20M < 51M) and the founder %.
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

## 7. 💸 Burn the owner keys — IRREVERSIBLE — at DAY 35

DECIDED 2026-08-21: the key is destroyed at a block height announced in the
genesis post, ≈ day 35 after genesis — after the heaviest first-time events
have passed on the real chain: the first claims, the first daily accruals,
the first monthly Proof-of-Brain mint on the 1st, and the migration mints
maturing on day 30 (~2,000 retirements drained across several `advance`
calls). Until then any code update is public and timelocked; the announced
text: *"the owner key is destroyed at block Y (≈ day 35), after the migration
mints have matured; until then any code update would be public and
timelocked."* Block Y = genesis + 35 × 28,800 = genesis + 1,008,000.
Publish the burn transaction id when it happens. Procedure: change the owner account's owner, active,
posting and memo authorities to the Hive null public key
(`STM1111111111111111111111111111111114T1Anm`) via `account_update`, with
the owner key, after a final `./deploy.sh preflight` confirms the contract's
owner is that account. Verify afterwards that no operation from the account
can be signed. Announce the burn with the transaction id.

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
