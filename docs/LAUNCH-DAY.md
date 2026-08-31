# Launch day log — 2026-08-31

- **Seed price, read 07:07 UTC (09:07 CPH), before any founder action:**
  Diesel pool 0.01216243 SWAP.HIVE/LC × HIVE $0.04281606 = **$0.00052073/LC**.
  §6 seed: **10,000 LASSECASH + 5.207 HBD** (round to 5.21).
- Snapshot block 109,504,918 ≈ 12:00 UTC; genesis block 109,512,118 ≈ 18:00 UTC.
- Preflight: READY (key match, 12 HBD L1, RC 100%).

- **THE SNAPSHOT (final, committed 5b97237):**
  root `092f7b2ed2e6a0ccd3dadb832e9829c6419096171bcae68edb883fb099e46803`
  · 11,238 leaves · 418 qualify with 11,730,692.24746305 LC
  · 18,688,809.72711925 LC to hive:null · snapshot supply 30,419,501.97458230.
- **Tonight's owner call #2, verbatim:**
  `set_snapshot 092f7b2ed2e6a0ccd3dadb832e9829c6419096171bcae68edb883fb099e46803|1173069224746305|1868880972711925`

- **PRODUCTION CONTRACT DEPLOYED 15:00 UTC:**
  id `vsc1Be4TTjUiHgzhHAfqFn6s3PDAExH2X59fXV`
  · tx `1933145e46f10bddfed18d698de783e5814865f3`
  · code CID `bafkreifnnebaktfkfowflragdhhkuddxkr56rfmtl7kda56qxe4fd3e3fm`
  · WASM sha256 `ad6902…9b2b`, 95,163 bytes, 30 entrypoints, MAINNET build.
- Site switch tonight (after set_snapshot): Cloudflare → Pages `lassecash` →
  Settings → Variables: set `VITE_CONTRACT_ID=vsc1Be4TTjUiHgzhHAfqFn6s3PDAExH2X59fXV`,
  DELETE `VITE_TESTWINDOWS` and `VITE_PRELAUNCH`, keep net id/chain URL; then
  "Retry deployment" so the build picks the new env.

- **§3 verification COMPLETE on-chain (simulateContractCalls, free):**
  code CID matches our WASM byte-for-byte; owner resolves to
  hive:lassecashmagi (init from lasseehlers refused "owner only"); the exact
  init+set_snapshot pair simulates green — gas 40,063,737 (~401 RC) and
  285,282,416 (~2,853 RC). rc_limit for set_snapshot raised 2000 → 4000.
- **DECIDED: init passes the ANNOUNCED genesis height 109512118 verbatim**
  (the runbook said "read the height at broadcast"; the announcement promised
  the block, so the block is what cfg_genesis gets — broadcast right as it
  passes, the same way the snapshot was handled).
- **Tonight's two commands, verbatim (at block 109,512,118 ≈ 20:35 CPH):**
  node tools/chain-test/launch-call.js init 109512118 1500
  node tools/chain-test/launch-call.js set_snapshot "092f7b2ed2e6a0ccd3dadb832e9829c6419096171bcae68edb883fb099e46803|1173069224746305|1868880972711925" 4000
  then verify by state read (cfg_init, cfg_genesis, cfg_migroot, bal_hive:null),
  then: transfer ~85 HBD MAGI→MAGI owner → lasseehlers, then the site switch.
- 18:15 CPH: Hive-Engine team removed LASSECASH from trading on
  hive-engine.com + tribaldex.com and took the old Outpost down (reazuliqbal,
  after aggroed/eonwarped ping). The old chain is fully closed.

- **GENESIS EXECUTED, block 109,512,118 (≈18:35 UTC):**
  init tx `cc0f1aa5e07f604ecd489ced952615b4b76f6a60` → cfg_init=1, cfg_genesis=109512118 (state-verified 40 s later)
  set_snapshot tx `9bf6488f0271697185dbc00ff6282356f15f2e01` → cfg_migroot=092f7b2e…, bal_hive:null=1868880972711925, sup_migrated=cfg_migburn exact.
  LasseCash is live on MAGI.

## Evening verification (all exact on-chain) & watchlist

Launch evening, all verified to the base unit: claim (receipt 21,000|7,005,065.73374918),
pool seed 10,000+5.21, genesis post registered mode 2 (burn) + 100 LC promote,
vote 10% → 70,050.657 rshares, mint 1,000, swap 1,000 LC → 0.473 HBD paid
(milli-floored), @zaxan claimed independently (387k, seat 2).

**Tomorrow's UI batch (frontend only):**
1. After login: unclaimed → /mint, claimed → /feed.
2. Day-0 hint on posts: "reward pools fill when the chain's first day closes".
3. Vote panel: label the per-voter % as "share of this post", not vote weight.
4. Refresh the HBD balance after pool actions (stale 86.14 after swap).
5. Tool hygiene: he-update-metadata via Keychain flow, not env key.

**Watchlist:**
- Day 0 closes ~18:35 UTC 1 Sept → first pool figures; verify accrual walk.
- 1 Sept: first monthly PoB epoch boundary on the real chain.
- 7 Sept: genesis post payout — VERIFY burn mode routes author share to @null.
- @cashmap claim pending (noganoo's test).
- 25 Sept: recovery_account -> null takes effect. 10 Oct: KEY BURN (§7 — move
  owner funds off first, undelegate the 100 HP, final preflight).
