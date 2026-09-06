# Moving LASSECASH's ledger into a standard `magi_token`

**Decided 2026-09-06 by Lasse, after `docs/STANDARD-TOKEN-SPIKE.md`.** The
economics stay ours; the ledger becomes MAGI's standard, so their indexer,
their wallets and their DEX see LASSECASH natively — and BTC → LASSECASH in
Altera becomes possible. This must land BEFORE the key burn, because after it
nothing about the core can change.

**This is not a hardfork and nobody re-claims.** It is a timelocked code
update to `vsc1Be4TTjUiHgzhHAfqFn6s3PDAExH2X59fXV` — the same mechanism proven
twice on throwaway #9 and once on production (activating 7 Sep) — plus a
one-time owner-only migration of the balance rows. Contract id, mints,
tranches, pool, board, claim tree: untouched.

## What moves and what does not

**Moves into the token:** every liquid balance — users', the pool's LASSECASH
side, principal held inside open mints, parked curator pots, pending balances
*(see "one open question")*, the stranded 1,030 at bare-name keys, and
**hive:null's 18.69M burn**, which becomes a balance any standard explorer can
read.

**Stays in the core:** `shr_` L-Shares, mint records, LP tranches with their
ages and accumulator readings, the pool's HBD custody and reserve accounting,
curation queues, `gov_board`, thresholds, `mig_<acct>` receipts (history),
the Merkle root. The core holds *positions and claims*; the token holds
*money*.

## The design

### The core OWNS the token

Deploy `magi_token`, `init` it as `hive:lassecashmagi`, then `changeOwner` to
`contract:vsc1Be4…`. From then on only the core can mint, and no human can.
**Proven on the devnet 2026-09-06** — after the handover the previous owner
got `Must be owner to mint`.

`maxSupply` is set at init to **51,000,000.00000000** (5.1e15 base units).
That makes the hardcap enforced TWICE and independently: by our emission code
and by the token itself. Stronger than today.

### `credit` / `debit` become the only things that change

22 call sites touch balances; `credit()`/`debit()` in `ledger.go` are the
chokepoints and 11 uses sit outside it. Nothing else in the contract knows
where money lives. Measured cost: **+204 RC per balance movement** (301 vs 97
for a local write); a cross-contract READ is 17 RC, cheaper than a local
write, so balance reads get cheaper.

- **credit(acct, amt)** → the core holds unissued supply; `transfer` from the
  core to `acct`. (Mint into the core in bulk when its float runs low, never
  per payout — `mint` credits the owner, so a per-payout mint would be two
  calls instead of one.)
- **debit(acct, amt)** → `transferFrom(acct → core)`, which needs the user's
  allowance. The site grants it in the same signed transaction as the action,
  exactly as it already does for the BTC swap (`increaseAllowance` + call).

### Migrating the rows — self-marking, no window to fall into

`ensureMigrated(acct)` runs at the top of `credit`/`debit`:

> if `bal_<acct>` exists and is non-zero → mint that amount to `acct` in the
> token, delete `bal_<acct>`, continue.

A deleted key reads as empty, i.e. absent (the empty-vs-nil rule), so **"has a
non-zero `bal_`" means "not yet migrated"** and the state marks itself. No
flag, no double-count, and an account touched mid-migration migrates itself
before anything else happens to it.

The owner then sweeps the rest with an owner-only `migrate_ledger
<acct>|<acct>|…`, batched, idempotent, atomic per batch — the same discipline
as `migrate_batch`, which was rehearsed on a virgin chain in August. ~353
accounts at ~500 RC each ≈ 177k RC total, so 4–8 calls. Minutes.

### Where the token's id lives

In a **state key written once at update time**, not hardcoded — so a
compatible redeploy could be pointed at if MAGI ever moves. NOT governable:
a top-ten able to repoint the ledger could point it at a token they control
and mint themselves everything. The weld is deliberate.

⚠️ **Accepted permanently:** after the burn, `changeOwner` on the token can
never be called again, and the core speaks only the interface it was built
with. Mitigated by the fact that this is **ERC-20's interface** — `transfer`,
`transferFrom`, `approve`, `balanceOf` — the most stable interface in crypto,
and their contract has been unchanged since 19 May 2026 with an external audit
behind it.

## ⚠️ TOKEN BALANCES CANNOT BE READ THROUGH GraphQL — measured 2026-09-06

A magi_token stores balances as **big-endian unsigned bytes**, and the node's
GraphQL layer replaces any byte that is not valid UTF-8 with U+FFFD. Asking
`getStateByKeys` for `bal|hive:null` when it holds 50,000,000,000 returns
`"\u000b\ufffd;t\u0000"` — the `0xA4` is destroyed and the number is
unrecoverable. This is not our bug and not fixable from our side.

**The contract path is fine**, and that is what matters for correctness:
`ContractStateGet` does a plain `string(bytes)` with no validation. Proven on
the devnet with a probe contract that reads the token and returns what it
sees: **`len=5 value=50000000000`**, exact.

**Consequence for the site and the API, and it is not optional:** anything
outside the chain must read balances by calling the token's **`balanceOf`**
through `simulateContractCalls`, which answers `{"balance":"50000000000"}` as
a decimal string. Simulations cost no RC, so this is a latency cost, not a
money one. Affects `MagiBackend.account()`, the `/api/supply` burned figure
(hive:null's balance moves into the token) and anything else that reads
`bal_`.

## Two properties inherent to a standard token, to state publicly

1. **Anyone can call the token directly**, bypassing our site — including
   sending to a malformed address and stranding the tokens, as happened to
   1,030 LASSECASH on 1 September. Our guard protects our path; it cannot
   protect a raw call. True of every ERC-20 ever written.
2. **Tokens sent directly to the pool contract are a donation** the reserve
   accounting will not see. Also true today, and of every AMM.

## What the site has to do

- Read balances from the token (17 RC, cheaper than now).
- Bundle `increaseAllowance` ahead of every value-taking action in the same
  confirm — mint, promote, add_liquidity, swap. One wallet prompt, as now.
- Show the token's contract id on `/chain` beside the core's.
- Explain the two pools on `/pool` and `/about`: ours pays the 25% emission
  slice at 0% fee, theirs (when it exists) is the on-ramp at 0.08%. Lasse:
  *"it might be a little hard for people to understand, but the site explains
  the rewards clearly."*

## ✅ PROVEN END TO END ON A REAL CHAIN — devnet, 2026-09-06

`tools/devnet/prove-token-ledger.sh`. Not a test double: a deployed
`magi_token` built from vsc-eco's source, and the real contract with the
token ledger compiled in.

| step | result |
|---|---|
| Deploy token + core, init both | ok |
| **`changeOwner` the token to `contract:vsc1BX7EY…`** | CONFIRMED; `owner` reads the core |
| **The human deployer tries to mint** | **REFUSED — `Must be owner to mint`** |
| `set_token` on the core | `token ledger set to vsc1BgFF2xh…` |
| `set_snapshot` with a 500 LASSECASH burn total | ok |
| **Token `totalSupply`** | **50,000,000,000 = 500.00000000** |
| **Token `balanceOf(hive:null)`** | **50,000,000,000 = 500.00000000** |
| **Core `sup_migrated`** | **50,000,000,000** |
| **A real `claim_migration` at a fresh account's free 10,000 RC** | **success, 2,072 RC used** |

All three supply figures agree exactly: the burn committed at snapshot became
REAL TOKENS at hive:null, readable by any standard explorer, and the token's
total supply equals the core's own accounting to the base unit.

And the claim — the path 2.69M unclaimed still depends on — costs 2,072 RC
against the free 10,000. The question that opened this whole spike is
answered on-chain, not projected.

⚠️ Devnet charges ACTUAL RC; mainnet freezes the full `rc_limit`. Gas is the
trustworthy figure; re-validate the budget on a mainnet throwaway.

## The remaining proof, before production

Nothing reaches production until all of this passes on a throwaway:

1. `go test ./...` — the economics are untouched, so the whole suite must stay
   green with the ledger swapped behind `credit`/`debit`.
2. **A fresh 500,000-round fuzz** on the exact build (`TestFuzzEconomy`), with
   `auditEconomy` after every operation.
3. **Throwaway #10**: deploy token + core, run the update, migrate the rows,
   then `tools/state-snapshot.py diff` — every non-balance key byte-identical.
4. **`tools/entrypoint-sweep/sweep.py`** — every entrypoint answers as before.
5. **The new invariant**: the core's own token balance must equal the sum of
   what it owes — pool reserves + mint principals + pending + curator pots.
   Checked on-chain readable state, not only in tests.
6. A real `claim_migration` on the throwaway from a fresh account with the
   free 10,000 RC, confirming the projected 4,221–6,096.

## Sequence — the production run

**Step 0 is done: the 7 September update was CANCELLED on 6 Sep** (cancel tx
`2c394c62d2987e7452f126071a7b550889e24619`). `findPendingContractUpdates` is
empty, production still runs the original launch code `bafkreifnneb…e3fm`, and
its three changes all live inside the token-ledger build anyway. See the
CLAUDE.md section "PRODUCTION CONTRACT UPDATE — CANCELLED 2026-09-06".

**The artifact is verified.** Throwaway #10's on-chain code CID
`bafkreihztepfwl5noydp3qab7odgsfvtfetupozxytbxw4uorxqdm5nrsu` is byte-identical
to the local `contract/artifacts/main-tokenledger.wasm`. What was proven on
mainnet is the exact file that goes to production. Recompute any time with
`tools/cid.py` (CIDv1 + raw codec + sha256, base32) — it reproduces the
old queued CID from `main.wasm` exactly, which is how the method was checked.

| # | Step | Command | Cost |
|---|---|---|---|
| 1 | Deploy the production token | `WASM=contract/artifacts/magi-token.wasm NAME=LASSECASH DESC="LASSECASH — the token ledger of the LasseCash core contract" ./deploy.sh deploy` | 10 HBD (L1) |
| 2 | `init` the token | `node tools/chain-test/call.js <TOKEN> init '{"name":"LasseCash","symbol":"LASSECASH","decimals":8,"maxSupply":"5100000000000000"}'` | RC |
| 3 | Queue the core update | `WASM=contract/artifacts/main-tokenledger.wasm CONTRACT_ID=vsc1Be4TTjUiHgzhHAfqFn6s3PDAExH2X59fXV ./deploy.sh update` | 10 HBD (L1) |
| 4 | Wait out the 48-hour public timelock | visible on `/chain` and via `findPendingContractUpdates` the whole time | — |
| 5 | On activation: run the diff + sweep | `docs/UPDATE-PROOF-RUNBOOK.md` "PRODUCTION QUEUED" — against `prod-before.json` and `prod-sweep-before.txt` | free |
| 6 | Hand the token to the core | `changeOwner` -> `contract:vsc1Be4TTj…` | RC |
| 7 | Point the core at the token | `set_token <TOKEN>` | RC |
| 8 | Sweep the legacy rows | `migrate_ledger` in batches of **50**, rc_limit **50,000** | ~822 RC/account |
| 9 | Merge `duration-default-30` | frontend only; only after step 5 passes | — |
| 10 | Ask MAGI for `register_token` + `register_pool` | owner-only on their router — the BTC route. NOT on the critical path | — |
| 11 | **Burn the key**, at an announced height | | |

**Step 6 comes BEFORE step 7 and 8, and that order is load-bearing.** The
sweep mints, and only the owner can mint — so the core must own the token
before `migrate_ledger` can move a single row. Proven on throwaway #10, where
@lassecashmagi was refused with "Must be owner to mint" the moment the handover
landed.

Steps 1 and 3 spend 10 HBD each from @lassecashmagi's **Hive L1** balance
(26.898 HBD as of 6 Sep — enough, leaving ~6.9). Step 8 spends RC, which is
MAGI HBD: at 150 HBD parked the meter is ~160,000, and consumed RC thaws over
five days.

**The burn date moves.** 10 October is not reachable with this done properly.
Announce the new height once the production update has activated and the sweep
is complete. The genesis post promised the burn and the reason for it; the
honest framing is *"before freezing forever, LASSECASH adopts MAGI's token
standard, so it can be traded and held everywhere on the network."*
Announcement debt is cheaper than a frozen mistake.

## One open question, to settle during the build

**Do pending (unmintted PoB) balances move into the token?** They are not
spendable and not voting weight — they exist only until the month turns and
they become a mint. Leaving them internal keeps the token's supply equal to
*spendable + locked* rather than *everything*; moving them makes the token's
`totalSupply` the whole truth. **Lean: move them**, so `totalSupply` is the
supply, and outside tools never disagree with `/api/supply`.

## Rollback

If the migration fails part-way, the state is consistent by construction:
migrated accounts have tokens and no `bal_`, unmigrated ones have `bal_` and
no tokens, and `ensureMigrated` handles both. The sweep can be re-run; it is
idempotent, and a half-finished sweep is a working chain — an unmigrated row
migrates itself the next time its owner is touched.

⚠️ **This paragraph used to end "the one irreversible step is `changeOwner`,
which happens LAST, after the rows are all across" — that was WRONG and it
contradicted the sequence above.** `changeOwner` must come FIRST: the sweep
mints into the token, and only the owner can mint, so no row can cross until
the core owns the token. The stale sentence survived the correction that fixed
the numbered list, which is exactly how an operational document gets someone to
do the wrong thing at midnight. `changeOwner` is still the irreversible step —
it just happens early, and everything after it is re-runnable.


---

## ✅ VALIDATION COMPLETE — 2026-09-06

| | |
|---|---|
| **500,000-round fuzz** on the token ledger | PASSED, 2h45m, zero failures — with the stricter audit that also asserts the core holds exactly what it owes |
| **Every LASSECASH path** simulated against live throwaway #10 | claim_mint, claim_pool, remove_liquidity, settle, advance succeed outright; transfer, burn, mint succeed with the allowance bundled |
| **Wallet flows on MAINNET** | claim, mint, transfer, add liquidity — all signed through Keychain by Lasse |
| **Self-migration** (`ensureMigrated`) | PROVEN ON A CHAIN: 500 LASSECASH in a legacy row, a 1 LASSECASH transfer, and the row is gone with 499 in the token and 1 delivered |
| **The owner sweep** (`migrate_ledger`) | PROVEN ON A CHAIN: rows deleted, token balances exact **including a 1-base-unit account** |
| **Supply conservation** | `sup_migrated` == token `totalSupply`, to the base unit |
| **Batch scaling of the sweep** | LINEAR, measured on the devnet at n = 1, 2, 4, 8 — see below |

**Measured RC, mainnet:** claim 2,109 · mint 3,138 · transfer 1,965 · burn 1,368 ·
claim_mint 1,115 · remove_liquidity 1,145 · **sweep ~823 per account**.

### The sweep is LINEAR in batch size — MEASURED 2026-09-06

`tools/devnet/prove-sweep-scaling.sh`, eight seeded liquid-only accounts on the
local devnet, `migrate_ledger` simulated at every batch size:

| n | gas | RC | RC / account |
|---|---|---|---|
| 1 | 93,381,639 | 934 | 933.8 |
| 2 | 175,547,353 | 1,755 | 877.7 |
| 4 | 339,878,552 | 3,399 | 849.7 |
| 8 | 668,540,795 | 6,685 | 835.7 |

`gas = 11.2M + 82.2M x n`, which reproduces every measured row to three
significant figures — **no n^2 term**, unlike August's `migrate_batch`. RC per
account FALLS slightly with n because the 112-RC fixed cost amortises; the
marginal account is **822 RC**, matching the mainnet figure above.

**Production batch size: 50.** That is 41,200 RC of real cost, so an rc_limit of
50,000 carries a 20% margin and still sits well under MAGI's hard 100,000
ceiling. 100 would technically fit (82,300 RC) with no margin left, which is not
worth the saving — mainnet FREEZES the whole rc_limit for the five-day thaw, so
an oversized limit costs throughput directly.

⚠️ **The first run of this test was a false pass, and the lesson generalises.**
Every owner call ran from node 1, whose 10,000-RC devnet meter ran out during
the deploys. `migrate_batch` and `set_token` both returned `ok=false`, the
script never checked, and `migrate_ledger` was measured against accounts holding
nothing with no token configured. It printed gas flat at ~1.0M and RC/account
falling from 10.2 to 0.6 — which reads as an excellent result. A sweep
measurement that has not verified its own seed is measuring argument parsing.
The script now splits the owner calls across nodes, aborts on any `ok=false`,
and reads `bal_hive:k00` and `cfg_token` back before printing a single number.

A transfer costs ~7x what it did (285 -> 1,965). That is the real price of a
standard ledger, and a large part of it is the per-call allowance — a frontend
choice that can later become approve-once, which is what every ERC-20 app does
and which is safe here because only the frozen contract can spend it and it
only ever debits its own caller.

**Not rehearsed, and accepted:** the UPDATE path combined with the ledger
switch. Both halves are proven separately — updates preserve state
byte-identically (twice on #9, once on production) and the switch works
against populated state (above) — and they do not interact: an update swaps
the WASM, the switch is a state flag.
