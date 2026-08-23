![image.png](https://images.hive.blog/DQmeHb1rpB5v4eF25ZjJM95R8eLN1DDpBr3LWsiAL9nECmi/image.png)


# LASSECASH migrates to MAGI — the snapshot rules, and your last week to act



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
years. What is new is that they are now enforced by a
contract instead of by my word.

## The snapshot

At Hive block **109,504,918**, on **Monday 31 August 2026, 12:00 UTC (14:00 CEST)**, I take a snapshot of every
LASSECASH balance in existence. That snapshot is permanent. It is published in
full — every account, every amount — and committed to the MAGI contract as a
single Merkle root, so anyone can verify their own entry, and anyone can verify
mine.

**Balances migrate 1:1.** Liquid LASSECASH becomes liquid LASSECASH. LASSECASH
POWER becomes a 30-day mint whose L-Shares equal your staked amount exactly —
no bonus, no penalty, the same weight you already had.

Your LASSECASH in the Diesel pool and in open sell orders is counted and
credited to you. So is LASSECASH POWER under power down, and LASSECASH you
have delegated out. Nothing you own is missed.

## Who is in the snapshot

**You must have used LASSECASH.**

To be included, your account must have signed at least one **LASSECASH
transaction on Hive-Engine within the 6 months before block 109,504,918**.

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

### This rule is stricter than the one in my first warning

On 21 August I said an **ACTIVE-key transaction on Hive** would count — a
transfer, a power-up, a delegation — and I called the design "heavily locked
in". **That half of the rule is gone.** Being alive on Hive proves a human
exists; it does not prove that human ever used LasseCash. Thousands of these
accounts hold LASSECASH only because I handed it to them. So the test is the one
above: a **LASSECASH** operation, signed by you. It is stricter, it burns more
accounts, and I am not going to dress that up — I would rather change a rule
before the snapshot than defend a bad one after it.

I edited that post afterwards, but **every version of it is still in Hive's
block history and anyone can read them all.** I cannot delete what I wrote, and
I am not trying to. I have changed my mind in public plenty of times over seven
years — usually because I found a better answer, sometimes because the first one
was bad. That is what building something alone looks like. **What matters is
that this is close to the last time it can happen.** On 10 October the owner key
is destroyed, and after that nothing here can be revised by anyone, including me
— not because I have become more careful, but because the key will not exist.

### ⚠️ Do not trust "Active X ago" on hive.blog

That number only measures **posting and voting**. It ignores every transfer,
every power-up, every trade. There are accounts on Hive showing "Active 7 years
ago" that move tens of thousands of HIVE every month.

It will tell you the wrong answer in both directions. **Check whether you are
in the snapshot here: https://lassecash.pages.dev/check** — type your account
name and it tells you which side of the line you are on, and what to do about
it if you are out. It reads the same rule the snapshot itself uses.

If you would rather check by hand: hive-engine.com wallet → LASSECASH →
history, and look for an operation **you** signed since February.

## Your last week

If you are not in the snapshot under the rule above, **you have until block
109,504,918 — Monday 31 August, 12:00 UTC (14:00 CEST) — to fix it**. That is
eight days from this post.

Do one LASSECASH transaction. Send 1 LASSECASH to a friend. Send it to
yourself. Stake some. That is all it takes, and it costs you nothing but a
signature.

Nobody can say they were not told. I have been talking about the MAGI
migration for over a year, and over the last three months I published **20
videos across four platforms**, talking about this migration in nearly all of
them. Add this post and the earlier warnings, and I would put it to you that
few migrations of a token this old have been announced this many times, this
far ahead, by one person.

If you follow me at all, you have heard about this. If you have not, it is
because you were not listening.

## What happens to the rest

LASSECASH belonging to accounts that do not qualify is credited to
**@null** — Hive's black hole account, which has no keys and never will.

It is not deleted and it is not quietly redistributed to me. It sits at @null
where anyone can see it, forever. **Every account that is burned is also written into the
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

**The owner key is destroyed at a block about 40 days after genesis** — the
exact height is `genesis + 1,152,000`, and I will publish it as a number in the
migration genesis post the day the contract goes live. Not at launch, and I want to be
straight about why.

Until that block the key can do exactly **one** thing: propose a code update.
It **cannot touch anyone's tokens** — there is no entrypoint in the contract
that lets the owner move somebody else's balance, mint, or liquidity. And a
proposed update is not secret and not instant:

- it is **visible on-chain for 48 hours** before it can take effect — anyone
  can query `findPendingContractUpdates` for the contract id (published in the
  migration genesis post) against `https://api.vsc.eco/api/v1/graphql`, and the query
  returns the proposer, the CID of the new code, and the exact block at which
  it could activate
- it can be **cancelled** inside that window
- it **cannot alter state** — balances, claims, mints and the pool survive an
  update untouched

So for 40 days you are not trusting me, you are **watching** me, and you have
two days' notice on anything I propose. After the burn block no update can ever
be proposed by anyone, including me. The burn transaction id will be published
here.

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

**If a defect cannot be fixed in place**, the contract would be redeployed —
and what that costs depends entirely on when it happens, so here is both cases
rather than the flattering one.

**In the first days**, when almost nothing has happened, it is simple: everyone
claims again from the identical Merkle tree, for the same amounts, at their own
free Resource Credits.

**After a month of real use it is not simple, and I am not going to pretend
otherwise.** By then people have transferred, posted, earned, minted and
traded. Redeploying from the original snapshot would be a rollback — a month of
everyone's decisions undone, and winners and losers picked at random by
whatever each person happened to do in between. Somebody who sold into the pool
would get their LASSECASH back while the person who bought it lost theirs.

**That is not what would happen.** The contract keeps a roll of every account
that has ever held value, so its entire state can be read by anyone at any
block. A redeploy after real activity restores positions **as they stood at the
moment of the fault**, not as they stood at the snapshot. Nobody is rolled back
to August.

**And the old contract does not stop working.** Nothing on a blockchain can be
deleted, so it keeps running exactly as before. That matters more than it
sounds: **withdrawing from the liquidity pool has no dependency on the reward
machinery** — `remove_liquidity` does not read the accrual clock, the monthly
payout or the emission schedule. If something breaks in the reward code, every
liquidity provider can still take their LASSECASH and their HBD out of the old
contract, in full, whenever they like. Their money is not trapped by a bug
somewhere else in the contract. But it is their action to take — a redeploy
cannot reach into the old contract's custody and move their HBD for them.

Beyond that, what a redeploy costs is the emission that was being minted while
the chain was broken — on the order of 9,000 LASSECASH a day at era-1 rates —
and the time everybody spends dealing with it. If I can make
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

Seven years on Hive-Engine, and I am grateful for them. @Aggroed and his team
have spent a lot of hours on me and on LasseCash, especially in the first
years. They gave me an opportunity of a lifetime. It has been a rough ride
living with the limitations of Hive-Engine's build, but for me personally it
changed my life, so I am very thankful for that team. This is not a
falling-out; it is a token outgrowing their 'spreadsheet'.

## Verify everything yourself

- **The snapshot: every account and amount** — published in full the moment
  the snapshot is taken, at the same time as the migration genesis post
- **The Merkle root, committed on-chain** — proves the published list is the
  one the contract actually uses, and it is published with the snapshot
- The contract source at **https://github.com/LasseEhlers/LasseCash-Migration-to-MAGI**
- The full rules at **https://lassecash.pages.dev/about** — the new site.
  ⚠️ Not the old About page on lassecash.com: that one describes the
  Hive-Engine era and this migration supersedes it.

You do not have to trust me on any of this. That is the entire point.

---

*This migration to MAGI is maybe the biggest achievement of my lifetime thus
far. If this is really as good as I believe it is — to everyone that has been
with me over the years, and to everybody that will use this product in the
future, thank you for your contributions.*

You heard it here first.

Lasse
