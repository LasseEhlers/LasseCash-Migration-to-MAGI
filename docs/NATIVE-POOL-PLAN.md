# The native LASSECASH/HBD pool on MAGI's DEX — how it actually works

Written 2026-09-08 23:40 CPH after TibFox: *"I think that you need to deploy
the pool contract and we whitelist it — so to say. but I could be wrong."*
He is right. Verified against `vsc-eco/dex-contracts` (`docs/setup.md`,
`contracts/dex/main.go`, `contracts/asset/asset.go`, `contracts/dex-router-v2`).

## The design

**One router for the whole DEX, one pool contract per pair, deployed by
whoever wants the pair.** The router owner (`hive:vsc.dao`) only registers.
So the LASSECASH/HBD pool is a contract WE deploy, from THEIR standard code,
and they flip two flags. Nothing custom anywhere — this is the shape TibFox
was describing on 6 Sep.

| piece | who | what |
|---|---|---|
| Router-V2 | vsc.dao, already live | `vsc1Brvi4YZHLkocYNAFd7Gf1JpsPjzNnv4i45` |
| `dex` pool contract | **us** — deploy + `init` | their WASM, 10 HBD from an L1 balance |
| `register_token` LASSECASH | router owner | owner-only on the router |
| `register_pool` LASSECASH/HBD | router owner | owner-only, needs both tokens registered first |
| seed liquidity | us | after registration, the pool starts empty |

## How the pool moves LASSECASH — verified from source

`contracts/asset/asset.go`: a `MappedAsset` moves value by
`sdk.ContractCall(mappingContractId, "transferFrom", …)` and `"transfer"`.
`magi_token` answers exactly those: `transferFrom {from,to,amount}` and
`transfer {to,amount}`. **So the LASSECASH token contract IS the "mapping
contract" from the pool's point of view.** No adapter, no bridge.

Consequence for LPs and traders: before depositing or swapping LASSECASH
into the native pool they must `increaseAllowance` on the token for the pool
contract — the same shape lassecash.com already bundles for the core.

## The sequence

1. **Build** `contracts/dex` from `vsc-eco/dex-contracts` at HEAD with
   `tinygo/tinygo:0.39.0` (their Makefile's flags are our flags). There is no
   prebuilt WASM in the repo. Pin the commit and the sha256 like every other
   artifact.
2. **Deploy** it (10 HBD from Hive L1). ⚠️ @lassecashmagi holds 3.936 HBD on
   L1 after the memo campaign — top it up ~6.1 HBD, or deploy from
   @lasseehlers. The pool's deployer becomes its owner; the docs give the
   pool owner no special powers, the router owner is the gate.
3. **`init`** the pool:
   ```json
   {"asset0":"LASSECASH","asset1":"HBD","fee_bps":8,
    "router_contract":"vsc1Brvi4YZHLkocYNAFd7Gf1JpsPjzNnv4i45",
    "asset0_mapping_contract":"vsc1BUDsVccMPGycTmpc98WsQYSKyTBsZqFq4h"}
   ```
   `fee_bps` default 8 = 0.08%. Whether the fee goes to LPs or to the router
   is NOT yet read from the source — check before quoting it to anyone.
4. **Ask vsc.dao / TibFox** for the two owner-only calls, giving them the pool
   id from step 2:
   ```json
   {"name":"LASSECASH","chain":"MAGI","mapping_contract":"vsc1BUDsVccMPGycTmpc98WsQYSKyTBsZqFq4h"}
   {"asset0":"LASSECASH","asset1":"HBD","dex_contract_id":"<pool id from step 2>"}
   ```
   ⚠️ Give them the PRODUCTION token id. Their index shows two LASSECASH
   tokens; the throwaway's is `vsc1Bq7L9…LEGR` and must not be registered.
   Registration is permanent — "if a mapping contract address changes, you
   need a new asset symbol".
5. **Seed** at the current price (0.000367 HBD; re-measure). The pool's own
   add-liquidity payload is not read yet — read it when building (step 1).
   Small: the native pool is the route and the storefront, not the yield
   venue; our own pool pays LPs 25% of emission and stays the deep one.

## Verified 2026-09-08 23:55 — built, read, ready to deploy

**Artifact:** `contract/artifacts/magi-dex-pool.wasm` (gitignored like every
built WASM) — `vsc-eco/dex-contracts` @ `e7033a7b65ceced92aedd6ae78faa3ee67a18f04`
(2026-06-12), `contracts/dex`, tinygo/tinygo:0.39.0 with their flags.
**234,083 bytes · sha256 `997f69caed54f80480ad220f3d5d341c0aa2d349d54619ad17db148e76bc981c`
· CID `bafkreiezp5u4v3ku7acibljcb46v2na4bkrngsoviym22f63cshhnpeydq`.**
Exports: init swap add_liquidity remove_liquidity get_pool claim_fees migrate.

**Read from source, no longer open:**
- `asset.NewAsset` accepts ANY non-Hive symbol given a mapping contract.
  "LASSECASH" needs no allowlist.
- Depositing LASSECASH = the pool calls `transferFrom {from, to: contract:<pool>,
  amount}` on the token — **the LP must `increaseAllowance` the pool first**,
  same shape as lassecash.com bundles for the core.
- **Units:** LASSECASH amounts in the token's 1e8 base units; HBD via
  `sdk.HiveDraw`, i.e. milli-HBD. `add_liquidity {amount0, amount1, recipient,
  min_lp_out}` takes raw units per asset, assets normalised alphabetically
  (HBD < LASSECASH, so asset0 = HBD).
- **What the pool's OWNER can do, read from `contracts/dex/main.go`
  (2026-09-08):** exactly three things. `init` (once). `claim_fees` — the
  network-share bucket of the 0.08% swap fee (the LP/network split is done
  by the node's pendulum module, not the contract) is paid to the owner's
  address and nobody else. `migrate` — a STATE-FORMAT upgrade step for new
  pool code versions (renames keys, converts a timestamp); it moves no
  funds. Plus the MAGI-level power every living owner has: queue a code
  update behind the public 48h timelock. **The owner cannot touch the
  reserves with the code as deployed**; swap, add_liquidity and
  remove_liquidity are permissionless. If the owner's keys are LOST the
  pool keeps working forever, fees pile up unclaimable, and no upgrade is
  ever possible — i.e. it becomes immutable with stranded fees; LP money is
  never at risk from key loss. Every native MAGI pool has this owner model
  (theirs are owned by hive:vsc.dao); ours is theirs, unmodified.
  ⚠️ The owner must NOT be @lassecashmagi (keys burn 10 Oct) and should not
  be @lasseehlers (personal funds; its key would have to sit in a plaintext
  deploy config for every owner call — ruled out long ago).
  **DECIDED 2026-09-08: ONE dedicated key-holder account owns the pool and
  every future dApp contract** — created from @lasseehlers (recovery
  account = lasseehlers), name Lasse's choice; call it `<dapps>` below. Its
  active key replaces lassecashmagi's in the deploy config after the burn;
  until then it lives in a second identity file used via `IDENTITY_CONFIG=`
  with `tools/chain-test/call.js`, or Keychain via the rewards-page raw-call
  form. One account is enough until a dApp needs a different owner (handing
  it to someone, its own thresholds) — the owner is per contract, chosen at
  its deploy. Deploy from @lassecashmagi (pays the 10 HBD, has the deploy
  config) with `OWNER=hive:<dapps>`. Creator shows lassecashmagi on the
  explorer, owner shows `<dapps>`. Social proof does not argue for
  lasseehlers: Altera shows the pool's registration and liquidity, not its
  owner; the announcement names who seeded it.
- Preflight passes at 499G Hive RC (rule changed to an absolute 5G floor).

**The deploy command:**
```
WASM=contract/artifacts/magi-dex-pool.wasm NAME="LASSECASH/HBD pool" \
  DESC="LASSECASH/HBD liquidity pool on MAGI's DEX — vsc-eco dex contract, unmodified" \
  OWNER=hive:<dapps> ./deploy.sh deploy
```
Then simulate `init` on the new id before broadcasting it (free), as with
the token; broadcast it as `<dapps>`:
`IDENTITY_CONFIG=deploy-data/config/dapps.json CONTRACT_ID=<pool> node tools/chain-test/call.js init '<json>' 2000`
(a fresh account's free 10,000 RC covers it). The owner is the only account the
chain accepts `init` from — this is the one step lassecashmagi cannot do. Then send the pool id to TibFox with the register payloads above.

## ✅ DEPLOYED AND INITIALISED — 2026-09-09 00:0x CPH

| | |
|---|---|
| pool contract | **`vsc1BrBFAwZ3Mr8L4ijRqT9RPEPvhK9FWDaYSr`** |
| code | `bafkreiezp5u4v3ku7acibljcb46v2na4bkrngsoviym22f63cshhnpeydq` = the pinned artifact (sha256 `997f69ca…`), vsc-eco `contracts/dex` @ e7033a7b65ce, unmodified |
| owner | `hive:lassecashdapps` (created 8 Sep 21:45, recovery → lasseehlers in force 8 Oct; key in `deploy-data/config/dapps.json`, gitignored) |
| deploy | tx `de7f95b2efad214fbf964ceed745009f3e4e1830`, creation height 109,746,051, 10 HBD from @lassecashmagi |
| init | tx `35f99aa160fff4b702ac2822ae4c5cb24bc2aa61`, CONFIRMED at 109,746,110, signed by lassecashdapps via `IDENTITY_CONFIG=` |
| `get_pool` (real state) | `{"asset0":"hbd","asset1":"lassecash","reserve0":"0","reserve1":"0","fee":8,"total_lp":"0"}` |

Simulations before the broadcast: init as lassecashdapps 1,939 RC; init as
lassecashmagi refused "owner only". The pool is EMPTY and UNREGISTERED — it
does nothing until the router owner registers it. Paste-ready for the MAGI
team (field names from `contracts/types/types.go`):

```
register_token  {"name":"LASSECASH","chain":"MAGI","mapping_contract":"vsc1BUDsVccMPGycTmpc98WsQYSKyTBsZqFq4h","decimals":8,"description":"LasseCash"}
register_pool   {"asset0":"LASSECASH","asset1":"HBD","dex_contract_id":"vsc1BrBFAwZ3Mr8L4ijRqT9RPEPvhK9FWDaYSr"}
```

**SEEDED 2026-09-09 00:40 CPH, tx `c509b429e47a02b3…` CONFIRMED at 109,746,801**
(one Keychain confirm from @lasseehlers via the /rewards seed panel:
`increaseAllowance` on the token for `contract:<pool>` + `add_liquidity`
with a 9.905 HBD intent). Read back from real state: `get_pool` reserve0
9,905 milli HBD / reserve1 27,000.00000000 LASSECASH, total_lp 163,534,400;
token `balanceOf(contract:pool)` = 27,000; the pool's MAGI HBD custody =
9,905 milli — all three agree. Opened at the core pool's price at that
instant (0.00036683 HBD/LASSECASH). The chain checked `add_liquidity`
works directly on the pool: registration on the router is only what makes
it VISIBLE (Altera, their wallets), not what makes it function.

## Still open (after deploy)

- Does `fee_bps` accrue to LPs or to the router/vsc.dao? (`contracts/dex`)
- Exact add-liquidity / swap payloads of the pool, and whether swaps through
  the router need `router_contract` set (docs say yes for mapped assets — set
  it).
- Do BTC → LASSECASH two-hop swaps work with a magi_token leg? Docs: "two-hop
  swaps route via HBD automatically" given BTC/HBD and LASSECASH/HBD pools.

## Timing

The build+deploy+init is ours and can happen any day. The two register calls
are theirs. If HiveFest (18 Sep) is the reason, the pool must be deployed and
its id sent before then; otherwise the after-day-30 timing still holds.
