# A supply discrepancy on Hive-Engine

While auditing LASSECASH for the MAGI migration I checked the token's recorded
supply against the sum of everything that actually exists: every account
balance, every stake, every pending unstake, every delegation, and every token
held inside a Hive-Engine contract.

They do not match.

**LASSECASH: 31,000,000 recorded. 31,485,173 actually in existence.
485,173 more than the supply figure says.**

I then ran the identical check on five other Hive-Engine tokens.

```
token          recorded supply     actually exists    difference        %
LEO             1,000,000,000      1,000,012,880       +12,880     +0.00%
LASSECASH          31,000,000         31,485,173      +485,173     +1.57%
POB                12,418,404         12,455,402       +36,998     +0.30%
PIZZA               4,337,500          4,338,864        +1,364     +0.03%
CTP                15,930,918         15,930,918             0     -0.00%
VIBES               1,103,817          1,103,817             0     -0.00%
```

**Four of the six do not reconcile.** This is not specific to LASSECASH, but
LASSECASH is by far the worst affected — 1.57%, five times POB and four hundred
times LEO.

## What I ruled out

**My own arithmetic.** CTP and VIBES reconcile to zero using exactly the same
calculation. If the method were wrong, every token would be wrong.

**Delegations.** For LASSECASH the `tokens.delegations` table totals
101,733.29749755, matching the sum of `delegationsOut` on the balances exactly.
A delegation correctly leaves the delegator's stake, and the receiver's
`delegationsIn` is a separate field. No double counting.

**The unstaking schedule.** `tokens.pendingUnstakes` totals 520,057.11160018
against the balances field's 520,057.11159987 — a difference of 0.0000003. The
26-instalment powerdown accounting is clean.

**The negative-delegation ghosts.** Three LASSECASH accounts carry impossible
negative `pendingUndelegations` totalling −1,670,098.96, left behind by an old
Hive-Engine bug. But CTP and VIBES carry the same kind of negatives and still
reconcile perfectly, so the ghosts are not the cause either.

## What I am not going to do

Find the cause. That would mean auditing years of Hive-Engine contract history,
and I do not think that is a good use of anyone's time seven years after the
fact. I am reporting what is measurable, not diagnosing someone else's ledger.

## Who this hurts

Nobody was robbed and no tokens were taken from anyone. There are simply more
tokens in existence than the record claims, which means every holder's
proportional share is slightly smaller than the published supply implies. For
LASSECASH that is 1.57%. There is no identifiable victim, which is part of why
it went unnoticed for years.

I am stating it publicly because it is true, because anyone can check it, and
because it should be on the record before LASSECASH leaves.

## What it means for the LasseCash migration

The 51,000,000 hardcap is the one number I have never changed since 2019. It
survives this:

```
exists on Hive-Engine today                   31,485,173
− undistributed inflation, not migrated          598,784
= credited to holders at the snapshot         30,886,389
+ MAGI emission cap                           20,000,000
= maximum that will ever exist                50,886,389
  hardcap                                     51,000,000
  unused headroom                                113,611
```

The undistributed inflation still sitting in the old pool-rewards distribution
contract — **598,784.15 LASSECASH** — is **not migrated**. It was issued, it
never reached a holder, and it stays behind on Hive-Engine. That absorbs the
entire discrepancy, and the cap holds exactly.

I could have moved it across and quietly let the cap slip by 485,173. Instead
it is left behind, and this post exists.

## After the migration

On MAGI the supply is enforced by an immutable contract. Every figure closes to
the base unit or the transaction is refused — there is no field that can drift
away from reality. And once the owner keys are burned there is nobody who could
change it even if there were.

That is the reason for the migration, and this is a small example of why.

---

*Every number above is reproducible from public Hive-Engine data:
`tokens.tokens`, `tokens.balances`, `tokens.contractsBalances`,
`tokens.delegations`, `tokens.pendingUnstakes` and `marketpools.pools`. Figures
measured 2026-08-23. If you find an error in my arithmetic I will publish the
correction.*
