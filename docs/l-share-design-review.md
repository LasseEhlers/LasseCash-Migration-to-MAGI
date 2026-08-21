# L-Share design review

Written 2026-08-20, against the spec in "LasseCash Core Migration to MAGI".

## Verdict up front

The core design is sound and I would build it. It is a coherent adaptation of
HEX's time-lock model onto a Proof-of-Brain social chain, and the central
insight — that **one instrument should serve as stake, vote weight, and
governance right** — is genuinely good. It removes a whole class of complexity
that Hive carries (separate HP, separate witness votes, separate proposal
system) by collapsing them into a single number.

Two things in the spec are **contradictory as written** and will produce a
broken product if implemented literally. Both need a decision before LasseMint
is coded. Neither is a flaw in the idea; both are underspecified prose.

---

## BLOCKER 1 — the early-end penalty curve is backwards (or ambiguously worded)

The spec says:

> Breaking a time-lock contract early results in forfeiting all accrued yield
> and a structural slash on the principal based on remaining time
> (**linear curve 50% at day 1, and 100% when the mint is mature**).

There are two readings and they are economic opposites.

**Reading A — the slash goes 50% → 100%.** You lose half your principal if you
quit on day 1, and *all* of it if you quit just before maturity. This is
perverse: the penalty grows as commitment grows. A minter 1,000 days into a
1,095-day lock would be better off having quit on day 1. Nobody would ever
approach maturity. This cannot be what is meant.

**Reading B — the *recovery* goes 50% → 100%.** You get back half your
principal if you quit on day 1, rising linearly to all of it at maturity.
Equivalently the slash falls 50% → 0%. This is the standard design, it is what
HEX does, and it correctly rewards commitment.

**Recommendation: Reading B.** Implement as:

```
recovered = principal * (50% + 50% * elapsed_days / total_days)
slashed   = principal - recovered      -> swept to the reward pool
```

At day 1 of a 1,095-day mint you recover ~50%; at day 1,095 you recover 100%.
Accrued yield is forfeited entirely on any early end, per the spec.

**The spec sentence must be rewritten either way** — as it stands two competent
developers would build opposite products from it.

---

## BLOCKER 2 — "Good Accounting Mode" and the 4-month bleed destroy each other

The spec defines both:

> **Good Accounting Mode:** when a mint hits maturity it stops earning yield
> but remains locked in an "Unclaimed/Matured" state, allowing the user to
> **delay the realization event to a preferred calendar year**.

> **Post-Maturity Expiry:** grace period of 30 days, then a linear bleed over
> 90 days, and at day 120 the remaining balance reaches 0% and the position
> closes permanently.

These are in direct conflict. Deferring a realization event into the next tax
year requires holding across a year boundary — up to 365 days. The bleed
liquidates the position **completely in 120 days**.

Worked example: a mint matures 1 October. The user enables Good Accounting to
defer the gain into January. By 1 January they are 92 days past maturity — 62
days into the 90-day bleed — and have lost roughly **69% of principal** to save
tax on a gain that no longer exists. By 29 January the position is worth zero.

Good Accounting Mode, as specified, is a trap that destroys the user it claims
to help.

**Three possible resolutions:**

1. **Good Accounting pauses the bleed.** The position sits matured and safe
   indefinitely, earning nothing. Simplest, and honours the stated intent.
   Cost: matured capital can idle forever, which weakens the recycling engine.
2. **Good Accounting extends the grace period to 12–18 months**, then bleeds.
   Preserves the recycling pressure while making the feature actually usable.
3. **Drop Good Accounting Mode.** It is a tax-planning convenience whose
   audience is small, and it adds a state flag plus a branch in the bleed
   accounting.

**Recommendation: option 2**, with a 400-day grace. It is the only one that
delivers the stated purpose (cross a calendar boundary) without abandoning the
bleed. Option 3 is a perfectly respectable alternative if you want less
surface area — you said you do not want to complicate things, and this is a
place where that instinct is right.

---

## AMBIGUITY 3 — how do the two multipliers combine?

The spec gives "Longer Pays Better" a max of 1.5x and "Bigger Pays Better" a
max of 1.5x, but never says how they compose.

- **Multiplicative:** 1.5 x 1.5 = **2.25x** maximum
- **Additive:** 1.0 + 0.5 + 0.5 = **2.0x** maximum

The difference is 12.5% of every large long-term minter's share allocation —
material, and it changes the whole share-rate economy. HEX composes its bonuses
multiplicatively.

**Recommendation: multiplicative (2.25x).** It matches HEX, it is the natural
reading of "multiplier", and it rewards the doubly-committed minter (max size
*and* max duration) more than linearly, which is the stated design intent.

---

## OBSERVATION 4 — governance is nominal at launch, and that should be said out loud

The spec makes the **top 10 L-Share holders** the consensus group controlling
posting thresholds and future dApp fees.

Live chain data (2026-08-20): the founder holds **7,222,688 LC** of a
**29,763,159 LC** total across all accounts — and of the ~15M that actually
migrated under the old criteria, roughly **48%**.

With that distribution the founder can occupy the top slot and, by minting
across several controlled accounts, plausibly influence more. "Decentralised
protocol governance" is therefore aspirational at genesis, not descriptive.

This is not necessarily wrong — an early-stage project with a committed founder
is normal, and an AnCap project may reasonably reject the pretence of
decentralisation-by-committee. But the About page should say what is true. A
governance claim that the chain data contradicts is the single easiest thing
for a critic to attack, and the fix is one honest sentence.

Worth considering: cap any single account's weight in the top-10 group (e.g. no
account may contribute more than 20% of consensus weight). Cheap to implement,
and it makes the claim defensible.

---

## OBSERVATION 5 — the share rate is fixed at 7%, and that is a real improvement on HEX

In HEX the share rate rises as a *consequence* of payouts when stakes end,
which makes it emergent, gameable at the margins, and impossible for a user to
plan against.

Setting it to a flat **+7% per annum** makes minting cost fully predictable:
a user can compute today exactly what a mint started in three years will cost.
That is a genuine design improvement, not a simplification. Keep it.

One consequence to be aware of: over 75 years the share rate compounds to
`1.07^75` ≈ **164x**. A year-75 minter receives 1/164 the shares per LC that a
genesis minter did. That is the intended early-adopter reward, and it is
extreme — but it is also exactly what "upward-only ratchet" means, and it is
honest because it is announced in advance.

---

## OBSERVATION 6 — the 3-year maximum is right, and it helps the recycling engine

HEX allows ~10-year stakes. A 3-year maximum means faster turnover, which means
more mints reaching maturity, which means more penalty and bleed events, which
means more tokens recycled into the reward pool. Given that recycling is what
funds the pool after emission ends in year 75, the shorter maximum is
load-bearing, not merely a convenience.

---

## Summary of decisions needed

| # | Decision | Recommendation |
|---|---|---|
| 1 | Early-end penalty direction | Recovery rises 50% → 100% (Reading B) |
| 2 | Good Accounting vs bleed | 400-day grace, then bleed — or drop the feature |
| 3 | Multiplier composition | Multiplicative, 2.25x max |
| 4 | Governance concentration | State it honestly; consider a 20% weight cap |
| 5 | Share rate | No change — keep flat 7%/yr |
| 6 | Max duration | No change — keep 3 years |
