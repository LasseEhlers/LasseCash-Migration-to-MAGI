# Draft: the Magi Discord follow-up to TibFox — send AFTER activation

**Do not send until the update has activated and the checks pass** (Tue 8 Sep
21:23 CPH). If anything fails, there is nothing to announce. The whole force of
this message is that it reports a finished thing.

**Where:** Magi Discord `#general`, as a reply on the same thread. Not a DM —
he made the criticism in public, so the correction belongs in public.

**Why it is shaped like this.** He said two things: the standards exist so
nobody writes custom logic, and they will not add custom logic to their general
indexers. Both are now moot for the token, because the token is literally their
contract. So the message makes ONE ask, not a list — one clear ask gets
actioned, three get deferred.

---

## The facts behind every claim (check before sending)

| Claim | Evidence |
|---|---|
| It is their contract, unmodified | `vsc-eco/magi_token-contract` @ `ee21119c5dde15f0422962fdf6f0f1e27c8baff0`, working tree clean, zero source changes |
| The binary deployed is that source | built sha256 `c6ac5e4d…41423` = `contract/artifacts/magi-token.wasm` = the deployed code CID `bafkreiggvrp…auem` |
| Token id | `vsc1BUDsVccMPGycTmpc98WsQYSKyTBsZqFq4h` |
| Core id | `vsc1Be4TTjUiHgzhHAfqFn6s3PDAExH2X59fXV` |
| The core owns the token | `changeOwner` -> `contract:vsc1Be4TTj…`; @lassecashmagi is then refused with "Must be owner to mint" |
| Discovery is automatic | the binary carries the `init_magi_token` event; their indexer scans all contract logs for it (`internal/config/events/magi_token_mappings.yaml`) — no allowlist, no request |

⚠️ Do NOT claim their indexer has already listed it. That has not been
observed. The message asks him to check, which is honest and gives him
something easy to say yes to.

---

## The message

Written in Lasse's own register, not in clean prose. That is deliberate — see
"Why it reads rough" below. Every identifier inside it is exact and was
re-verified against the chain on 6 Sep.

> ok its live... LASSECASH is a standard magi_token now.
>
> and I didnt write my own, I deployed yours... vsc-eco/magi_token-contract at
> ee21119, no changes.
>
> token: `vsc1BUDsVccMPGycTmpc98WsQYSKyTBsZqFq4h`
> core: `vsc1Be4TTjUiHgzhHAfqFn6s3PDAExH2X59fXV`
>
> the core owns the token so balances move with the normal transfer /
> transferFrom... nothing custom left for anybody to write :)
>
> init emits init_magi_token so your indexer should pick it up by itself. if it
> doesnt show, tell me whats wrong on my end and I fix it.
>
> the one thing I cant do myself is register_token on the router, thats owner
> only on your side... the flag you mentioned for btc to lassecash. no rush.
> happy to do whatever part is mine.
>
> you were right by the way... took a day to fix. thanks for saying it straight
> instead of being polite.

## Why it reads rough

An earlier version of this draft was clean prose — balanced clauses, full
punctuation, no ellipses. It was replaced, because pasting that into a channel
where Lasse has posted in fragments for a year is the giveaway, not the fix.

**The tell is not polish, it is a change of register.** Nobody notices a rough
message from someone who always writes roughly. People notice when a person who
writes in bursts suddenly produces three balanced paragraphs. Keep the voice
constant and let the care vary with the context: a GitHub issue is tighter than
a Discord line because that is what everyone does, and that is not suspicious.

**But the roughness stops at the facts.** Loose sentences, exact identifiers. A
contract id with one character wrong reads as careless about the engineering,
which is the precise impression this message exists to undo. The two contract
ids and the commit hash above were each re-queried before this was written.

**Do not manufacture errors.** Leaving natural roughness alone is free.
Inserting mistakes overshoots, and deliberately sloppy writing next to a precise
technical claim reads worse than either would alone.

## What is deliberately NOT in it

- **No mention of `register_pool`.** The pool is still ours, inside the core
  contract, and a native pool beside it would split the liquidity. That is a
  real decision, not an ask to bury in a paragraph about something else. Raise
  it separately if he says yes to the token.
- **No test-evidence list.** He does not want a report, and volunteering the
  fuzz numbers reads as pleading. Deploying his own contract unmodified makes
  the point without a single adjective.
- **No re-apology.** One line at the top closes it. Repeating it invites him to
  re-litigate the original criticism.
- **No deadline.** The key burn is our constraint, not his. Attaching urgency
  to a favour is how favours get declined.

---

## 9 Sep — reply to "you deploy the pool contract and we whitelist it"

He was right, and it is the better model: the pool is ours, on their code;
they only register. Reply (no rush — he said he'd come back tomorrow):

**SUPERSEDED the same night — the pool is deployed, so the reply carries the
id instead of a promise.** Send (Lasse's voice, one message):

> You were right, I read the dex-contracts repo: one router, one pool
> contract per pair, deployed by whoever wants the pair. So it's done — your
> `dex` contract, unmodified, deployed and initialised for LASSECASH/HBD:
>
> pool: `vsc1BrBFAwZ3Mr8L4ijRqT9RPEPvhK9FWDaYSr`
> token (mapping contract, magi_token): `vsc1BUDsVccMPGycTmpc98WsQYSKyTBsZqFq4h`
> router set to `vsc1Brvi4YZHLkocYNAFd7Gf1JpsPjzNnv4i45`, fee 8 bps, get_pool reads hbd/lassecash.
>
> Whenever the team is ready:
> register_token `{"name":"LASSECASH","chain":"MAGI","mapping_contract":"vsc1BUDsVccMPGycTmpc98WsQYSKyTBsZqFq4h","decimals":8,"description":"LasseCash"}`
> register_pool `{"asset0":"LASSECASH","asset1":"HBD","dex_contract_id":"vsc1BrBFAwZ3Mr8L4ijRqT9RPEPvhK9FWDaYSr"}`
>
> It's already seeded: 27,000 LASSECASH + 9.905 HBD, same price as our core pool, so nothing waits on me. No hurry. Thanks Tibby.

(Original draft, before the deploy:)

> You're right, I read the dex-contracts repo: one router, one pool contract
> per pair, deployed by whoever wants the pair. So I'll deploy your `dex`
> contract for LASSECASH/HBD, init it with the token as the mapping contract
> (it answers transferFrom/transfer, so no adapter needed) and the router id,
> seed it, and send you the pool id. Then it's just register_token +
> register_pool on your side whenever the team is ready. Thanks Tibby.
