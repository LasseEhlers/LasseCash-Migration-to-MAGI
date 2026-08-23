# LASSECASH migrates to MAGI — the snapshot rules, and your last week to act

*Draft for Lasse to edit. Everything in `[SQUARE BRACKETS]` is a value we have
not fixed yet. The tone is deliberately flat and technical — the cheeky line
at the end is yours.*

---

## What is happening

LASSECASH is leaving Hive-Engine and moving to **MAGI**, where it becomes a
real smart contract instead of a token in someone else's database.

On MAGI there are **no fees**. Not low fees — none. Every action costs
Resource Credits, which regenerate, and RC on MAGI is simply your HBD balance
there; it is never spent. The economics are enforced by code that anyone can
read, and after launch **the owner keys are burned**, so nobody — including me
— can ever change the contract again.

The tokenomics are the ones I published in 2019 and have never changed: a
**51,000,000 hard cap**, **20,000,000** of new emission, halving every three
years, ending in year 75. What is new is that they are now enforced by a
contract instead of by my word.

## The snapshot

At Hive block **[BLOCK X]**, on **[DATE, TIME UTC]**, I take a snapshot of every
LASSECASH balance in existence. That snapshot is permanent. It is published in
full — every account, every amount — and committed to the MAGI contract as a
single Merkle root, so anyone can verify their own entry, and anyone can verify
mine.

**Balances migrate 1:1.** Liquid LASSECASH becomes liquid LASSECASH. LASSECASH
POWER becomes a 30-day mint whose L-Shares equal your staked amount exactly —
no bonus, no penalty, the same weight you already had.

Your LASSECASH in the Diesel pool and in open sell orders is counted and
credited to you. So is LASSECASH in an unstaking cooldown, and LASSECASH you
have delegated out. Nothing you own is missed.

## Who is in the snapshot

**You must have used LASSECASH.**

To be included, your account must have signed at least one **LASSECASH
transaction on Hive-Engine within the 6 months before block [BLOCK X]**.

That means one of these, done **by you**:

- a LASSECASH **transfer**
- a **stake** or an **unstake** (power up / power down)
- a **delegation** or undelegation
- a **market order** — buy, sell, or cancel

**These do NOT count**, and this is the part that will catch people out:

- posting or commenting, even with the `lassecash` tag
- **voting** on LasseCash posts
- a plain HIVE or HBD transfer
- **receiving** LASSECASH — rewards, or a gift from me, or anything sent to you

Receiving does not count because receiving is not something you did. Thousands
of accounts hold LASSECASH only because I handed it to them — at HiveFest, in
comment threads, for years. If you never did anything with it, you are not
being punished; you are simply not claiming something you never wanted.

### ⚠️ Do not trust "Active X ago" on hive.blog

That number only measures **posting and voting**. It ignores every transfer,
every power-up, every trade. There are accounts on Hive showing "Active 7 years
ago" that move tens of thousands of HIVE every month.

It will tell you the wrong answer in both directions. Check your own
LASSECASH history instead: **[LINK TO A CHECKER, or: hive-engine.com wallet →
LASSECASH → history]**

## Your last week

If you are not in the snapshot under the rule above, **you have until block
[BLOCK X] to fix it**. That is roughly **[N] days** from this post.

Do one LASSECASH transaction. Send 1 LASSECASH to a friend. Send it to
yourself. Stake some. That is all it takes, and it costs you nothing but a
signature.

Nobody can say they were not told. I have been talking about the MAGI
migration for a year and a half, and for the last [PERIOD] I have published a
60-second video **five days a week across four platforms** — [N_PUBLISHED]
published so far and [N_RECORDED] more already recorded — mentioning this
migration in nearly all of them. Add this post and the earlier warnings, and I
would put it to you that no hardfork in blockchain history has been announced
this many times, this far ahead, by one person.

If you follow me at all, you have heard about this. If you have not, it is
because you were not listening.

## What happens to the rest

LASSECASH belonging to accounts that do not qualify is credited to
**@null** — Hive's black hole account, which has no keys and never will.

It is not deleted and it is not quietly redistributed to me. It sits at @null
where anyone can see it, forever, and the amount is displayed on the LasseCash
chain page permanently. **Every account that is burned is also written into the
public record**, with the exact amount it held, so the history is provable
years from now.

## Claiming, after launch

Nothing is pushed to you. **You claim your own tokens**, with a proof, paying
your own Resource Credits — a new account's free allowance covers it, so this
costs you nothing.

The claim window is **seven months** (210 days), and *when* you claim matters:

| You claim | Your staked half becomes |
|---|---|
| **day 0–30** | a real 30-day mint, earning and voting from the moment you claim |
| day 30–120 | the full amount, straight to liquid, no yield |
| day 120–210 | the surviving fraction — it bleeds to zero across those 90 days |
| after day 210 | refused; the position recycles into the reward pool |

Your **liquid** half is always credited in full, whenever you claim inside the
window.

Claim early. Claiming in the first 30 days is the only way to get the mint,
the yield and the voting power.

## No admin keys — and exactly when

The point of this migration is that the rules stop depending on me. On
Hive-Engine I held the keys to 20 million unissued tokens for seven years and
never touched one of them — but you had to take my word for it. On MAGI you
will not have to.

**The owner key is destroyed at block [BLOCK Y], about 40 days after genesis.**
Not at launch, and I want to be straight about why.

Until that block the key can do exactly **one** thing: propose a code update.
It **cannot touch anyone's tokens** — there is no entrypoint in the contract
that lets the owner move somebody else's balance, mint, or liquidity. And a
proposed update is not secret and not instant:

- it is **visible on-chain for 48 hours** before it can take effect — anyone
  can query `findPendingContractUpdates` for contract `[CONTRACT ID]`
- it can be **cancelled** inside that window
- it **cannot alter state** — balances, claims, mints and the pool survive an
  update untouched

So for 40 days you are not trusting me, you are **watching** me, and you have
two days' notice on anything I propose. After block [BLOCK Y] no update can
ever be proposed by anyone, including me. The burn transaction id will be
published here.

I considered burning the key at launch. It sounds better and it is worse: the
first weeks are when a live chain surprises you, and a contract nobody can
repair is not a feature if it breaks in week one.

## If something goes wrong

I would rather write this down now than improvise it later.

**Use this chain at your own risk.** It is new code on a new chain. I have
tested it as hard as I know how — every entrypoint has been run on mainnet with
a real wallet, the economics have survived 500,000 randomised simulated
economies with a full supply audit after every single operation, and the whole
mint lifecycle has been time-travelled from day one to day 1,185. That is not
the same as a guarantee, and I am not going to pretend it is. Do not put in
more than you are willing to lose. That is true of this chain and it is true of
every other one.

**If a defect is found and can be fixed in the code**, it is fixed by the
timelocked update described above. State is preserved. Nothing is lost and
nobody has to do anything.

**If a defect cannot be fixed in place**, the contract is redeployed against
**the same snapshot**. The Merkle tree does not change, so every holder claims
again from identical leaves, for the same amounts, at their own free Resource
Credits.

**And the old contract does not stop working.** Nothing on a blockchain can be
deleted, so it keeps running exactly as before. That matters more than it
sounds: **withdrawing from the liquidity pool has no dependency on the reward
machinery** — `remove_liquidity` does not read the accrual clock, the monthly
payout or the emission schedule. If something breaks in the reward code, every
liquidity provider can still take their LASSECASH and their HBD out of the old
contract, in full, whenever they like. Their money is not trapped by a bug
somewhere else in the contract.

The only value genuinely lost in a redeploy is the emission earned during the
dead days — on the order of 9,000 LASSECASH a day at era-1 rates. If I can make
someone whole for a loss caused by a mistake of mine, I will, and I would
rather say that plainly than promise something I might not be able to deliver
at a size I cannot predict. What I can promise is what the code already
enforces: **no key of mine can move your tokens, before the burn or after it.**

## Hive-Engine LASSECASH is dead after this

The old token keeps existing on Hive-Engine because nothing on a blockchain can
be deleted. **It will be worthless.** I am asking Hive-Engine to remove it from
hive-engine.com and tribaldex.com so nobody buys it by accident, and I will
change the token's description to say so. If you see LASSECASH for sale there
after the migration, do not buy it — those tokens are not the ones that move to
MAGI.

Seven years on Hive-Engine, and I am grateful for them. This is not a
falling-out; it is a token outgrowing a spreadsheet.

## Verify everything yourself

- The snapshot: every account and amount, published in full at **[LINK]**
- The Merkle root, on-chain at **[LINK]** — proves the published list is the
  one the contract uses
- The contract source at **[LINK]**
- The full rules at **[LINK TO ABOUT]**

You do not have to trust me on any of this. That is the entire point.

---

*[LASSE'S CHEEKY LINE HERE]*

Lasse
