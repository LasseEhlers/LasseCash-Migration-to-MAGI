# What I took, and what I fixed — where the LasseCash design comes from

DRAFT for Lasse to rewrite in his own words. Publish AFTER the post about the
float fault and the key-burn plan. No live figures (yields, prices) — rules,
dates and fixed facts only. No price promises.

---

I bought my first bitcoin in April 2013. Since then I have watched a lot of systems promise the future, and I have watched most of them break — some slowly, some in a single afternoon. I have also made my share of loud claims in posts that are still on chain and always will be. So this post does not make predictions. It explains where every rule in LasseCash comes from, what I borrowed, and what I changed because I had seen the original fail.

## Bitcoin: a cap that means something

The one idea from Bitcoin I never wanted to touch is the hard cap. Nobody can print more, and the issuance halves on a fixed schedule until it stops.

LasseCash has a hard cap of **51 million** — the same number since 2019 — and new issuance **halves every three years** until it ends, around year 75. Every division rounds down, so the chain can under-pay by a fraction of a base unit but never over-issue. That is checked against the live chain every hour, by a script anyone can read.

What Bitcoin does not answer is how rewards continue once issuance stops. Bitcoin's answer is fees, and nobody yet knows if that is enough. LasseCash answers it with **recycling**: when someone ends a mint early, lets a matured mint bleed out, or never claims, that value goes back into the reward pool. It is not new money, so it never touches the cap — and it keeps the rewards running after the last new token is issued.

## Steem and Hive: being paid to write

I joined Steem in 2016 and built the first version of LasseCash on it in 2019. Proof-of-Brain — getting paid for writing and for finding good writing — is still the best idea in the whole space, and it is the heart of LasseCash.

I also saw what went wrong, up close:

- **Downvote wars.** One large account could zero out someone else's reward, or hide their post. I have been on the receiving end. LasseCash has **no downvotes and no reputation score**. You vote for what you value, with your own stake, or you don't vote. Nobody can subtract from someone else.
- **Vote bots and the race to vote first.** Curation paid more to whoever voted earliest, so people voted on titles instead of reading. On LasseCash your curation is simply **your share of the votes** — no bonus for being first. Vote when you have actually read it.
- **Spam.** Instead of downvotes, posting needs a small stake in L-Shares. Being invested is the filter.
- **A takeover.** In 2020 Steem was bought and its community left to build Hive. Your words should never depend on one owner. On LasseCash every post is a **normal Hive post**, readable on any Hive site, now and in ten years, whether lassecash.com exists or not. The contract only tracks the money.

## HEX: commitment that pays

From HEX I took the idea that **commitment should pay** — and pay more for more of it.

- **Longer pays better**: lock for longer, get more shares, up to 1.5x.
- **Bigger pays better**: lock more, get more shares, up to 1.5x — together up to **2.25x**.
- **The share rate rises over time**, so later minters get slightly fewer shares per token than earlier ones. Being early is rewarded, openly and by a fixed rule.
- **Good Accounting**: HEX lets a matured stake be closed out cleanly. I took that too, and changed it.

What I changed:

- **Three years, not fifteen.** A fifteen-year lock does not fit a real life. Three years does, and it lines up with how people plan.
- **Good Accounting is yours alone.** On HEX anyone can trigger it on your stake. On LasseCash only the owner can — a stranger should not decide your timing. Once armed, it gives you up to three years of grace instead of 90 days.
- **Gentler at the end.** After a mint matures there are **90 days of grace** where nothing happens, so illness or a busy month costs nothing. Only then does it slowly bleed — and what bleeds goes back to the people still committed.
- **Your shares are your voice.** L-Shares are your voting weight on posts and your seat among the ten who tune the thresholds. Commitment is not just paid, it is heard.

## Seven years of LasseCash itself

The last teacher was the project. Seven years on Steem-Engine and Hive-Engine taught me things no whitepaper could:

- **Most tokens end up with people who left.** So the migration only carried over accounts that had actually done something with LasseCash in the last six months — and every account, carried over or not, is recorded permanently on chain.
- **Fees eat small trades.** So the LASSECASH:HBD pool charges **0%**, written into the contract with no setting to raise it. Liquidity providers are paid from emission instead, and paid more the longer they stay — up to 90 days.
- **Testing on the live chain finds what simulations miss.** On day 31 the first large claim found a real fault. It was fixed only because I had not yet burned the admin key — which is why the key stays until the last tests have passed. I wrote about that separately.

## Why the mint is the centre of it

Put the pieces together and the mint is where they meet. When you mint, three things happen at once:

1. **Your LASSECASH is locked** for the term you chose. Locked tokens are not for sale.
2. **You earn** a share of a fixed, published emission — and that share falls as more people mint, so the system balances itself instead of promising a rate.
3. **You get a voice**: your votes on posts, and a chance at a seat among the ten who tune the thresholds.

I am not going to tell you what that does to the price. That is the market's job, and I have learned what promises like that are worth. What I can tell you is that every mint, every claim and every result is on chain, and every finished mint has its own page with its real numbers. Look at those, not at me.

## What is left

The admin key is still there, deliberately, until the remaining tests have passed on a real chain. Then it is destroyed at a height I will announce in advance, and after that nobody can change the rules — including me. On top of the core, other apps can build their own contracts that read it, without anyone asking permission.

Thirteen years in, this is the first system I have built where I would rather show you the chain than tell you a story about it.

— Lasse
