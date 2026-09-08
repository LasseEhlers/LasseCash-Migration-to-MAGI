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

## Open questions to settle while building

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
