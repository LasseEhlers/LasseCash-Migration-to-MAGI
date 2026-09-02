# MAGI's cross-chain pools and the HBD bridge

Everything here was **read off the chain**, not from documentation — MAGI
publishes no client helper for any of it. Verified 2026-09-01 against
confirmed transactions, including @lasseehlers' own.

## The pool contract (HBD / HIVE / BTC)

| | |
|---|---|
| Contract | `vsc1Brvi4YZHLkocYNAFd7Gf1JpsPjzNnv4i45` |
| Action | `execute` |
| Frontend | Altera — https://altera.magi.eco/swap |

Payload is **JSON** (not our pipe format) and amounts are **milli-units**
(`"100000"` = 100.000), unlike our own 1e8 base units:

```json
{"type":"swap","version":"1.0.0","asset_in":"HBD","asset_out":"BTC",
 "amount_in":"4000","min_amount_out":"270","recipient":"hive:alice"}
```

With the matching intent, exactly the shape `AiohaSigner` already builds for
our own HBD-drawing calls:

```json
[{"type":"transfer.allow","args":{"token":"hbd","limit":"4.000"}}]
```

Liquidity uses the same action: `{"type":"deposit","version":"1.0.0",
"asset0":"hbd","asset1":"hive","amount0":"13","amount1":"297","recipient":…}`.
Observed pairs: HBD↔HIVE, HIVE↔BTC, HBD↔BTC. Asset strings are UPPERCASE in
a swap payload and lowercase in intents — copy the case exactly.

### If we build a swap panel

It is **a frontend feature**, not a new risk surface: the swap executes on
their contract whether the button is on Altera or on lassecash.com, and we
never hold the funds. The failure mode of a changed interface is a REFUSED
call — a broken button and a little wasted RC — not a loss.

Two things keep it that way, and neither is optional:

1. **Always send a real `min_amount_out`**, computed from their live reserves
   the way `minOut` already works on our pool. It is the only thing standing
   between a user and a bad fill if anything ever changes meaning.
2. **Label whose pool it is, and whose fee.** Their pools charge one; ours
   does not. Presenting theirs as if it were ours is the one genuinely
   misleading thing we could do here.

The payload carries `"version":"1.0.0"`, which suggests changes would arrive
as 2.0.0 rather than silently. Worth asking TibFox whether that is a promise
before depending on it.

## The HBD bridge

- **Deposit**: an ordinary Hive transfer to `vsc.gateway` with the memo
  `to=<hive username>`. THE MEMO IS THE ADDRESS — a wrong one is a transfer
  to a stranger with no refund path, so build it from the signed-in account
  and never from typed input.
- **Withdraw**: `aioha.vscWithdraw(to, amount, Asset.HBD)` — supported, no
  memo to get wrong.
- A deposit spends the **Hive L1** balance and a withdrawal spends the
  **MAGI** one. They are the same asset in two places, which is exactly why
  the wallet page shows both.

### What secures it — NOT trustless

`vsc.gateway`'s owner and active authority is an **18-key multisig with a
6,667 / 10,000 threshold** — a two-thirds supermajority; the largest single
key is 2,444 (24%). Recovery account `vaultec`.

So MAGI's HBD is real HBD custodied on Hive by a validator set. No individual
can move it — not MAGI's developers, not us — but two-thirds of that weight
could, and no contract prevents it. Say "validator-secured custody", never
"trustless".

**BTC on MAGI is MAPPED** (the SDK has `unmap`): real Bitcoin held off-chain
by a mechanism we have NOT verified. Do not publish a claim about it.

## The trust ranking, as the Wallet page states it

1. **LASSECASH:HBD** — ours; no owner key from 10 Oct; LASSECASH is native to
   the contract so nobody custodies it; HBD side crosses the bridge.
2. **HBD:HIVE** — MAGI's contract, which keeps an owner; both sides bridged.
3. **BTC:HBD** — that, plus unverified BTC custody.

## `@aioha/magi` (v0.0.7) — what it does and does not give you

`call`, `transfer`, `stake`, `unstake`, `unmap`, `signAndBroadcastTx`.
Assets: `hive | hbd | hbd_savings`. **No swap helper and no pool method** —
which is why the interface above had to be read from transactions. The
absence of a convenience method is not the absence of an interface; do not
conclude "impossible" from an SDK's method list again.


## Off-chain indexer — `vsc-eco/magi-mongo-indexer` (TibFox, 2026-09-01)

> "the data is read from an off-chain indexer where all contract logs are
> parsed and stored to reconstruct chain state"
> — https://github.com/vsc-eco/magi-mongo-indexer

Answered the BTC-balance question a day after we had already solved it by
reading `vsc-eco/utxo-mapping` (balances live at `a-<qualified account>` in the
mapping contract, see above). **Recorded for the other thing it answers.**

The Chart page replays every pool call from genesis on each load and the Stats
page walks the whole transaction log. Both are correct and both are O(all
history) — fine at 66 transactions, not at 100,000. The LasseCash Markets track
(CLAUDE.md) needs exactly this: every trade indexed, never sampled, candles
derived from it, a CMC/CoinGecko-shaped API on top.

So when that gets built, the first question is whether to run this rather than
write another one. It is MAGI's own, it parses contract logs generically, and
the alternative is maintaining a second implementation of the same walk.

Not urgent: it is off-chain, has no deadline, and nothing about the key burn
touches it.
