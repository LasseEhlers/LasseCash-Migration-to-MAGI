# LasseCash — Core Migration to MAGI

Monorepo. The organising principle is **one implementation of the money**.

```
engine/          Pure Go. The economic engine. No I/O, no SDK, no clock.
                 ├── units.go        Amount (int64 base units), 128-bit MulDiv
                 ├── emission.go     Issuance schedule + 50/25/25 pool split
                 ├── lshare.go       LasseMint: shares, ratchet, early end, bleed
                 ├── governance.go   Bounded param registry, top-10 median vote
                 ├── pob.go          LasseMedia: windows, vote power, payouts
                 ├── pool.go         LASSECASH:HBD AMM, loyalty bonus
                 └── *_test.go       73 invariant tests

contract/        The MAGI contract.
                 ├── app/main.go   //go:wasmexport entrypoints (21). Thin:
                 │                 parse args, call state, abort on failure.
                 ├── state/        Storage schema + every operation. Pure Go,
                 │                 unit-tested natively against a MemStore.
                 └── sdk/ runtime/ Vendored from vsc-eco/go-contract-template.

node/            Dev chain. Runs the SAME contract code over an in-memory
                 store, adding only a clock, a calendar and a tx dispatcher.
                 Plain JSON — the TS indexer is the abstraction boundary that
                 adapts either this or a real MAGI node.
                 `./build.sh node` -> http://localhost:8080

api/             TypeScript indexer + the browser engine.
                 ├── engine-wasm/  Go bridge -> engine.wasm (104KB, 0.4ms/call)
                 ├── src/engine.ts Typed wrapper. EXACT vs ESTIMATE marked.
                 └── src/client.ts The one thing the frontend imports.
                 Amounts are decimal strings — never JS numbers.

web/             SvelteKit frontend — four pages:
                 /       LasseMint dashboard (mints, live preview, bleed alarm)
                 /pool   LASSECASH:HBD swap + liquidity tranches
                 /chain  supply vs the 51M cap, block split, consensus group
                 /feed   LasseMedia posts, vote slider, payouts
                 Previews run the browser engine; anything that becomes a
                 transaction is confirmed by the chain.
                 `./build.sh web` -> http://localhost:5173

docs/            Specs. Source .odt files plus generated .md.
```

## Why the engine is Go and lives in exactly one place

MAGI requires contracts in Go compiled by TinyGo to WASM — that is not a
preference, it is the platform. If the dev simulator were written in
TypeScript, the L-Share formula, the bleed curve and the penalty slash would
exist twice, in two languages, and would drift. The frontend would then promise
a payout the chain refuses to pay.

So `engine/` is compiled into both the contract and the simulator. Neither
contains money math of its own.

**Never reimplement engine logic in TypeScript.** If the frontend needs a
number, the backend computes it.

## Running the tests

No local Go toolchain is required — only Docker.

```bash
./build.sh          # all tests + WASM build
./build.sh test     # engine + contract + simulator tests
./build.sh wasm     # build contract/artifacts/main.wasm
./build.sh node     # run the dev chain on :8080, seeded with a demo economy
```

The tests are the tokenomics specification. They assert that issuance can
never exceed the cap, never runs backwards, is identical whether settled in one
step or a million, and that the three-way pool split loses no base unit.
Treat a failure as a launch blocker, not a test to adjust.

## The supply invariant

Every contract test ends by auditing global supply: the sum of all balances,
reward pools, pending accruals, live mint principals and parked curator pots
must EXACTLY equal `migrated + emitted - burned`. If a single base unit is
created or lost anywhere, the test fails.

Constraints inside a contract: no goroutines, no channels, no `defer`,
`panic()` cannot be recovered, and **no unbounded iteration** — anything that
would loop over "all accounts" or "all mints" must be lazy or live off-chain.

## Analysis scripts

- [tokenomics_check.py](tokenomics_check.py) — hardcap and emission verification
- [emission_options.py](emission_options.py) — longevity/reduction-rate modelling

## Start here

[CLAUDE.md](CLAUDE.md) holds the locked decisions, the verified chain facts,
the tokenomics invariants, and the open questions. It is the authority.
