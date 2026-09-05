# Draft: GitHub issue for the MAGI team (vsc-eco) — 2026-09-05

Post on `vsc-eco/magi-mongo-indexer` (or `go-vsc-node` if that is where they
triage), and drop the link to @vaultec in the MAGI Discord. It is written as a
chain benefit with two concrete asks, not a favour. Adjust the voice; keep the
numbers — they are all verifiable.

---

**Title:** Contract-managed pools: index them in Altera, and put MAGI on GeckoTerminal

Hi — LasseCash has been live on MAGI since 31 August as a contract-managed
token with its own LASSECASH:HBD constant-product pool inside the contract
(`vsc1Be4TTjUiHgzhHAfqFn6s3PDAExH2X59fXV`). The contract's HBD side is real
HBD custodied through the SDK; the LASSECASH side is the contract's own
ledger. It is, as far as I know, the first contract-managed pool on MAGI, and
the owner key burns on 10 October, so it is not going to change.

Two things would help MAGI as much as they help us:

**1. Index contract-managed pools in Altera / the indexer.**
Altera lists MAGI's native pools; a pool that lives inside a contract is
invisible there, even though it is the same HBD. Everything needed to read
ours is public, frozen state: reserves at `amm_lc` and `amm_hbd`
(`getStateByKeys`, plain base-unit integers, 8 decimals), and every trade's
settled result in the contract output — `swapped for <out> HBD`,
`swapped for <out> LASSECASH`, `added <lc> LC and <hbd> HBD`,
`withdrew <lc> LC and <hbd> HBD` (`findContractOutput`, one result per call,
in call order). No engine or contract-specific code is needed to replay it:
we replay it exactly that way ourselves, and the replay lands on the live
reserves to the base unit (48 events at the time of writing, zero unmatched).
If it helps, I can write the adapter against your indexer's shape.

**2. Request GeckoTerminal / DEX-screener chain support for MAGI.**
That is where small-token discovery happens now, and it has to come from
the chain team, not from a project. As a first data point for the
application, LasseCash already publishes the CoinGecko- and
CoinMarketCap-shaped endpoints from the pool:

- https://lassecash.com/api/market/tickers · /pairs · /orderbook · /historical_trades
- https://lassecash.com/api/cmc/summary · /assets · /ticker · /orderbook/LASSECASH_HBD · /trades/LASSECASH_HBD
- https://lassecash.com/api/supply · /supply/circulating

Source (engine, contract, indexer, this API): https://github.com/LasseEhlers/LasseCash-Migration-to-MAGI

Happy to do whatever part of this is ours to do.

---

**Before posting, check:** the endpoint URLs answer 200 (they are deployed as
of tonight); the event count line is still true or update it from
`/api/cmc/trades/LASSECASH_HBD`.
