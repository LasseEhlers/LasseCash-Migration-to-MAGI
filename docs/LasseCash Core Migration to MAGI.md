Golden rule for all my development: One engine, everywhere. The Go engine is the only implementation of LasseCash economics. It runs on-chain, in the dev chain, and in the browser. The frontend may compute previews freely — but only by calling the engine, never by reimplementing a formula in TypeScript.
The chain remains the only source of truth. A preview is a preview; anything that becomes a transaction is confirmed by the chain.


# 

# LasseCash Core Migration to MAGI

## 1. 📦 Migration snapshot, Clean Burn, 51M Hardcap Integrity & Migration Staking

- The 51M Hardcap & Post-Migration Inflation Cap: The ecosystem strictly adheres to the historic 51M absolute token hardcap. Following the MAGI migration, new future token emission is strictly capped at a brand-new limit of 20,000,000 new tokens issued over time, corresponding with the original model day 1 (11M for founder for promotion and profit, 20M for inflation the first 10 years—which turned out to be around 7 years—and 20M forever thereafter asymptotically).
- Migration Snapshot & Liveness Filter: To transition into the new sovereign economy while discarding legacy dead weight and bot distortion, a migration snapshot is executed. Announced 2 weeks prior (but noticed already August 12, 2026 in a public post on LasseCash), any account completely inactive for 3 months is omitted. To be deemed active, an account must fullfill both of the following qualifying criterias:

### Criteria (a): Recent Activity & Engagement

- Rule: An account must show verifiable chain activity (such as a post, comment, or vote) within the last 3 months (90 days), OR be designated as an active core platform account.
- Implementation: Cross-references the Hive condenser API for last_vote_time and last_post timestamps against the current snapshot time.

### Criteria (b): Minimum Token Holding Threshold

- Rule: An account must hold a combined total of at least 100.0 LASSECASH (liquid balance plus staked power combined).
- Implementation: Ensures dust accounts and empty wallets are filtered out of the active migration snapshot to optimize the new chain distribution.
Note on Exceptions: Official protocol sink and burn addresses (such as @lassecash) are explicitly omitted from migration, with their unmigrated balances permanently directed to @null.

- 
  1:1 Liquid Balance Migration: All liquid LASSECASH balances held by active users are snapshotted and migrated 1:1 to the new engine state as brand-new liquid tokens on Day 1. (based on that the account is considered alive).
  Staked Power Conversion (LASSECASH POWER ➔ Migration L-Shares): The legacy LASSECASH POWER mechanic is permanently abandoned and superseded. Old staked power is translated directly into Migration L-Shares 1 to 1. These are automatically placed into a 6-month migration mint to flush out legacy liquidity and purge past dead weight.
- The Clean Burn: The remaining undistributed reserve sitting in @lassecash (the remainder of the 20M inflation for the first 10 years) at snapshot time is permanently burned (0% migrated) (by being move to @null at migration), maintaining strict adherence to the supply bounds.

## 2. ⏳ Inflation & Emission Schedule (20M Max Cap)

Future inflation is strictly capped at 20,000,000 LASSECASH forever. Tokens are issued per block ($1\text{ block} = 3\text{ seconds}$) with a 50% halving every 3 years ($31,536,000\text{ blocks}$).

| Period (Years) | Total 3-Year Emission | Annual Emission | Approx. Per-Block Reward |
| Years 1–3 | 10,000,000 LC | ~3,333,333 LC | ~0.317 LC |
| Years 4–6 | 5,000,000 LC | ~1,666,666 LC | ~0.158 LC |
| Years 7–9 | 2,500,000 LC | ~833,333 LC | ~0.079 LC |
| Years 10–12 | 1,250,000 LC | ~416,666 LC | ~0.039 LC |

## 3. 🎯 The Per-Block Allocation Breakdown

Every block reward is distributed evenly across three core pools to maximize simplicity and organic utility:
- 50.0% — Proof-of-Brain (PoB): Direct rewards for creators and curators within LasseMedia.
- 25.0% — L-Share: Yield distributed to long-term capital minters holding L-Shares.
- 25.0% — Pool Rewards: Automated yield for DEX liquidity providers supporting the main trading pair LASSECASH:BTC.

## 

## 4. 🛡️ LasseMint: Technical Specification & Smart Contract Mechanics

### Core Architecture & Naming (L-Shares)

- Immutable Staking Units: L-Shares are the immutable, trustless time-lock staking units of the LasseCash ecosystem.
- Multi Purpose: L-Shares determine your voting power in the proof of brain for the reward pool and serve as your Voting Power for decentralized protocol governance.
- Top-10 Minter Consensus: The 10 accounts holding the highest number of active L-Shares automatically form the consensus group responsible for governing dynamic protocol parameters.

### The Mechanics of L-Shares (Bigger Pays Better, Longer Pays Better, Worldwide Share Rate)

- The Worldwide Share Rate (SR): The cost to mint 1 L-Share is governed by a worldwide shareRate variable.
- Upward-Only Ratchet: The shareRate goes up forever with 7% per annum—it will never decrease in LASSECASH terms, rewarding early commitment safely within a strict 3-year maximum duration (1,095 days / 31,536,000 blocks).
- Minting Formula: L-Shares = (Amount minted / shareRate) * (Minting Days / 1,095 days)
Here is the text formatted cleanly so you can copy and paste it directly into your Writer document:

# LasseCash Tokenomics Rules

This document outlines the core linear scaling rules for the LasseCash minting engine. These mechanics ensure that participants are rewarded proportionally for their commitment in both time and volume.

Longer Pays Better (Duration Multiplier)
The multiplier scales linearly from 1 day to 3 years (1,095 days). 
- Min Duration (1 day): Multiplier = 1.0
- Max Duration (1,095 days): Multiplier = 1.5
Formula for d days (where 1 <= d <= 1095):
Multiplier = 1.0 + ((d - 1) / 1094) * 0.5 

Bigger Pays Better (Volume Multiplier)
The multiplier scales linearly based on the commitment amount. 
- Min Volume (<= 10,000 LASSE): Multiplier = 1.0
- Max Volume (>= 100,000 LASSE): Multiplier = 1.5
Formula for amount A (where 10,000 < A < 100,000):
Multiplier = 1.0 + ((A - 10,000) / 90,000) * 0.5 

## Summary Table

| Parameter | Base (Min) | Cap (Max) | Max Multiplier |
| Duration | 1 Day | 1,095 Days | 1.5x |
| Volume | 10,000 LASSE | 100,000 LASSE | 1.5x |

### xReward Distribution & End-of-Mint Payouts

- Timing: Rewards are fully calculated and paid out at the end of the mint when a user terminates their active lock via the Claim Mint.
- Yield Source: Funded by the 25% from the inflation emission pool.
- Payout Formula: User Reward = Pool Rewards Accrued * (User's L-Shares / Total Network L-Shares)
- Early End Mint, Penalties & The Penalty Sink: Breaking a time-lock contract early results in forfeiting all accrued yield and a structural slash on the principal based on remaining time (linear curve 50% at day 1, and 100% when the mint is mature). 100% of penalties are swept instantly into the active reward pool to benefit loyal minters.
- Tax Deferral via "Good Accounting": Users can toggle "Good Accounting Mode" on individual minters. When a mint hits maturity, it stops earning yield but remains locked in an "Unclaimed/Matured" state, allowing the user to delay the realization event to a preferred calendar year.

### Post-Maturity Expiry & The 4-Month Bleed Mechanic

- Grace Period (Month 1 / 30 Days): Yield generation stops at maturity; principal and rewards remain 100% safe.
- Linear Bleed Phase (Months 2, 3, and 4): If unclaimed after 30 days, a microscopic fraction of the balance is shaved off linearly every block over 90 days.
- Total Liquidation (Month 4 / Day 120): Remaining balance reaches 0% and the position closes permanently, with 100% of bled tokens sweeping into the worldwide reward pool.

## 5. 📝 LasseMedia: Proof-of-Brain Content & Curation

Every block reward is distributed evenly across three core pools to maximize simplicity and organic utility, with 50.0% allocated directly to Proof-of-Brain (PoB) rewards for creators and curators within LasseMedia.
- The Proof-of-Brain System & Dual-Window Architecture: The Proof-of-Brain system reminds that of the old LasseCash OUTPOST and Hive blogging, but we have both Viral posts and Deep posts.
  - Viral Posts: Designed for faster content, with a 7-day payout window, a 7-day vote regeneration period, and taking 25% of the rewards from the Proof-of-Brain pool.
  - Deep Posts: Designed for deeper AnCap topics, with a 30-day payout window, a 30-day vote regeneration period, and taking 75% of the rewards from the Proof-of-Brain pool.
- Governance & Posting Thresholds:
  - Posting Unlock Thresholds: Accounts need a minimum amount of L-shares to unlock the ability to post.
  - Top-10 Consensus Control: The top 10 L-share holders decide these specific posting thresholds for both viral and deep content.
- Technical Parameters & Split Mechanics:
  - Curation vs. Author Split: 25.0% of post rewards go to curators, while 75.0% go to authors.
  - Reward Curves: Both post and curation rewards operate on a linear power curve with a parameter of 1.0.
  - Voting Rules: Each full vote consumes 10.0% of an account's vote power.

## 

## 

## 6. 🔄 Pool/Swap

As part of the core migration, the main liquidity pool is created: LASSECASH:HIVE. We are building a dedicated frontend page for this swap pool as well, since we cannot rely on external third-party sites like Altera to list our pool. The pool functions similarly to Diesel pools on Hive Engine.
It is a simple pool with a potentially high reward structure. Liquidity providers receive LASSECASH depending on the amount of liquidity they provide. There is a bonus of 1% per day in the pool, up to a maximum of 90 days. Each time a person provides liquidity, a new tranche is created—meaning different tranches can have different maturity lengths. It is simple and easy. The rewards come from the inflation pool, with 25% allocated as stated above.
There are only the swapping fees on MAGI layer and transactions rely on Magi Resource Credits and Hive Resource Credits,. For most users, holding very small amounts in these positions is more than enough to provide plenty of RC across both networks. The reward on the LasseCash pool comes from the LasseCash inflation and will potentially attract liquidity, as I hope these rewards will be very high.

