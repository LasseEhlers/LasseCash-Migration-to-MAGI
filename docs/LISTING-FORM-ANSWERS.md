# Listing-form answer sheet — CoinPaprika, LiveCoinWatch (then CoinGecko, CMC)

Every answer a listing form asks for, in one place, so filling a form is
pasting. Figures marked LIVE change every block — read them from the URL
beside them at the moment you paste, never from this file. Everything else is
fixed and was verified on 2026-09-06.

**Order of operations on the two sites that let a project self-submit:**
1. Submit the **exchange** first — our pool is a DEX, and a coin with no
   listed market is refused on sight. The exchange application wants the API
   endpoints and the pair; that is the section "The exchange" below.
2. Once the exchange is accepted (they email), submit the **coin**, naming
   that exchange as its market.
3. Expect "we'll monitor it" rather than a same-week listing. Acceptance is
   volume and liquidity, never payment. Nobody pays anyone, ever.

CoinGecko and CoinMarketCap are NOT self-serve for a market they do not
track: they need MAGI recognised as a chain first (the vsc-eco issue,
`docs/MAGI-INDEXER-ISSUE-DRAFT.md`) and CMC wants sixty days of trading —
that is 30 October. Same answers apply when the day comes.

---

## The coin

| Field | Answer |
|---|---|
| Name | LasseCash |
| Ticker / symbol | LASSECASH |
| Decimals | 8 |
| Blockchain / platform | MAGI (Virtual Smart Chain, VSC) — a smart-contract L2 anchored to Hive; every transaction is a Hive L1 `custom_json`, 3-second blocks |
| Token type | Contract-managed token (balances live in the contract's state). Not ERC-20, not a native MAGI asset |
| Contract address | `vsc1Be4TTjUiHgzhHAfqFn6s3PDAExH2X59fXV` |
| Contract owner | `hive:lassecashmagi` — **the key burns on 10 October 2026**; from then the contract is immutable, nobody can update it |
| Consensus | Hive proof-of-stake witnesses (L1) + MAGI validator set (L2) |
| Launch date | 31 August 2026 on MAGI (genesis Hive block 109,512,118). The token itself dates from 2019 on Steem-Engine, then Hive-Engine — the MAGI contract is the migration of that supply |
| Website | https://lassecash.com |
| Whitepaper / docs | https://lassecash.com/about (the canonical document; also https://lassecash.com/about.md) |
| Source code | https://github.com/LasseEhlers/LasseCash-Migration-to-MAGI (engine, contract, indexer, this API — all open) |
| Explorer | **https://vsc.techcoderx.com/contract/vsc1Be4TTjUiHgzhHAfqFn6s3PDAExH2X59fXV** (techcoderx's MAGI explorer — contract page, transactions, per-address history; found by Lasse 2026-09-06). Secondary: https://lassecash.com/chain (supply, pools, consensus group, pending code updates — read live from the node), and for raw verification the node's GraphQL at https://api.vsc.eco/api/v1/graphql, e.g. `{ getStateByKeys(contractId:"vsc1Be4TTjUiHgzhHAfqFn6s3PDAExH2X59fXV", keys:["amm_lc","amm_hbd","sup_migrated","sup_emitted"]) }` |
| Logo | https://lassecash.com/logo/lassecash-512.png (also -256, -200; vector https://lassecash.com/logo/lassecash-mark.svg; local files in `brand/logo/`) |
| Max supply | 51,000,000 LASSECASH — hard cap, enforced in the contract, cannot be changed |
| Total supply | LIVE → https://lassecash.com/api/supply/total (27,763,864.24 on 2026-09-06; grows with emission, see below) |
| Circulating supply | LIVE → https://lassecash.com/api/supply/circulating (9,074,953.52 on 2026-09-06). This is the URL forms ask for — it returns a bare number |
| Supply JSON | https://lassecash.com/api/supply |
| Locked / team addresses | **`hive:null` only.** Industry standard (CMC methodology, copied by the rest): circulating excludes only what CANNOT trade — burned, vesting-locked, foundation treasury. A founder's own unrestricted wallet circulates (Bitcoin counts Satoshi's coins; Ethereum counts Vitalik's) and staked tokens circulate (all of ETH's staked supply does). So `hive:lasseehlers` is NOT listed, and `/api/supply/circulating` = total − hive:null is already the standard figure — every site shows the same number. Decided 2026-09-06 |
| Burned | 18,688,910.73 held by `hive:null` (no keys exist for it — provably unspendable, visible forever). Counted inside total, outside circulating |
| Emission | 20,000,000 over 75 years: 10,000,000 in the first 3-year era, halving every 3 years (era 1: 3.17097910 per 30-second MAGI block ≈ 3,333,333/year). Split 50% Proof-of-Brain (creators + curators), 25% L-Share yield (minters), 25% liquidity providers |
| Premine / ICO | None. No ICO, no presale, no VC. Supply migrated 1:1 from Hive-Engine holders who claimed within the window; everything unclaimed by inactive holders was burned to `hive:null` |
| Categories / tags | DeFi · Social / Content · Proof-of-Brain · Staking · Hive ecosystem · AMM |
| Short description (≤ 300 chars) | LasseCash is an immutable social-DeFi token on MAGI, the smart-contract L2 of Hive. Holders mint L-Shares for yield and voting power, creators and curators earn from a 50% Proof-of-Brain slice, and liquidity providers earn 25% of emission on the zero-fee LASSECASH:HBD pool. |
| Long description | See "Long description" below |
| Founder / team | Lasse Ehlers (solo founder), Copenhagen, Denmark. Hive: @lasseehlers |
| Contact e-mail | ehlers.lasse@gmail.com |
| Discord | https://discord.gg/wNhQrG44DC |
| YouTube | https://www.youtube.com/@LasseCashNews |
| Hive (blog / social) | https://peakd.com/@lasseehlers · tag `lassecash` |
| GitHub | https://github.com/LasseEhlers |
| Twitter / Telegram / Reddit | none — leave blank; do not invent |
| Audit | No third-party audit. Open source; the money paths are fuzzed (500,000 randomised economies, every operation audited for supply conservation, zero failures) and every entrypoint was exercised on mainnet test deployments before launch |
| Fees | Zero swap fee (hardcoded, not governable). MAGI has no transaction fees; actions cost resource credits (RC), which regenerate |
| Wallets | Hive Keychain, PeakVault, HiveAuth, HiveSigner (via Aioha) — any Hive wallet |

### Long description

LasseCash launched in 2019 as a Steem-Engine / Hive-Engine tribe token and
migrated to MAGI, Hive's smart-contract L2, on 31 August 2026. The MAGI
contract is the whole economy in one place: a 51,000,000 hard cap, a
20,000,000 emission schedule that halves every three years and ends in year
75, and three ways to earn from every block — 50% to creators and curators
(Proof-of-Brain), 25% to holders who mint L-Shares by locking LASSECASH for
up to three years, and 25% to liquidity providers on the contract's own
zero-fee LASSECASH:HBD pool. Governance is a top-ten of L-Share holders who
can move a handful of thresholds inside fixed bounds and nothing else. The
owner key is burned on 10 October 2026, after which the contract can never be
changed by anyone. Everything is open source, and every figure the site shows
is read from the chain.

---

## The exchange (submit this FIRST)

| Field | Answer |
|---|---|
| Exchange name | LasseCash Pool |
| Type | Decentralised (DEX) — on-chain automated market maker, constant product (x·y=k), inside the LasseCash contract |
| Blockchain | MAGI (Virtual Smart Chain), Hive L2 |
| Contract | `vsc1Be4TTjUiHgzhHAfqFn6s3PDAExH2X59fXV` |
| Website / trading URL | https://lassecash.com/pool |
| Launch date | 31 August 2026 |
| Country | Denmark |
| Fees | Maker 0% / Taker 0% — no swap fee, hardcoded. LPs are paid from emission, not fees |
| Pairs | 1: LASSECASH/HBD (`ticker_id` `LASSECASH_HBD`). HBD = Hive Backed Dollar, CMC UCID 5375 |
| Custody | Non-custodial. HBD is held by the contract on MAGI; LASSECASH is the contract's own ledger. Users sign with their own Hive keys |
| KYC | None |
| Fiat | None |
| API — CoinGecko format | https://lassecash.com/api/market/pairs · https://lassecash.com/api/market/tickers · https://lassecash.com/api/market/orderbook?ticker_id=LASSECASH_HBD · https://lassecash.com/api/market/historical_trades?ticker_id=LASSECASH_HBD |
| API — CoinMarketCap format | https://lassecash.com/api/cmc/summary · https://lassecash.com/api/cmc/assets · https://lassecash.com/api/cmc/ticker · https://lassecash.com/api/cmc/orderbook/LASSECASH_HBD · https://lassecash.com/api/cmc/trades/LASSECASH_HBD |
| API notes | Public, no key, CORS open, one snapshot per minute. Prices are HBD per LASSECASH, 8 decimals. The order book is one marginal level with the reserves as size (an AMM has no resting orders). `reconciled` on the ticker is true when the trade replay matches the live reserves to the base unit |
| Liquidity | LIVE → `liquidity_in_hbd` on https://lassecash.com/api/market/tickers (63.27 HBD on 2026-09-06 — it is small; say so, they will see it anyway) |
| 24h volume | LIVE → `target_volume` on the same URL (13.00 HBD on 2026-09-06) |
| Contact | ehlers.lasse@gmail.com · https://discord.gg/wNhQrG44DC |

---

## Where to submit

| Site | Form | Notes |
|---|---|---|
| LiveCoinWatch — exchange | https://www.livecoinwatch.com/requests/exchange | Free. Do this one first of all |
| LiveCoinWatch — coin | https://www.livecoinwatch.com/requests/coin | Free; they say ~72 h. Name "LasseCash Pool" as the market |
| CoinPaprika | https://coinpaprika.com/add/ → Add a new project → **Normal Track** (free, ~1 month) | **Exchange: pay-walled** — "Normal track unavailable for New Exchanges", Fast Track only ($1,000–2,000). Refused 2026-09-06; do not pay, do not retry. Asset: pick **Coin**, not Token — the Token path auto-validates the contract address on chains they support and a `vsc1…` address fails it |
| CoinGecko | Self-serve "Partners Platform": log in on coingecko.com → Request & Listing → New Request. Directory of forms: https://support.coingecko.com/hc/en-us/articles/23960919544345-Support-Directory-CoinGecko-Request-Forms · new-chain request (this is the MAGI ask): https://support.coingecko.com/hc/en-us/articles/53285925784345-How-to-Request-a-New-Chain-Listing-Asset-Platform | Coin must trade on an exchange CoinGecko already tracks → exchange/chain first. Free "Regular Pass"; ignore Fast Pass |
| CoinMarketCap | https://coinmarketcap.com/request/ → "[New Listing] Add exchange", then "[New Listing] Add cryptoasset" (direct: https://support.coinmarketcap.com/hc/en-us/requests/new?ticket_form_id=360000493112) | Not before 30 October 2026 (60-day rule). UCID for HBD is 5375. CMC says the form is the ONLY route — anyone offering a paid "listing service" is lying |

CoinPaprika and both LiveCoinWatch forms answered 200 on 2026-09-06; the
CoinGecko and CoinMarketCap help-centre pages refuse scripted fetches (403)
but open normally in a browser. If one 404s later, the site's footer
"Request form" / "Request a coin" link is the same page. Record the ticket
numbers you get back in this file under a "Submitted" heading, with the date.

---

## Submitted

| Date | Site | What | Reference |
|---|---|---|---|
| 2026-09-06 10:19 CPH | LiveCoinWatch | exchange request — URL https://lassecash.com/pool (the form is a single URL field) | "Request received!" — no ticket number issued |
| 2026-09-06 10:28 CPH | LiveCoinWatch | coin request — full form (supply APIs, explorer, logo, notes), locked address hive:null only | "Success!" — no ticket number; they quote ~72 h |
