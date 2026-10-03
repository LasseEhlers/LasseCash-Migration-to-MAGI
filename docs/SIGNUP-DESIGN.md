# Hive account signup, paid on MAGI — design research

Status: **PARKED 2026-10-03 (Lasse's call).** Too few users to justify it; /start
links to signup.hive.io, which works. Revisit when people report being
stuck at account creation, or when onboarding someone with only BTC is
wanted. Nothing deployed, nothing spent. Every fact
below marked VERIFIED was measured against mainnet with read-only calls.

## The question

Can a newcomer get a Hive account, paid in HIVE / HBD / BTC / LASSECASH on
MAGI, without us collecting personal data and **without a spending key sitting
on a server**?

## Verified facts

| Fact | How |
|---|---|
| `account_creation_fee` = 3.000 HIVE, witness-set, read live | `get_chain_properties` |
| The fee is not lost: it becomes the new account's own Hive Power | `hive_evaluator_account.cpp` `create_vesting(new_account, fee)` |
| The contract SDK has **no** Hive-operation primitive (`hive.*` is balance / draw / transfer / withdraw only) | `contract/sdk/sdk_stub.go` |
| The SDK **does** expose TSS: `tss.create_key(id, "ecdsa"\|"eddsa")`, `tss_v2.create_key(id, algo, epochs)`, `tss_v2.renew_key`, `tss.sign_key(id, digestHex)`, `tss.get_key` | same file |
| `Env.BlockId` is the **Hive L1 block id** for on-chain calls — the contract can build Hive TaPoS (`ref_block_num`, `ref_block_prefix`) itself | docs.magi.eco/references/sdk |
| A completed signature is public: `getTssRequests(keyId, msgHex) → {status: complete\|unsigned, sig}` | node GraphQL introspection |
| Epoch ≈ 7,300 heights ≈ **6 hours** (epoch 2100 @ 110,427,455 → 2101 @ 110,434,754) | `getElection` |
| Max key life 365 epochs ≈ **91 days** — must be renewed | SDK comment + `getTssKey` |
| Hive's signature rule is **BIP-62 low-S only**: high-S → `is_canonical(c): signature is not canonical`; low-S with a high-bit r passes. So ANY ECDSA signature can be made acceptable by normalising s → n−s and flipping the recovery id | `condenser_api.verify_authority` with throwaway-key signatures, 2026-10-03 |
| Only one TSS key is visibly in use on mainnet: `vsc1BdrQ…-main` (`btc_mainnet_mapping`, owner `hive:vsc.dao`), status **`deprecated`**, `expiry_epoch` 2102; 18 of its last 50 commitments are `blame` (failed reshare rounds) | `getTssKey`, `findTssCommitments` |

## Design A — contract-held key (preferred, if TSS is open to user contracts)

```
payer ──order(name|owner|active|posting|memo pubkeys) + payment intents──► signup contract
                                                                        │ builds account_create tx,
                                                                        │ sha256(chain_id‖tx)
                                                                        └─► tss.sign_key(digest)
anyone (the payer's own browser) ◄── getTssRequests ──┘
   normalise low-S, pick recid against the known pubkey, broadcast to Hive
```

- **`lassecashsignup` on Hive**: active authority = the contract's TSS public
  key; **owner authority = a cold key Lasse holds** (recovery only: if the TSS
  key ever lapses, owner sets a new active). No posting key needed.
- **The contract only ever asks to sign transactions it built itself**:
  `account_create` (creator `lassecashsignup`, fee read from a param, keys
  from the payer) plus, in the same transaction, `transfer_to_vesting` of the
  surplus to the new account. A relayer supplies nothing that is signed, so
  it can delay a signup, never redirect one.
- **No server.** The payer's browser polls for the signature and broadcasts.
  A relayer Worker is optional convenience.
- Expiration = block timestamp + ≤1 h. If it lapses unbroadcast, the order may
  be re-signed with fresh TaPoS. A double creation is impossible: the second
  transaction fails on the taken name and spends nothing.
- Key renewal piggybacks on every `order` call (`TssRenewKey`), plus a
  permissionless `renew`.
- This is a **dApp contract** owned by `hive:lassecashdapps`, never the core.
  The residual trust is that owner's 48 h timelocked code update — it could in
  principle ship code that signs a drain of `lassecashsignup`. Bounded by
  keeping that account's HIVE balance at one or two fees, and visible 48 h
  ahead. Strictly better than a hot key on a server, which has no timelock.

### Payment rails

| Pay in | Route to the 3+ HIVE on L1 |
|---|---|
| HIVE | intent → `HiveWithdraw` to `lassecashsignup` |
| HBD | swap HBD→HIVE on a MAGI pool (does the DEX router have one? **open**) → withdraw |
| BTC | mapping contract → HBD → HIVE (router) |
| LASSECASH | core pool → HBD → HIVE |

Open: how long a `HiveWithdraw` takes to land on L1 — the signature must not
be broadcast before the HIVE is there (it would just fail; retryable).

## Design B — fallback, small service with a hot key

A Worker holds `lassecashsignup`'s active key, watches the contract's paid
orders and creates accounts. Simple, but it is the hot key we want to avoid.
Use only if TSS is closed to user contracts or unreliable.

## Questions for TibFox (decide A vs B)

1. May any user contract call `tss.create_key` / `tss.sign_key` on mainnet, or
   is TSS reserved for DAO mapping contracts?
2. Why is the BTC mapping key `deprecated` with `expiry_epoch` 2102, and do
   reshares/rotations ever change a key's **public key**? (If yes, Design A
   breaks every rotation.)
3. Typical latency from `sign_key` to `complete`? (Must be well under 1 h.)
4. RC/gas cost of `create_key` and `sign_key`.
5. Is there a HIVE:HBD pool on the DEX router, and how long does
   `HiveWithdraw` take to reach L1?

## Free next steps (no HBD, no RC)

1. Go serializer for `account_create` + `transfer_to_vesting`, unit-tested
   byte-for-byte against dhive's serializer and digest.
2. `verify_authority` on a full account_create from a throwaway key → must fail
   only with "Missing Active Authority lassecashsignup" (proves the bytes).
3. Ask TibFox the five questions.

Costs money, only on Lasse's yes and not before ~20 Oct: one throwaway dApp
deploy to measure TSS; one real creation (~3 HIVE) as the final proof.

## Who can pay, who can log in — answered 2026-10-03

- **Pay:** HIVE and HBD are native (proven). BTC is mapped by
  `btc_mainnet_mapping`; a BTC:HBD and an HBD:HIVE pool exist on MAGI and a
  BTC sell already ran through our Wallet page — but a user contract
  RECEIVING BTC directly is untested. LASSECASH is ours. Every route to the
  3 HIVE fee exists today through the pools.
- **Log in without Hive:** MAGI accounts are Hive, Ethereum wallets
  (`did:pkh:…`, self-custodial only) and ed25519 DIDs. **Not Bitcoin
  wallets.** lassecash.com has Hive sign-in only; a MetaMask sign-in is
  separate work. A MetaMask-only user could hold, swap and mint but not post
  or vote (content is on Hive) — which is exactly the person this signup is for.
- **Unknown:** do `did:pkh` accounts get the 10,000 free credits? Ask TibFox
  with the TSS questions.
