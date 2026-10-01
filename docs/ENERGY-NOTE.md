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

### The arithmetic, with the assumptions visible

| | nodes | W each (assumed) | kW |
|---|---|---|---|
| Hive witnesses + backups | 21 × 2 | 15–150, say 50 | 2.1 |
| MAGI witnesses | 17 | 30–150, say 60 | 1.0 |
| **consensus total** | | | **≈ 3.1 kW** |

3.1 kW continuous ≈ **27,000 kWh per year** for *both chains together* —
and that is the whole of Hive and the whole of MAGI, shared by every app,
token and contract on them, not LasseCash alone.

A Danish household without electric heating uses roughly **4,000 kWh a year**.
So the consensus layer under LasseCash is **about seven households**, and
LasseCash's own share of it is a fraction of one.

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

- **API and HAF nodes.** The heavy servers that let apps read the chain —
  one documented example runs a Ryzen 9 with 128 GB RAM. They are
  infrastructure for every Hive app, they are not consensus, and counting them
  against LasseCash alone would be dishonest. They would exist without us.
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

| | Hive (21 witnesses) | MAGI (17 witnesses) | total | households |
|---|---|---|---|---|
| **Low** — thin clients, no backups, 12 W / 25 W | 0.25 kW | 0.43 kW | **0.7 kW** ≈ 6,000 kWh/yr | **~1.5** |
| **Midpoint** — mixed estate, backups on Hive | 2.1 kW | 1.0 kW | **3.1 kW** ≈ 27,000 kWh/yr | **~7** |
| **High** — every node a rack server at 150 W, Hive doubled for backups | 6.3 kW | 2.6 kW | **8.9 kW** ≈ 78,000 kWh/yr | **~19** |

So: **"somewhere between two and twenty ordinary households power the consensus
of both chains, and every application on them."** Even the pessimistic end is
four million times smaller than Bitcoin, which makes the argument robust to
being wrong about the hardware by an order of magnitude.

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
