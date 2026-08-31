# LASSECASH is live on MAGI — claim your tokens

## What happened

At Hive block **109,504,918** (Monday 31 August 2026) I took the snapshot I announced. It is final and it is public: **418 accounts** holding **11,730,692.24746305 LASSECASH** are in; **10,885 accounts** holding **18,688,809.72711925 LASSECASH** did not qualify and that amount now sits at @null, forever, listed account by account.

The whole snapshot is committed to the MAGI contract as one Merkle root:

`092f7b2ed2e6a0ccd3dadb832e9829c6419096171bcae68edb883fb099e46803`

Contract id: `vsc1Be4TTjUiHgzhHAfqFn6s3PDAExH2X59fXV` — genesis at Hive block **109,512,118**, 31 August 2026, ≈ 18:35 UTC.

LASSECASH is no longer a row in Hive-Engine's database. It is a contract on MAGI, with the tokenomics I published in 2019 enforced by code: **51,000,000 hard cap, 20,000,000 of new emission, halving every three years.** No fees — actions cost Resource Credits, which regenerate, and RC on MAGI is simply your HBD balance there; it is never spent.

## Claim your tokens — do it in the first 30 days

Nothing is pushed to you. You claim, with a Merkle proof, paying your own Resource Credits — a fresh account's free allowance covers it.

**https://lassecash.com** — the claim panel is on the front page: log in with your Hive account, press Claim. Ten seconds. **Use a desktop browser with Hive Keychain**; phone support follows in the first week.

Balances migrate 1:1. Your liquid LASSECASH arrives liquid. Your LASSECASH POWER becomes a 30-day mint whose L-Shares equal your staked amount exactly — same weight you had, no bonus, no penalty.

*When* you claim decides what your staked half becomes:

| You claim | Your staked half becomes |
|---|---|
| **day 0–30** | a real 30-day mint — earning and voting from the moment you claim |
| day 30–120 | the full amount, straight to liquid, no yield |
| day 120–210 | the surviving fraction — it bleeds to zero across those 90 days |
| after day 210 | refused; the position recycles into the reward pool |

Your liquid half is always credited in full inside the window. **Claim in the first 30 days** — that is the only way to get the mint, the yield and the voting power. And claim as soon as you can: yield and voting power start the moment you claim and stop at day 30 for everyone, so every day you wait is a day of yield you never get back.

## What is running from today

- **Post, comment, vote — and earn.** 50% of all new emission goes to LasseMedia creators and curators. Your text lives on Hive, readable from any Hive frontend; the contract tracks only the money.
- **Mint.** 25% goes to L-Share minters — lock LASSECASH, earn for as long as it stays locked; longer and bigger earns more.
- **Provide liquidity.** 25% goes to the LASSECASH:HBD pool, plus a loyalty bonus of +1% per day, capped at +90%.

Era 1 emits **9,132 LASSECASH a day** in total. The pool's share is **~2,283 a day**, split among whoever provides liquidity.

## The first month is a price, not price discovery

I opened the pool with **10,000 LASSECASH and 5.21 HBD** — the same ratio as the old Hive-Engine pool on migration day. That is deliberately small: the opening *ratio* is what matters, and arbitrage keeps any depth honest.

From day one the pool is live and every trade is real. But the tokens arrive only as people claim them, most of the staked half sits in 30-day mints, and the pool starts thin. With ~2,283 LASSECASH a day landing on a pool this size, the APR you see in the first days will look absurd — four digits. It is real, and it is exactly why it will not stay that way: it falls with every provider who joins.

So: what you see in September is the price of a market that is still filling up. **Real price discovery begins after day 30**, when the migration mints mature and the liquid supply is actually out there. Be cautious with what you read into the early numbers — up or down. Judge it in October.

## The owner key — and exactly when it dies

The owner key is destroyed at block **110,664,118** (≈ day 40), after the migration mints have matured and the first full monthly Proof-of-Brain payout has settled. Until then the key can do exactly one thing: propose a code update. It cannot touch anyone's tokens. Every proposed update is visible on-chain for 48 hours before it can activate — query `findPendingContractUpdates` for contract `vsc1Be4TTjUiHgzhHAfqFn6s3PDAExH2X59fXV` at `https://api.vsc.eco/api/v1/graphql` — and can be cancelled inside that window. After block 110,664,118 no update can ever be proposed by anyone, including me. The burn transaction id will be published here.

For 40 days you are not trusting me; you are watching me, with two days' notice on anything I propose.

## Use this chain at your own risk

New code on a new chain. Every entrypoint has been run on mainnet with a real wallet; the economics survived 500,000 randomised simulated economies with a full supply audit after every operation; the whole mint lifecycle has been time-travelled from day one to day 1,185. That is not a guarantee. Do not put in more than you are willing to lose — true of this chain and of every other one.

If a defect can be fixed in code, it is fixed through the timelocked update and state is preserved. If it cannot, a redeploy restores positions as they stood at the moment of the fault, not at the snapshot — nobody is rolled back. And withdrawing liquidity never depends on the reward machinery: your LASSECASH and HBD in the pool are yours to take out at any time. There is no refund promise. Where I can make someone whole for a mistake of mine, I will.

## Hive-Engine LASSECASH is dead

The old token still exists because nothing on a blockchain can be deleted. It is worthless. The Hive-Engine team has already removed it from trading on hive-engine.com and tribaldex.com, and the old Outpost site is gone — my thanks to them for seven years and a clean ending. Do not buy it anywhere, do not send it; only the snapshot counts.

## Where to go

- Claim: https://lassecash.com (front page)
- Verify your snapshot entry: https://lassecash.com/check
- Everything else: https://lassecash.com/about
- The music: https://lassemusic.com

Seven years of my word. From today, code.

— Lasse
