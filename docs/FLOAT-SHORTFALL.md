# The float shortfall — found 2026-10-02, BEFORE the key burn

## What is wrong

The core contract's books say it owes **9,189,552 LASSECASH**. The token says
it holds **166,665**. The gap is **9,022,886**, and the supply invariant the
whole design rests on is broken by the same amount:

```
sup_migrated        28,073,017.24485356
sup_emitted            273,972.59424000
books say           28,346,989.83909356
token totalSupply   19,157,828.37187454
SHORTFALL            9,189,161.46721902
```

Measured on mainnet, 2 Oct 2026, against contract
`vsc1Be4TTjUiHgzhHAfqFn6s3PDAExH2X59fXV` and token
`vsc1BUDsVccMPGycTmpc98WsQYSKyTBsZqFq4h`.

## How it was found

Lasse pressed Claim on his matured 7,005,065 migration mint — the first claim
of the day-30 cliff — and the chain refused. Not with the expected "day has
not closed yet" (that was a separate, now-fixed frontend bug) but, once the
accrual walk was simulated forward, with **`Insufficient balance`** from the
TOKEN contract. Capital I: our own contract says it lowercase, so the message
was never ours.

## The cause

`credit()` deliberately does NOT mint. "The core holds the float and hands it
over … a short float means an accounting leak, and failing loudly is the
correct response to one." It was correct, and it failed loudly, three weeks
after the leak was created.

The token ledger was adopted on **8 September** (`set_token`, then
`migrate_ledger`). `migrate_ledger` walks a list of ACCOUNTS and moves each
one's legacy `bal_` row into the token via `ensureMigrated`, which mints the
legacy balance and hands it to the owner.

**Everything the CONTRACT itself held had no `bal_` row.** Mint principals sit
in mint records; pool balances in `pool_*`; the AMM's LASSECASH side in
`amm_lc`. None of them is a `bal_` row, so none of them was migrated, and
nothing ever minted their backing.

| owed | amount |
|---|---|
| open mint principals (8,823,529 migration stakes + 121,418 voluntary) | 8,944,947 |
| reward pools (lshare + viral + deep + liq) | 201,739 |
| LASSECASH side of the AMM | 42,865 |
| **total** | **9,189,552** |

The 166,665 actually in the float is what emission has minted SINCE 8 Sep.

⚠️ **The verification on handover night checked what was moved** ("no legacy
`bal_` row holds value") **and not what was left behind.** That is the whole
lesson.

## Why no test caught it

`auditSupply` runs in every contract test and would have caught a leak — but
it runs against `MemStore`, where the token and the core are the same world.
The gap only exists on a chain where they are two contracts and one was
adopted after the other. **A test double kinder than production is not a test
double**, and this is the same trap as the empty-vs-nil bug, one layer up.

## Who is affected

- **Balances are fine.** `ensureMigrated` self-heals a legacy `bal_` row on
  first touch, minting it. Transfers, swaps, votes, posting all work.
- **Any claim larger than the float fails.** Small ones have been passing
  (andy4475 23 Sep, cinqowy 30 Sep) because they fit inside 166,665.
- **Every pre-8-September mint is unpayable** until this is fixed. The 35
  migration claims made before the handover are the bulk of it.
- Nothing is lost or stealable: the positions exist on the books. What is
  missing is the token backing.

## The fix

A one-time, owner-only, idempotent entrypoint that mints

```
(sup_migrated + sup_emitted) − token.totalSupply
```

into the core. It restores the invariant by construction, and it cannot
overshoot: the token's own 51M `maxSupply` is an independent backstop, and
19.16M + 9.19M = 28.35M, exactly `migrated + emitted`.

## ⚠️ Consequence for the key burn

The burn was set for **10 October, day 40**, precisely so the first claims,
the first accruals, the first monthly PoB mint and the day-30 maturity would
all have happened on the real chain first — with the owner key still alive as
the recovery path if the chain surprised us.

It has surprised us, in that window, exactly as designed. **The burn must not
happen until this is fixed, deployed and a real large claim has been paid on
mainnet.** Freezing a contract that cannot pay its largest positions would be
unrecoverable.

## Order of work

1. Rehearse the fix on a throwaway (10 HBD).
2. Queue the production update (10 HBD, 48h timelock).
3. After activation: verify supply == migrated + emitted, float >= obligations.
4. Pay Lasse's 7,061,423 claim on mainnet as the proof.
5. Only then revisit the burn date, and announce the delay with the reason.

## Standing check to add before any burn

A reconciliation that asks, against the LIVE chain, whether the token holds
what the books say is owed — mint principals, pools, pending, curator pots,
AMM. It either balances to the base unit or it does not. "The tests pass" is
not the same statement.
