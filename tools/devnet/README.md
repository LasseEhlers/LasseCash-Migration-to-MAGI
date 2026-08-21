# Local MAGI (VSC) development testnet

A complete MAGI network running on this machine: a HAF-based Hive testnet
producing blocks from its own genesis, MongoDB, the hafah/drone Hive API
stack, and four `magid` nodes that elect a witness set and produce MAGI
blocks. Contracts deploy for free (testnet HBD) and the whole thing can be
wiped and re-genesised in one command.

⚠️ **RC is NOT free here.** Each account's capacity is its MAGI HBD balance in
milli-units plus the 10,000-RC free allowance, and the witnesses start with 0
MAGI HBD — so ~10,000 RC is the working budget until you deposit. `simulate`
costs no RC at all, which is why every measurement below uses it. Note that
this devnet charges *actual* RC used rather than the reserved `rc_limit`; see
the RC note under "Measured results" before trusting a budget measured here.

**Nothing here touches mainnet.** No `api.vsc.eco`, no Hive mainnet node, no
`deploy-data/config/identityConfig.json`, no real HBD. Every endpoint below is
`localhost`.

---

## Why this exists

`CLAUDE.md` names three things that cannot be measured against mainnet without
spending real HBD and parking real RC:

- `migrate_batch` gas at 50 accounts (previously unmeasured — measured here)
- a full `MaxCurationDrain` curation drain
- a rehearsal of the 6,039-broadcast migration

The devnet gives all three for free, repeatedly, with a reset button.

TibFox's caveat still applies: treat "devnet says X" as strong evidence, but
confirm consensus-critical behaviour against mainnet, since mainnet witnesses
may run a different node version than this checkout.

---

## Quick start

```bash
./tools/devnet/up.sh          # first run: 20-40 min. later runs: ~2 min
./tools/devnet/devnet.sh status
./tools/devnet/prove.sh       # deploy + init + migrate_batch gas measurement
./tools/devnet/down.sh        # stop, keep chain state
./tools/devnet/reset.sh       # wipe everything, fresh genesis
```

`up.sh` is idempotent. Run it twice and the second run just makes sure the
containers are running.

---

## What runs

| Service | Image | Role |
|---|---|---|
| `haf` | `registry.gitlab.syncad.com/hive/haf/testnet` | hived (testnet, single `initminer` witness, 3s blocks) + PostgreSQL/HAF |
| `db` | `mongo:8.0.17` | MAGI node state |
| `hafah-install` | `registry.gitlab.syncad.com/hive/hafah` | one-shot SQL installer into HAF |
| `pgbouncer` | `.../haf_api_node/pgbouncer` | connection pool in front of HAF |
| `hafah-postgrest` | `.../haf_api_node/postgrest` | REST layer over hafah |
| `drone` | `registry.gitlab.syncad.com/hive/drone` | the Hive JSON-RPC endpoint clients actually talk to |
| `magi-1` … `magi-4` | built locally from the checkout | MAGI nodes (witnesses `magi.test1` … `magi.test4`) |
| `feed-publisher` | same image | publishes a price feed so contract fees can be priced |

Compose project name: **`lassecash-devnet`**. Everything is visible with
`docker compose -p lassecash-devnet ps` (add `-f`/`--env-file` as printed by
`devnet.sh status`, or just use `devnet.sh status`).

### Ports and URLs

| What | URL |
|---|---|
| Hive RPC (hived/HAF direct) | `http://localhost:18091` |
| **Hive API (drone)** — the one to use | `http://localhost:19000` |
| MongoDB | `mongodb://localhost:18057` |
| **magi-1 GraphQL** | `http://localhost:18080/api/v1/graphql` |
| magi-2 GraphQL | `http://localhost:18081/api/v1/graphql` |
| magi-3 GraphQL | `http://localhost:18082/api/v1/graphql` |
| magi-4 GraphQL | `http://localhost:18083/api/v1/graphql` |
| magi P2P | 11720 … 11723 (TCP + UDP) |

`net_id` is **`vsc-devnet`** (mainnet is `vsc-mainnet` — the difference is what
stops a devnet-shaped transaction from being valid anywhere else).

Hive testnet chain id: `18dcf0a285365fc58b71f18b3d3fec954aa0c141c44e4e5cb4cf777b9eab274e`.

### Where things live

Nothing large is inside the project tree.

| Path | Contents |
|---|---|
| `~/.lassecash-devnet/go-vsc-node/` | the `go-vsc-node` checkout + the `lcdevnet` driver |
| `~/.lassecash-devnet/state/haf-data/` | hived block log + PostgreSQL cluster (root-owned, several GB) |
| `~/.lassecash-devnet/state/devnet-data/data-N/` | magi node N's config + badger store |
| `~/.lassecash-devnet/state/contracts/<name>.id` | contract ids from `devnet.sh deploy` |
| `~/.lassecash-devnet/logs/` | `up.log`, `down.log`, `reset.log`, `prove-*.log` |
| `~/.lassecash-devnet/batches/` | generated `migrate_batch` payload files |

Override with `LC_DEVNET_HOME`, `LC_DEVNET_DIR`, `LC_VSC_SRC`,
`LC_DEVNET_NODES` (min 4), `LC_DEVNET_LOG`.

---

## Accounts and keys

| Account | Role |
|---|---|
| `initminer` | the testnet's only Hive witness; funds everything; signs every devnet transaction |
| `magi.test1` … `magi.test4` | MAGI witnesses, one per node, each funded with 100.000 TBD + 10000.000 TESTS |
| `hive:magi.test1` | owner of contracts deployed with `-node 1` (the default) |

**Keys are not printed anywhere by these scripts, and must not be pasted into
issues, logs or chat.** They live in files:

| Key | File |
|---|---|
| `initminer` WIF (also every devnet account's active key) | `~/.lassecash-devnet/go-vsc-node/tests/devnet/config.go`, field `InitminerWIF`; the same value is in `tests/devnet/testdata/config.ini` as `private-key` |
| magi node N identity (libp2p + the account it signs MAGI blocks with) | `~/.lassecash-devnet/state/devnet-data/data-N/config/identityConfig.json` |
| magi node N Hive credentials | `~/.lassecash-devnet/state/devnet-data/data-N/config/hiveConfig.json` |

These are throwaway testnet keys with no value, generated by `devnet-setup`
or baked into the upstream harness. They are still keys: do not echo them.

The real mainnet key at `deploy-data/config/identityConfig.json` inside the
project is **never used by anything in this folder.**

---

## Deploying a contract

```bash
./tools/devnet/devnet.sh deploy \
    -wasm contract/artifacts/main.wasm \
    -name lassecash \
    -node 1
```

Prints `contract id: vsc1…` and writes it to
`~/.lassecash-devnet/state/contracts/lassecash.id`.

The deploying node's witness account becomes `env.ContractOwner`, so
`-node 1` means **`hive:magi.test1` owns the contract** and is the only
account that may call `init`, `migrate` and `migrate_batch`. Call those with
`-node 1` too.

Mechanically this is the upstream `contract-deployer` binary: it uploads the
WASM to the data-availability layer over libp2p, collects a signed storage
proof from a *different* node's GraphQL, and broadcasts the deploy on the Hive
testnet. Because the deployer opens the same badger lock the node holds, the
harness stops `magi-1`, deploys, and restarts it — expect a ~30 second gap.

## Calling a contract

```bash
./tools/devnet/devnet.sh call \
    -contract vsc1… -action init -payload 1234 -node 1 -rc 100000
```

The wire format is identical to mainnet: a Hive `custom_json` with id
`vsc.call`, `required_auths = [magi.testN]`, and JSON

```json
{"net_id":"vsc-devnet","contract_id":"vsc1…","action":"init",
 "payload":"1234","rc_limit":100000,"intents":[]}
```

`payload` is a plain string, so the contract's pipe-delimited positional args
go straight in — the same encoding proven on mainnet.

`call` waits for the contract output and prints `ok` and `ret` per result.

## Simulating (free, no broadcast, and where the gas numbers come from)

```bash
./tools/devnet/devnet.sh simulate \
    -contract vsc1… -action migrate_batch \
    -payload-file ~/.lassecash-devnet/batches/batch50.txt \
    -auth hive:magi.test1 -rc 100000
```

This is `simulateContractCalls`, the same read-only GraphQL query used against
mainnet. It returns `success`, `err_msg`, `ret`, **`gas_used`**, **`rc_used`**
and `state_diff` without touching the chain. `rc_limit` is capped at 100,000
by the schema.

Raw GraphQL, if you want it:

```bash
./tools/devnet/devnet.sh gql -q '
query($in:SimulateContractCallsInput!){
  simulateContractCalls(input:$in){success err_msg ret gas_used rc_used}
}' -vars '{"in":{"tx_id":"x","required_auths":["hive:magi.test1"],
  "calls":[{"contract_id":"vsc1…","action":"init","payload":"1","rc_limit":100000}]}}'
```

Note the devnet schema takes `required_auths` as a **list**, unlike the
mainnet node which wants a bare string. That is the only wire difference found.

## Reading state

```bash
./tools/devnet/devnet.sh state -contract vsc1… -keys cfg_init,cfg_genesis,sup_migrated
```

Straight `getStateByKeys`. Flat keys only — the same node bug that eats `/` in
key names on mainnet is present here.

---

## Measured results — 2026-08-21

Deployed on this devnet (all free; each would have cost 10 HBD on mainnet):

| Contract | id | note |
|---|---|---|
| `main.wasm` **v1** (81,445 B) | `vsc1BgjjVVba3z2dntZrooQJ5EJ4FZpgZgLRvS` | genesis 193 — the pre-optimisation build |
| `main.wasm` **v2** (85,146 B) | `vsc1Ba8Np3BqPHY8Jbf16H2nttL7dKzF2B5NMY` | genesis 480 — optimised, 25 entrypoints incl. `burn_batch` |
| `main-testwindows.wasm` (85,178 B) | `vsc1BofZXPuU8nBhmGPe77Qjvmmg15WeKyfSYn` | genesis 1 — 240x clock |
| `main-testwindows.wasm` (85,178 B) | `vsc1BpxvsdG1e2ideBbpAvfzTpu9pCvLkhw5Fz` | genesis 647 — the mint-maturity fixture |

These ids die with the next `reset.sh`. Every figure below is from this devnet,
not from a model.

### v2 (optimised) headline — 🟢 the ceiling moved, but 50 still does not fit

`migrate_batch` with accounts carrying **staked POWER** (each creates a
migration mint), v1 vs v2:

| accounts | v1 gas | v2 gas | change |
|---|---|---|---|
| 1 | 260,456,865 | 287,964,737 | +10.6% |
| 3 | 735,956,355 | 764,149,838 | +3.8% |
| 10 | 2,863,577,840 | 2,643,195,896 | −7.7% |
| 25 | 9,674,282,628 | **7,077,301,204** | **−26.8%** |
| 30 | `gas_limit_hit` | 8,221,134,539 (82,212 RC) | now fits |
| 33 | — | 8,908,012,543 (89,081 RC) | fits |
| 35 | — | 9,365,930,826 (93,660 RC) | fits |
| **36** | — | **9,594,890,223 (95,949 RC)** | **the new ceiling** |
| 38 | — | `gas_limit_hit` | over 10B |
| 50 | `gas_limit_hit` | `gas_limit_hit` | **still impossible** |

**The quadratic term dropped ~3.3x** (marginal cost of the n-th account rises
~3.7M gas per account in v2 vs ~12.3M in v1), which is exactly what the bulk
expiry-chunk write was meant to do. The usable ceiling went **25 → 36**.
`MaxMigrateBatch = 50` is still unreachable and should be lowered — 36 is the
measured maximum, and leaving headroom for real (larger) state argues for
something nearer 25–30.

**The important consequence: batch size is now nearly RC-neutral.** Projecting
the 6,039-account snapshot, worst case where every account carries stake:

| strategy | calls | total RC (v2) | total RC (v1) |
|---|---|---|---|
| single `migrate` | 6,039 | 17,392,320 | 15,731,595 |
| batches of 3 | 2,013 | **15,383,346** | 14,815,680 |
| batches of 10 | 604 | 15,964,928 | 17,296,144 |
| batches of 25 | 242 | 17,127,308 | 23,411,806 |
| batches of 36 | 168 | 16,119,432 | n/a |

v1 punished large batches by up to +49%; v2's spread is only ~13% end to end.
**Batching now buys the transaction-count win essentially for free**, which is
what CLAUDE.md assumed all along and v1 did not deliver. Any batch size from 3
to 36 is defensible; 10 is a good middle (604 calls, within 4% of optimal RC).

### 🟠 v2 regression: liquid-only migration got 42–73% more expensive

| accounts (liquid only, no mint) | v1 gas | v2 gas | change |
|---|---|---|---|
| 1 | 49,528,627 | 70,331,378 | **+42.0%** |
| 10 | 287,322,188 | 482,740,103 | **+68.0%** |
| 25 | 680,478,886 | 1,166,921,868 | **+71.5%** |
| 50 | 1,335,811,908 | 2,307,297,931 | **+72.7%** |

Both builds are linear here (v1 ~26M gas per account, v2 ~46M), so this is a
uniform ~20M gas per account added to the *no-mint* path — roughly one extra
state write. It is not the quadratic term, and it is not fatal (50 liquid
accounts still cost only 23,073 RC), but it is a real 1.7x on the cheapest and
most numerous case, and the optimisation notes do not obviously explain it.
Worth a look: something in the bulk-registration or board-offer refactor is
writing per-entry even when the entry has no shares.

Single `migrate` on v2 for comparison: staked 287,960,244 (2,880 RC),
liquid-only 68,526,369 (686 RC).

### 🟢 `burn_batch` (new) — cheap and linear, 50 fits easily

| accounts | gas_used | rc_used | per account |
|---|---|---|---|
| 1 | 94,332,701 | 944 | 944 |
| 10 | 559,938,691 | 5,600 | 560 |
| 25 | 1,329,615,872 | 13,297 | 532 |
| 50 | **2,612,484,653** | **26,125** | 523 |

`ret="burned 50 of 50 to null"`. Linear at ~52M gas per account with a ~42M
fixed cost — the "credit null once" optimisation is visible as the falling
per-account figure. **50 is safe**; extrapolating, ~190 accounts would fit under
the 10B ceiling, so `burn_batch` is not the constraint the migration path is.

### Everyday user costs (v2)

Measured as a chained simulation so an ordinary account had a migrated balance
to spend:

| call | gas_used | rc_used | note |
|---|---|---|---|
| `transfer` 1 LC | 28,721,287 | **288** | matches CLAUDE.md's mainnet 28M / ~280 RC **exactly** |
| `mint` 1,000 LC / 30 days | 221,790,518 | **2,218** | |
| `mint` 10,000 LC / 1095 days | 288,981,397 | **2,890** | `ret="minted 1499999595000 L-Shares"` — the 1.5x Longer-Pays-Better ceiling, exact |
| `advance` when already current | 2,315,611 | 100 | the no-op floor |

The `transfer` figure landing on mainnet's measured 28M gas is the best
evidence available that **devnet gas is mainnet gas** — the same contract, the
same WASM runtime, the same metering. Treat the tables above as real numbers,
not devnet-flavoured ones.

`mint` at ~2,900 RC is the everyday cost that matters: a user with only the
10,000-RC free allowance and no MAGI HBD can afford roughly three mints before
having to wait out the five-day thaw.

### End to end, on a real MAGI chain (v1 run)

| Step | Result |
|---|---|
| deploy | storage proof signed by a witness, contract id issued, 10 TBD paid |
| `init 193` | `ok=true`, `ret="initialised at height 193"`, real `state_merkle` CID |
| `getStateByKeys` | `cfg_init="1"`, `cfg_genesis="193"`, `cfg_settled="193"` |
| `migrate_batch`, 25 liquid accounts | `ok=true`, `"migrated 25 of 25"` |
| read back | `bal_hive:lcliq0000="100000000"`, `sup_migrated="2500000000"` — exact |
| `migrate_batch`, 1 staked account | `ok=true`; `bal_="100000000"`, **`shr_="50000000"` — staked POWER converted 1:1**, and `gov_board` picked the account up |

### 🔴 migrate_batch gas — `MaxMigrateBatch = 50` IS UNREACHABLE

**A batch of 50 cannot execute.** The schema caps `rc_limit` at 100,000, and
100,000 gas cycles = 1 RC, so **10,000,000,000 gas is the hard ceiling for any
single call**. A 50-account batch blows through it:

```
50 accounts -> gas_limit_hit, err_msg "cost limit exceeded"
```

The real ceiling is **25 accounts**, and 25 already spends 96,743 of the
100,000 RC budget — about 3% headroom.

Accounts carrying **staked POWER** (each creates a migration mint):

| accounts | gas_used | rc_used | RC per account |
|---|---|---|---|
| 1 (`migrate`, not batch) | 260,452,827 | 2,605 | 2,605 |
| 1 | 260,456,865 | 2,605 | 2,605 |
| 2 | 492,303,725 | 4,924 | 2,462 |
| **3** | 735,956,355 | 7,360 | **2,453** ← cheapest per account |
| 5 | 1,268,276,701 | 12,683 | 2,537 |
| 10 | 2,863,577,840 | 28,636 | 2,864 |
| 15 | 4,832,112,714 | 48,322 | 3,221 |
| 20 | 7,179,556,670 | 71,796 | 3,590 |
| 22 | 8,154,943,650 | 81,550 | 3,707 |
| 24 | 9,160,335,691 | 91,604 | 3,817 |
| **25** | 9,674,282,628 | 96,743 | 3,870 ← **maximum that fits** |
| 30 / 40 / 50 | >10,000,000,000 | — | **`gas_limit_hit`** |

Accounts with a **liquid balance only** (no mint) — an order of magnitude
cheaper, and near-linear:

| accounts | gas_used | rc_used | RC per account |
|---|---|---|---|
| 1 | 49,528,627 | 496 | 496 |
| 10 | 287,322,188 | 2,874 | 287 |
| 25 | 680,478,886 | 6,805 | 272 |
| 50 | 1,335,811,908 | 13,359 | 267 |

### What these numbers mean

**1. The migration MINT is the entire cost.** One staked account costs
260M gas; one liquid-only account costs 49.5M. The 182-day migration mint —
`registerMint`, the `shr_` write, the `gov_board` offer, the expiry-chunk
append — is ~210M gas of the 260M.

**2. Batching staked accounts is SUPERLINEAR, and past ~3 accounts it costs
MORE RC per account than not batching at all.** The marginal cost of the *n*-th
account rises from 232M gas at n=2 to 514M at n=25 — the curve is
`gas ≈ 6.1M·n² + 226M·n`. Every migration mint matures on the same day (they
all take the genesis height), so they all append to the same chunked expiry
list and all contend for the same 20-slot `gov_board`; both are O(n) per
insert, giving O(n²) per batch.

**This contradicts the assumption in CLAUDE.md** that `migrate_batch` at 50
would cut the migration's RC bill ("~121 calls at measured cost instead of
6,039"). Extrapolating to the 6,039-account snapshot, worst case where every
account carries stake:

| strategy | calls | total RC |
|---|---|---|
| single `migrate` | 6,039 | 15,731,595 |
| batches of 3 | 2,013 | **14,815,680** |
| batches of 10 | 604 | 17,296,144 |
| batches of 25 | 242 | 23,411,806 (**+49%**) |

Batching buys **fewer broadcasts, not less RC.** Batches of 25 cost half again
as much RC as sending them one at a time.

**3. The strategy the data suggests:** split the snapshot by shape. Migrate
**liquid-only accounts 50 at a time** (13,359 RC per call, linear, cheap), and
**staked accounts in small batches of 3-10**. Do not use one batch size for
everything, and do not use 50 for staked accounts — it cannot execute.

**4. ⚠️ RC here is charged on ACTUAL usage, not on `rc_limit` — which is the
opposite of what CLAUDE.md recorded on mainnet.** Measured exactly:

```
before:              9,727 RC   (max_rcs = 10,000; MAGI HBD balance is 0)
call at rc_limit 7,000, gas_used 680,478,886 -> rc_used 6,805
after:               2,922 RC   = 9,727 - 6,805, to the unit
```

`9,727 − 6,805 = 2,922` exactly. Had the full `rc_limit` been frozen the
account would show 2,727. CLAUDE.md's mainnet incident — six calls at
`rc_limit = 100,000` locking `@lassecashmagi` out for days against a 22,000-RC
capacity — is only explicable if mainnet charges the limit.

**The consequence is that this devnet is NOT a safe place to validate an RC
budget.** It is more forgiving than mainnet, so an `rc_limit` that passes here
can still park five days of a real account's capacity. Keep sizing `rc_limit`
to measured usage (as `sequence.sh` does) and treat the mainnet rule — never
set `rc_limit` above what you are willing to lock for five days — as still in
force. Worth confirming which behaviour current mainnet witnesses have; the
divergence is probably a node-version difference, and it is exactly the kind of
thing TibFox's caveat is about.

Everything else about RC does hold here: capacity really is MAGI HBD in
milli-units plus 10,000 free, and the gas→RC ratio really is 100,000 gas = 1 RC
(every row in the tables above confirms it).

### Caveats

- Simulations start from the state at the time of the call and are not
  persisted, so each row above measures a batch landing on the *same* base
  state. A real run migrates onto ever-growing state, so real costs are at
  least these.
- All test accounts carry an identical 1.0 LC liquid / 0.5 LC staked position.
  Amount size does not affect gas (integers are fixed width), but the
  liquid-vs-staked split does, enormously — see above.
- Devnet witnesses run this checkout. Confirm anything consensus-critical
  against mainnet, whose witnesses may run a different version.

### What to measure next, and how

The same `simulate` command answers the other constants CLAUDE.md flags as
guesses. All of them are free here.

| Constant | Command shape |
|---|---|
| `MaxCurationDrain = 20` | `simulate -action claim_curation` / `settle_pending` after seeding a post with many voters |
| `MaxAccrualDays = 1200` | `simulate -action advance -payload 1200` against a contract whose accrual is far behind — CLAUDE.md measured 5.85B gas for a 1200-day walk on mainnet, which is **58,500 RC and therefore under, but close to, the 100,000 cap** |
| `MaxRetirePerWalk = 200` | `advance` across the migration maturity day, when thousands of mints retire at once |
| `MaxMigrateBatch` | **measured — see above. 50 does not execute; 25 is the ceiling** |

Note the shape of the finding above applies to all of them: the per-call gas
ceiling is a hard 10,000,000,000, so any bounded loop whose bound was chosen by
judgement needs checking against that number, not against intuition.

---

## Operational notes

- **First `up.sh` is slow.** It builds a Docker image containing the whole
  go-vsc-node tree compiled with WasmEdge (~10 min), pulls several GB of HAF
  images, boots PostgreSQL, waits for HAF to become healthy, runs
  `devnet-setup` to create and stake the witness accounts, starts the nodes,
  stops the genesis node to run `genesis-elector`, restarts it, and funds the
  witnesses. Budget 20-40 minutes and watch `~/.lassecash-devnet/logs/up.log`.
- **RAM.** Upstream says ~4 GB free. HAF's `shared_buffers` is pinned to 512 MB
  and Mongo to 1 GB by the harness, but four magi nodes plus PostgreSQL is
  still the dominant memory consumer on a small machine.
- **`down.sh` preserves state.** Contract ids, balances and block height
  survive. Only `reset.sh` destroys them.
- **`reset.sh` needs no sudo.** HAF leaves postgres-owned files behind; the
  wipe runs `rm -rf` inside a throwaway `alpine` container instead of asking
  for root on the host.
- **Migration has a deadline.** `CreditMigration` refuses once `cfg_settled >
  cfg_genesis`, and the accrual walk advances `cfg_settled` a whole day at a
  time (28,800 heights at 3 s). So on a devnet you have roughly 24 hours of
  wall clock after `init` to run migration calls. After that, `reset.sh`.
- **First deploy can time out.** `contract-deployer` collects a storage proof
  over libp2p, and if the p2p mesh has not settled it fails with
  `failed to request storage proof context deadline exceeded`. Nothing is
  spent; just run the deploy again a minute later. Both the first attempt
  failing and the retry succeeding were observed on 2026-08-21.
- **Partial provisioning cannot be resumed.** If `up.sh` dies after HAF has
  run, its PostgreSQL cluster directory is 0700 owned by the container's
  postgres uid, and the harness's own `MkdirAll` then fails with
  `permission denied`. It cannot be chmod'ed either — postgres refuses to
  start on a group- or world-readable cluster directory. `up.sh` therefore
  detects a non-provisioned data dir that HAF has already touched and throws
  it away before retrying. There is nothing to lose: "not provisioned" means
  the genesis election never ran.

### Changes made to the go-vsc-node copy

`~/.lassecash-devnet/go-vsc-node` is a *copy* of the checkout at
`~/.lassecash-deployer/src`. **The deployer's own checkout — the one holding
the real mainnet key — was not touched.** Two files were added and two
upstream defects were fixed in the copy; originals are kept alongside as
`*.orig`.

| File | Change |
|---|---|
| `cmd/lcdevnet/main.go` | **added** — the CLI these scripts drive |
| `tests/devnet/lc_export.go` | **added** — exports a few harness internals (`MarkStarted`, `Compose`, `GQLRaw`, …) the CLI needs |
| `cmd/devnet-setup/lc_fee.go` | **added** — reads the chain's real `account_creation_fee` |
| `cmd/devnet-setup/main.go` | **fixed** — hardcoded `Fee: "0.000 TESTS"` on five `account_create` ops. This HAF testnet image requires exactly `0.030 TESTS`, and hived asserts on the exact amount, so setup died with `Must pay the exact account creation fee` before creating a single witness. Now uses the value read from the chain. |
| `tests/devnet/docker-compose.yml` | **fixed** — `PGRST_DB_SCHEMA` listed `hafah_endpoints,hafah_api_v1,hafah_api_v2`, but `hafah:latest` installs only `hafah_endpoints`. PostgREST looped on `schema "hafah_api_v1" does not exist`, never went healthy, and took the whole drone stack down with it. Now `${PGRST_DB_SCHEMA:-hafah_endpoints}`. |

Both fixes are upstream bugs caused by image drift (`hafah` and the HAF
testnet image are pulled untagged, i.e. `:latest`), and are worth reporting to
the VSC devs. Re-cloning go-vsc-node reintroduces both.
- **Upstream harness.** Everything heavy is `tests/devnet` from
  `github.com/vsc-eco/go-vsc-node`; its own `README.md` documents the Go test
  API (`Partition`, `Disconnect`, `AddOutboundLatency`, …) if you ever want
  fault-injection tests rather than a standing devnet.

---

## Re-measurement on a VIRGIN contract — 2026-08-21, `main.wasm` 85,146 B

The v2 table above was measured on a contract that already carried state from
earlier calls. This run deploys the *same* WASM as a **fresh** contract, inits
it, and re-measures — which changes the answer, because the dominant per-account
cost turns out to depend on what is already in `gov_board`.

| | |
|---|---|
| Contract id | `vsc1BbjgJGpUJ5fGeuExVVW6dvQrnXhNofq5Lj` |
| WASM | `contract/artifacts/main.wasm`, 85,146 B, md5 `87065caf2f44d6a1b17a84e5d1c7d02d` |
| Genesis | `init 1055` → `ok=true`, `ret="initialised at height 1055"` (REAL broadcast) |
| Method | `simulateContractCalls` unless a row says REAL |

`hive:magi.test1` was topped up with `devnet.sh deposit -node 1 -amount "50.000"`
(RC ceiling 10,000 → 60,000) so real broadcasts could be made at all; the
witness account had 287 RC left from the earlier session.

### 🟢 migrate_batch is now LINEAR — the quadratic term is gone

The v1 curve was `gas ≈ 6.1M·n² + 226M·n`, unbounded per batch. In the current
build the per-account cost is **flat**, and what is left is a fixed per-call
overhead plus a constant per account:

**Staked accounts with VARIED stake sizes** — the realistic shape, since every
account offers a real `gov_board` seat. Measured with strictly ascending stake
(each entry displaces the board's bottom, i.e. the worst case):

| accounts | gas_used | rc_used | marginal gas/acct |
|---|---|---|---|
| 1 | 428,301,572 | 4,283 | — |
| 5 | 1,718,558,583 | 17,186 | 322.6M |
| 10 | 3,431,644,832 | 34,316 | 342.6M |
| 20 | 6,703,520,897 | 67,035 | 327.2M |
| 25 | 8,325,462,049 | 83,255 | 324.4M |
| **30** | **9,947,440,541** | **99,474** | 324.4M ← **the ceiling** |
| 31 | 10,023,192,293 | — | `gas_limit_hit` |
| 32 / 33 | >10B | — | `gas_limit_hit` |

**Fit: `gas ≈ 215M + 324M·n`, linear to within 1% from n=1 to n=30.**
Descending stake gives the same figures (n=25 → 8,326,882,790), so ordering
inside the batch does not matter.

**Staked accounts with IDENTICAL stake** (`100000000,50000000` each) are
cheaper past the twentieth, because once `gov_board`'s 20 slots are held by
equal-share accounts every later offer loses the name tie-break and is rejected:

| accounts | gas (virgin state) | gas (board already 10-full) |
|---|---|---|
| 1 | 290,365,223 | 374,699,879 |
| 3 | 770,550,364 | 941,726,720 |
| 5 | 1,275,352,565 | 1,535,568,480 |
| 10 | 2,729,602,382 | 3,141,311,027 |
| 15 | 4,341,567,446 | 4,742,374,192 |
| 20 | 6,144,927,226 | 6,389,990,124 |
| 25 | 7,324,730,869 | 7,519,777,862 |
| 30 | 8,503,572,781 | 8,651,501,636 |
| 33 | 9,211,456,113 | 9,329,374,947 |
| 35 | 9,683,377,718 | `gas_limit_hit` |
| **36** | **9,919,338,954** | `gas_limit_hit` |
| 37+ | `gas_limit_hit` | `gas_limit_hit` |

Marginal cost here rises ~6.7M gas per account **only while the board still has
a free slot**, then drops to a constant 226–236M once it is full
(virgin: `gas = 1,428M + 235.9M·n` for n ≥ 25, max error 0.3M). That residual
quadratic is therefore **bounded by the 20-slot board**, not by batch size — it
is spent once over the whole migration, not once per batch. This, not a smaller
constant, is why v2 beat v1.

⚠️ **The earlier v2 table's ceiling of 36 is the equal-stake best case.** With
real, varied stake the ceiling is **30**, and it moves down as contract state
grows. Size `MaxMigrateBatch` from the 324M/account figure, not from 236M.

**Liquid-only accounts** (no mint, no shares, no board offer) — linear and an
order of magnitude cheaper:

| accounts | gas_used | rc_used | RC/acct |
|---|---|---|---|
| 1 | 55,732,525 | 558 | 558 |
| 10 | 459,039,710 | 4,591 | 459 |
| 25 | 1,131,218,821 | 11,313 | 453 |
| 50 | 2,253,488,748 | 22,535 | **451** |

`gas ≈ 45M·n`; 50 fits with 4.4x headroom. Single `migrate`, for reference:
staked 379,495,578 (3,795 RC), liquid-only 54,627,648 (547 RC).

### 🟢 burn_batch — linear, cheap, and 50 fits with room to spare

Mixed entries (alternating `liquid,staked` and `liquid,0`):

| accounts | gas_used | rc_used | RC/acct |
|---|---|---|---|
| 1 | 65,934,729 | 660 | 660 |
| 10 | 457,631,202 | 4,577 | 458 |
| 25 | 1,130,094,226 | 11,301 | 452 |
| **50** | **2,231,935,582** | **22,320** | **446** |
| 100 | — | — | rejected: `batch exceeds 50 accounts` |

`gas ≈ 45M·n` — indistinguishable from liquid-only migration, which is right:
neither path creates a mint or touches the board. **50 is safe** (4.5x headroom);
the 10B ceiling would not bite until ~220 accounts, so `MaxMigrateBatch = 50` is
the only thing capping `burn_batch`.

REAL broadcast confirmation: `burn_batch` with 25 mixed accounts →
`ok=true`, `ret="burned 25 of 25 to null"`, and state reads back
`mig_hive:g3rb0000 = "burned|100000000|50000000"`,
`mig_hive:g3rb0001 = "burned|200000000|0"`, `bal_hive:null = "4350000000"`
(13×1.5 LC + 12×2 LC, exact).

### Everyday user costs (virgin contract, chained simulation)

`migrate_batch` credited `hive:magi.test1` 10,000 LC liquid, then:

| call | payload | gas_used | rc_used |
|---|---|---|---|
| `mint` | `100000000\|30` (1 LC, 30 days) | 240,076,521 | **2,401** |
| `transfer` | `hive:g3rcpt0001\|100000000` | 28,421,732 | **285** |
| `advance` (no-op, straight after) | `` | 2,314,677 | 100 |

`transfer` at 28.4M gas again matches CLAUDE.md's mainnet 28M / ~280 RC.
`advance` immediately after a 50-account liquid batch and after a 25-account
staked batch both returned `"accrual is current"` at **2,314,541 gas / 100 RC** —
the batches do not push the accumulator behind, so the post-batch walk is free.

### REAL vs simulated — they agree

`migrate_batch` with 10 staked accounts, broadcast for real at `rc_limit 30000`:
`ok=true`, `"migrated 10 of 10"`, and state read back
`bal_hive:g3s10x0000="100000000"`, `shr_hive:g3s10x0000="50000000"`,
`mig_hive:g3s10x0000="100000000|50000000"`, `sup_migrated="1500000000"`,
`gov_board` holding all ten. RC went 50,289 → 22,786, i.e. **~27,100 charged
against a simulated 27,297** — sim gas is real gas, and this devnet again
charged *actual* usage rather than the 30,000 `rc_limit` (mainnet freezes the
limit; that difference still stands).

### ✅ Recommended `MaxMigrateBatch`

**Lower it from 50 to 20.** 50 cannot execute for staked accounts and never
will; the measured hard ceiling is **30** with realistic varied stake, and every
figure here was taken against a nearly-empty contract, so real costs during the
migration are floors. 20 costs 6.70B gas / 67,035 RC — **33% headroom** under
the 10B/100,000-RC wall, which survives both state growth and a witness running
a slightly different metering version.

Because the curve is linear, **batch size is now RC-neutral**: ~3,240 RC per
staked account whether you send 1 or 30, versus 3,795 RC for a lone `migrate`.
Batching is a straight win now (fewer broadcasts *and* ~15% less RC), which is
what CLAUDE.md always assumed and v1 did not deliver.

Projected for the real 3-month snapshot (1,582 staked + 403 liquid-only
migrating, 7,923 burning):

| work | batch size | calls | RC |
|---|---|---|---|
| staked migrations | 20 | 80 | ~5.13M |
| liquid-only migrations | 50 | 9 | ~0.18M |
| burns | 50 | 159 | ~3.53M |
| **total** | | **248** | **~8.8M** |

Split the work by shape, as before: **20 for staked, 50 for liquid-only and for
`burn_batch`.** A single `MaxMigrateBatch` of 20 caps all three safely; the
executor can simply send fewer than the cap for the cheap shapes if a single
constant is preferred.
