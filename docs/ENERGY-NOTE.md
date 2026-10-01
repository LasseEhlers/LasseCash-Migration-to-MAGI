# What LasseCash actually costs the planet — a working estimate

**Status: draft for refinement, not for publication.** Every figure below is
either sourced or an explicitly stated assumption. The old About page claimed
LasseCash "uses the resources of a modern household, compared to Bitcoin that
uses a country like Sweden or Malaysia". This checks whether that still holds
in 2026, now that LasseCash runs on MAGI over Hive rather than on Hive-Engine.

## The claim it is compared against

| | annual electricity | source |
|---|---|---|
| Bitcoin | **138.2 TWh** (live estimate, July 2026); theoretical range **74–242 TWh** | Cambridge CBECI |
| Sweden, whole country | **~140 TWh** | national grid figures |

So "Bitcoin uses about what Sweden uses" is, in 2026, almost exactly right —
the two numbers are within a couple of percent of each other. That half of the
old claim needs no softening.

## What LasseCash runs on

Three layers, and only the first two consume meaningful power:

1. **Hive L1 consensus** — 21 witnesses produce every block. A witness needs a
   consensus node; most also run a backup. Hive's own docs put the build
   requirement at 16 GB RAM, Linux only, and a witness has publicly documented
   running one on a **Dell OptiPlex 3000 thin client with a Pentium Silver and
   8 GB RAM** — a machine that draws on the order of 10–15 W.
2. **MAGI consensus** — **17 witnesses** in the election current on 2026-09-30
   (read from the chain: `electionByBlockHeight`, epoch 2049). A node runs
   go-vsc-node plus MongoDB: heavier than a thin client, lighter than an API
   server.
3. **LasseCash itself** — one WASM contract. Its marginal cost is the CPU time
   to execute a call, plus the bytes it writes. The frontend is static files on
   Cloudflare's edge; there is no LasseCash server anywhere.

### The arithmetic, in two honest tiers

A witness is not one machine. Lasse's point, and it is the right one: most run
a block producer AND a backup, publish a **price feed** (part of the job — the
HBD rate comes from witnesses), often run **seed nodes** for the P2P layer, and
several run public **API/HAF servers**, which are genuinely large — one
documented Hive API node is a Ryzen 9 7950X3D with 128 GB of RAM. Counting only
the block producer would be lowballing, and a lowball is what a critic looks
for first.

So count it in two tiers and say which is which.

**Tier 1 — what the chains need in order to exist at all.**

| | nodes | W each (assumed) | kW |
|---|---|---|---|
| Hive block producers + backups | 21 × 2 | 15–150, say 50 | 2.1 |
| Hive seed nodes | ~20 | 30 | 0.6 |
| MAGI witnesses (**17, read from the chain**) | 17 | 30–150, say 60 | 1.0 |
| **consensus and network** | | | **≈ 3.7 kW** |

**Tier 2 — what makes them usable: the public API and HAF servers.**

| | nodes | W each (assumed) | kW |
|---|---|---|---|
| Hive public API / HAF | ~15 | 150–400, say 250 | 3.8 |
| MAGI public API | ~4 | 100 | 0.4 |
| **application infrastructure** | | | **≈ 4.2 kW** |

**Both tiers together: ~7.9 kW ≈ 69,000 kWh a year ≈ 17 Danish households**
— and that is the ENTIRE Hive network, the entire MAGI network, and every app,
token, game and frontend running on either.

Tier 2 belongs in the honest number but not in LasseCash's share: those servers
exist for the whole ecosystem and would run identically if LasseCash had never
been deployed. Tier 1 is the same — 38 validators produce blocks whether we
exist or not.

**LasseCash's own marginal cost is Tier 3: the CPU cycles to execute its
calls**, and nothing else. No LasseCash server exists anywhere; the frontend is
static files on Cloudflare's edge.

### The per-call figure, which is the striking one

Contract calls are metered in gas, and gas is WASM cycles — measured on this
contract: a transfer 28M, a mint ~245M, a full post ~205M. At the order of
10⁹–10¹⁰ simple operations per second on a core drawing 5–15 W, a LasseCash
transaction costs **single-digit joules** — a LED bulb for a second or two.

Bitcoin, at 138.2 TWh across roughly 150 million transactions a year, averages
**~900 kWh per transaction ≈ 3.3 gigajoules**.

⚠️ **Do not lead with that ratio.** Per-transaction comparisons are weak for
both sides: Bitcoin's energy secures the chain and would be spent whether or
not anyone transacted, and ours is dwarfed by the fixed cost of the validators.
It is a vivid number, not an honest headline.

## The argument that actually matters: what happens as it grows

This is the real difference, and it survives any quibble about watts.

- **Bitcoin's consumption rises with its price.** Mining is a competition for a
  fixed reward; the more valuable the reward, the more hardware is pointed at
  it, until the marginal miner breaks even. Success *causes* consumption.
- **Hive and MAGI consumption is fixed by the validator count.** 21 Hive
  witnesses and 17 MAGI witnesses produce blocks whether the chain carries ten
  transactions a day or ten million. Ten thousand new LasseCash users would add
  the CPU time to execute their calls — joules each — and not one new machine.

So the honest headline is not "LasseCash is cheaper than Bitcoin". It is:
**LasseCash's energy cost does not grow with its success, and Bitcoin's is
designed to.**

## What this estimate deliberately does NOT count

Stating these is what makes the rest trustworthy:

- **Tier 2 is counted in the ecosystem total but NOT attributed to LasseCash.**
  Those API and HAF servers are infrastructure for every Hive app and would run
  identically without us. Including them in the headline number is honest;
  charging them to LasseCash would not be.
- **The reader's own device.** A phone rendering the site uses more power than
  the chain spends settling what it shows.
- **Cloudflare's edge**, which serves the frontend from capacity that exists
  regardless.
- **Witness power draw is assumed, not measured.** The 15–150 W range is the
  weakest number here. Anyone who wants to attack the estimate should attack
  this, and the right answer is to ask witnesses what their nodes actually draw.

## Publishing it WITHOUT asking anyone — the method that fits reality

Lasse has no working line to Hive's core witnesses; years of messages have gone
unanswered, and chasing them is not a plan. So the estimate must stand on
PUBLIC evidence, and the post itself becomes the request for correction. That
is the stronger move anyway: a direct message asking for a favour is easy to
ignore, while a published number about someone's own machine is the kind of
thing people correct — and if nobody does, the figure stands on the record.

### A bounded range beats a point estimate

Publish both ends rather than one number nobody can verify. Then the only way
to attack it is to supply a real measurement, which is exactly the outcome
worth having.

| | tier 1 | tier 2 | total | households |
|---|---|---|---|---|
| **Low** — thin clients, lean API estate | 0.9 kW | 1.5 kW | **2.4 kW** ≈ 21,000 kWh/yr | **~5** |
| **Midpoint** — mixed estate | 3.7 kW | 4.2 kW | **7.9 kW** ≈ 69,000 kWh/yr | **~17** |
| **High** — every node a rack server | 9.0 kW | 9.0 kW | **18 kW** ≈ 158,000 kWh/yr | **~39** |

So: **"somewhere between five and forty ordinary households power both chains
AND every application on them."** Even the pessimistic end is roughly a
million times smaller than Bitcoin, which makes the argument robust to being
wrong about the hardware by an order of magnitude in either direction. That
robustness is worth more than a flattering point estimate.

### Public evidence that needs no one's permission

- A Hive witness's own published write-up of running consensus on a **Dell
  OptiPlex 3000 thin client, Pentium Silver, 8 GB RAM** — a documented low end.
- Hive's developer portal: 16 GB RAM to build, Linux only — a documented
  minimum.
- `gtg`'s long-running "Steem Pressure" series, which documents node operation
  in public and is the ancestor of the Raspberry Pi estimate Lasse remembers.
- CPU model TDPs are published by Intel and AMD: a Pentium Silver is ~10 W, a
  Ryzen 9 7950X3D ~120 W. Hardware named in public posts converts to watts
  without asking anybody.
- **The MAGI validator count is readable from the chain itself**
  (`electionByBlockHeight`), so that half of the estimate is not an assumption
  at all — it was 17 on 2026-09-30, epoch 2049.

### Close the post with the invitation

One line, in Lasse's voice, something like: *"If you run a witness on either
chain and these numbers are wrong, tell me what your node actually draws and I
will correct this and credit you."* That is a contribution to Hive and MAGI
rather than an advert, it costs nothing to be wrong in public about an
assumption you labelled as one, and it gives witnesses a reason to engage that
a private message never did.

Re-read the CBECI figure on publication day — it moves with hashrate.

Only after the post survives contact with critics is it worth putting on the
About page.
