# Proving a contract update preserves state — throwaway #9, 3 Sep 2026

The genesis post tells people a MAGI contract update preserves state and is
publicly visible for 48 hours before it lands. That is what the node's source
says. Until this run, nobody had tested it — and after the key burn on
10 October there is no second chance to find out.

So it gets proven on a throwaway first, mechanically, before the same update
is queued on production.

## The update under test

| | |
|---|---|
| Contract | `vsc1BV7EjeGGNCkA1yJ1iv2gzGkDjFGFwXv9Hi` — throwaway #9, TESTWINDOWS |
| Owner | `hive:lassecashmagi` |
| New code CID | `bafkreibsen7eiqyxbnu4ws3z63aopddcxpod2y2wi5jw5innpboyul4xcm` |
| Queued at height | 109,541,171 |
| **Activates at height** | **109,598,771 — 2026-09-03 18:51:39 UTC (20:51 CPH)** |
| Timelock | 57,600 blocks exactly — 48 hours at 3s |

Re-read it from the chain at any time, and note that ANYONE can — that public
visibility is half of what is being proven:

```bash
curl -s https://api.vsc.eco/api/v1/graphql -H 'content-type: application/json' \
  -d '{"query":"{ findPendingContractUpdates(filterOptions:{byId:\"vsc1BV7EjeGGNCkA1yJ1iv2gzGkDjFGFwXv9Hi\"}) { id code owner creation_height activation_height activation_ts proposer } }"}'
```

Once it activates, that query returns an empty list and `findContract` reports
the new code CID. An empty list is the signal, not a failure.

## What the update carries — three changes, and only three

1. **`fund`** — a new entrypoint. Before: not found. After: answers.
2. **`transfer` refuses a bare recipient name.** `strings.Contains(to, ":")`.
   This is the fix for the 1,030 LASSECASH stranded on 1 September at keys no
   signer can ever match. Before: `transfer alice|100` is accepted. After:
   refused with "recipient must be a full address, e.g. hive:alice".
3. **The monthly Proof-of-Brain mint defaults to 30 days**, not 1,095.
   `DefaultDurationDays = engine.MigrationMintDays`. Not observable in the
   sweep — it only shows on an account that has never called `set_duration`,
   at the next month turn.

**Anything else that changes is a finding.** That is the entire point of the
diff below.

## Step 1 — the BEFORE snapshot (ALREADY TAKEN)

`deploy-data/update-proof/t9-before.json` — grabbed at head 109,574,751,
25 non-empty keys, on 3 Sep 00:54 CPH. It cannot be retaken after activation,
which is why it was taken early.

## Step 2 — after 20:51 CPH, the AFTER snapshot and the diff

```bash
python3 tools/state-snapshot.py grab vsc1BV7EjeGGNCkA1yJ1iv2gzGkDjFGFwXv9Hi \
    deploy-data/update-proof/t9-after.json

python3 tools/state-snapshot.py diff \
    deploy-data/update-proof/t9-before.json \
    deploy-data/update-proof/t9-after.json
```

The tool separates keys that legitimately move between two reads of a LIVE
contract — the accrual cursor, anything emission touches — from keys that must
be byte-identical. **A balance moving across an update is a failure. The
settled height moving is just time passing.** Exit code 0 and "PASS" is the
result being looked for.

## Step 3 — the entrypoint sweep

```bash
python3 tools/entrypoint-sweep/sweep.py --contract vsc1BV7EjeGGNCkA1yJ1iv2gzGkDjFGFwXv9Hi
```

All 33 entrypoints through `simulateContractCalls` — read-only, nothing
broadcast, no HBD, no RC. Paced at 2.2s because the node caps a client at
about 30 simulations a minute.

**Exactly two rows must differ from the pre-update sweep:**

| entrypoint | before | after |
|---|---|---|
| `fund` | function not found | answers |
| `transfer` (bare name) | accepted | refused — "must be a full address" |

Every other row must read as it did before. A third change means the update
carried something nobody intended.

⚠️ **The sweep's gas column on a REFUSED row is the cost of the rejection, not
of the real call.** It is measured before the contract does any work. Never
size an RC floor from a refused row — that mistake gave `set_param` a floor of
800 against a real cost of 1,217, and it could not succeed.

## Step 4 — only then, production

With the diff PASSing and the sweep showing exactly those two rows, queue the
same update on production `vsc1Be4TTjUiHgzhHAfqFn6s3PDAExH2X59fXV`.

- Costs **10 HBD on Hive L1** (not MAGI HBD — the fee is an L1 transfer).
  @lassecashmagi held 35.792 on L1 as of 2 Sep.
- Run `./deploy.sh preflight` first. The active-key check is the one that has
  ever caught anything.
- It then sits visible for 48 hours before it lands, exactly as this one did.
- **Take a production BEFORE snapshot the same way**, before queuing:
  `python3 tools/state-snapshot.py grab vsc1Be4TTjUiHgzhHAfqFn6s3PDAExH2X59fXV deploy-data/update-proof/prod-before.json`

The key burn is **10 October**. After it, `findPendingContractUpdates` can
never receive an entry for this contract again, because no key will exist to
sign one. Everything that is going to be fixed must be fixed before then.

---

**Note on where the snapshots live.** `deploy-data/` is gitignored — it holds
the deploy key in plaintext, which is how the upstream tool works — so the
snapshot files are LOCAL ONLY and are not in the repository. They are public
contract state, not secrets, so they can be published as evidence if the proof
is worth showing; they are simply not committed by default.

---

## ROUND 1 VERDICT — 2026-09-03, 20:56 CPH

The update activated on schedule at height 109,598,771. Results:

- **State diff: PASS.** All 25 keys byte-identical across the swap
  (`t9-before.json` → `t9-after.json`, 24,228 blocks apart).
- **Sweep: `fund` appeared** ("wasm function not found" → "funded pob").
  The only other changed row was `mint`'s share count — the 7%/yr ratchet
  moving across 20 hours, not a code change.
- **🚨 THE BARE-NAME TRANSFER STILL ANSWERED "transferred".** The guard was
  NOT in the activated code — and neither was the 30-day default. Cause,
  established from git: the update was queued 2026-09-01 18:12 UTC; the
  transfer guard was committed 20:54 UTC and the default 2026-09-02. **The
  artifact predated two of the three changes this document said it carried.**
  The runbook described the intent; the WASM was two days older. The sweep
  caught exactly the class of error it exists to catch.

**What round 1 proved, build-independently:** the update mechanism works —
48h public timelock honored, activation on schedule, state preserved to the
byte, a new entrypoint reachable.

## ROUND 2 — the corrected build, queued 2026-09-03 21:19 CPH

Rebuilt from HEAD (the full contract-side delta since the production build is
exactly the three intended changes — commits d910a66+b297de2 `fund`, 35c8d79
guard, c27ef68 default; verified `strings` shows "must be a full address" in
the binary). TESTWINDOWS build, 96,298 bytes.

| | |
|---|---|
| New code CID | `bafkreifxgszcwisnbcxapt2pq2ia2lcilgvxo27wivmdc6xgawqm7qomfe` |
| Queue tx | `6b9cf3e6d9c5d5187e8d96a5920324072313c85d` (10 HBD) |
| **Activates** | **height 109,656,821 — 2026-09-05 19:21:57 UTC (21:21 CPH Saturday)** |
| Round-2 BEFORE | `t9r2-before.json` (25 keys); sweep baseline `t9-sweep-after.txt` |

After Saturday's activation: diff `t9r2-before` → fresh grab, sweep again.
**Expected vs the round-1 after-sweep: exactly one changed row — the bare
name transfer flipping to "recipient must be a full address".** Then queue
the MAINNET build (`contract/artifacts/main.wasm`, same HEAD) on production
`vsc1Be4TTjUiHgzhHAfqFn6s3PDAExH2X59fXV` — prod BEFORE snapshot first —
activating Monday evening. Sunday's first payouts land between the two, so
anything they teach can still fold in before the production queue.

## ROUND 2 VERDICT — 2026-09-05, 21:50 CPH: PASS, the mechanism is proven end to end

Activated on schedule at 109,656,821. Checked at head 109,657,282:

- `findPendingContractUpdates` → empty; `findContract.code` →
  `bafkreifxgszcwisnbcxapt2pq2ia2lcilgvxo27wivmdc6xgawqm7qomfe`, the round-2
  CID exactly.
- **State diff: PASS.** `t9r2-before.json` → `t9r2-after.json`, 25 keys
  byte-identical across 58,113 blocks.
- **Sweep: exactly ONE changed row** against round 1's after-sweep
  (`t9r2-sweep-after.txt`): `transfer` with a bare name flipped from
  "transferred" to **"recipient must be a full address, e.g. hive:alice"**.
  The qualified transfer still succeeds. Every other row identical (the
  `swap_lc_hbd: HBD transfer failed` line was already in the baseline — it is
  the sweep probing without an HBD intent, not a change). The sweep flags the
  transfer row as "worth a look" because its expectation table predates the
  guard; that flag IS the expected result.
- The 30-day default is not sweep-observable, as documented above.

So: a queued update sits publicly visible for 48 hours, activates at the
announced height, preserves every byte of state, and carries exactly the
code it was built from — proven twice, the second time with the corrected
artifact. What remains is doing it once on production, before 10 October.

**Lesson for every future update: pin the artifact to a commit at queue
time.** Record `git rev-parse HEAD` and the WASM sha256 beside the queue tx,
and rebuild immediately before queueing — never queue an artifact that has
been sitting in `artifacts/` while the source moved.
