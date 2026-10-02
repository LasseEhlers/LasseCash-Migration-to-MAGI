# The contract could not pay my own claim. We are not burning the keys on 10 October.

Last night I pressed Claim on my migration mint — 7,005,065 LASSECASH that had
been locked since genesis and matured on 1 October. The chain refused it.

Not because of anything I did wrong. The contract genuinely could not pay.

Here is exactly what is wrong, with the numbers, because I would rather you
heard it from me with the figures than from someone else without them.

## What is wrong

LASSECASH on MAGI keeps two sets of books. The contract records what it owes —
every open mint, the four reward pools, the LASSECASH side of the trading pool.
The token ledger records the tokens that actually exist.

Right now the contract's books owe **9,189,552 LASSECASH** and the token ledger
holds **166,665**.

Everything the *contract itself* holds was never backed by real tokens. Not the
mint principals. Not the reward pools. Not the pool's own LASSECASH.

## How it happened

On 8 September I upgraded LASSECASH to MAGI's standard token so that wallets
and explorers could see it. That upgrade moved every **account balance** into
the new ledger. It did not move the amounts the **contract** was holding on
everyone's behalf, because those are not account balances — they live inside
mint records and pool counters.

That night I checked that every account balance had moved across. It had. I did
not check what had been left behind.

Small claims have been working since, because they fit inside what the contract
happened to be holding. Mine is 7,061,423, and it does not.

## What this means for you

**Nothing is lost and nothing is stolen.** Your position is recorded on chain,
publicly, exactly as it always was. The missing piece is backing, not
ownership.

**Your balance works.** Transfers, swaps, posting, voting, liquidity — all
normal.

**Claiming a matured mint is paused** until this is fixed. If you try, you will
get an error. That is the contract refusing to pay out money it does not hold,
which is the correct behaviour and the reason this was caught at all.

**Nothing expires.** Grace on the migration mints runs to 29 December. You do
not need to do anything, and you are not losing value by waiting.

## Why the keys were not burned yet — and why that matters

I said from the start that LasseCash would be immutable: the owner key
destroyed, no admin, no take-backs. I also said the burn would happen at day
40, on 10 October, and not on launch day. People asked me why wait.

This is why. The key's only remaining power was to ship a public, timelocked
code update. I kept it alive for exactly one reason: in case the live chain
showed us something the tests could not.

It did. On the first morning it was possible to find it.

If I had burned the keys at launch the way "100% immutable from day one" would
have sounded better, this contract would now be frozen forever, unable to pay
9.19 million LASSECASH of its own obligations. Permanently. To everybody.

So the burn planned for 10 October does not happen. The waiting period did its
job and I am going to use it.

## The fix

One function, run once: mint the difference between what the books say exists
and what the token ledger actually holds, into the contract. After it runs the
two agree exactly, and every position is backed.

It cannot create extra tokens. The 51,000,000 hard cap is enforced inside the
token itself, independently, and the fix brings the total to 28.3 million —
which is precisely what the books already said.

## When the keys do burn

Not on a date I pick tonight. On a condition:

1. The fix is live on mainnet.
2. A large claim — mine, the biggest one — has actually been paid.
3. The books and the token ledger reconcile to the last decimal.

Then I announce the burn height, with at least a week's notice, the way I
promised the first time.

I would rather tell you this now, in public, with the numbers, than quietly
freeze a contract that cannot pay. Immutability is only worth something if what
you are making immutable actually works.

Lasse Ehlers
