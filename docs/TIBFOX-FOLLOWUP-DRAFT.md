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

> you were right, and it only took a day to fix, so thanks for saying it
> straight rather than being polite about it.
>
> LASSECASH is a standard magi_token as of tonight. I didn't write my own —
> I deployed yours, `vsc-eco/magi_token-contract` at `ee21119`, unmodified.
>
> token: `vsc1BUDsVccMPGycTmpc98WsQYSKyTBsZqFq4h`
> core: `vsc1Be4TTjUiHgzhHAfqFn6s3PDAExH2X59fXV` — it owns the token, so every
> balance moves through the standard `transfer` / `transferFrom`.
>
> so there's no custom logic for anyone to write on the token side. `init`
> emits `init_magi_token`, which is what your indexer discovers on. if it
> hasn't shown up, tell me what's wrong on my end and I'll fix it.
>
> the one thing I can't do myself is `register_token` on the router, since
> that's owner-only on your side. that's the flag you mentioned for btc →
> lassecash. no rush at all. happy to do whatever part of it is mine.

---

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
