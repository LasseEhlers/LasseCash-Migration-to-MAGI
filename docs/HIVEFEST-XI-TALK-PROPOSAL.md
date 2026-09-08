# HiveFest XI — talk proposal — SUBMITTED 2026-09-09 01:11 CPH

**On chain:** comment `@lasseehlers/hf26-talk-mttaa4c6-2ez` under the Call for
Talks anchor, tool metadata intact (`hf.type talk`, FRI 18 SEPT, 20 min).
Direct link: https://hivefe.st/program.html#talks18/lasseehlers/hf26-talk-mttaa4c6-2ez
Editable any time via the tool's [EDIT] button on the proposal (re-signs the
same comment). Title as submitted: "LasseCash: freezing an economy on MAGI,
then the keys go in the fire — remote (video link)". Abstract says "a pool
deployed on MAGI's DEX contracts" — deliberately NOT "listed": registration
is the MAGI team's decision and had not been made.


**Where:** the program tool at https://hivefe.st/program.html, tab "talks18".
Submit through the TOOL, not as a plain comment — only tool submissions carry
the metadata that puts a proposal in the program app and makes it votable.
It posts a reply under @hivefest.bcn26's "Call for Talks — Conference Day".

**When:** Conference day is **Friday 18 September**. HiveFest XI runs 17–20
Sept, Barcelona. Sign up any time before; the community votes proposals up and
the schedule is curated from the most-wanted.

**Field of play as of 8 Sept — only 3 proposals exist:**

| who | slot | title |
|---|---|---|
| @howo | 30 min | Core development update |
| @thebeedevs | 30 min | Future of Hive (Core) |
| @offgridlife | 5 min | Monetize your Hive.blog with Shopify and Youtube |

Two core-infrastructure talks and one affiliate-marketing talk. There is
nothing on L2, nothing on MAGI, and nothing on token economics. The gap is
wide open, and it is exactly where LasseCash sits.

⚠️ **The remote question is UNRESOLVED and must be asked first.** Nothing in
the call for talks, the workshop post or any program post mentions remote,
video, streaming or online participation — I searched all seven. Do not
propose a video-link talk as though it were on offer. Ask @hivefest or
@hivefest.bcn26 plainly whether a remote slot is possible, and submit once you
know. If remote is not supported, the proposal below still works as a talk
someone else could not give — but then it is a decision about travelling.

---

## First: the message to @roelandp

He is hands off in a specific sense — he is not curating the program, so
nobody needs to *accept* a talk; you propose and people vote. But remote
delivery is a venue and AV question, and that still has an owner. He wrote
every announcement and built the program tool, so it is his to answer.

Ask the equipment question, not the permission question. "Would you accept a
remote talk" invites a curation decision he has deliberately stepped out of,
and the honest answer would be "not my call".

> Hi Roeland — following up on what we wrote about earlier this year: I got
> LasseCash migrated to MAGI. It went live 31 August, and the admin key burns
> on 10 October, so it becomes 100% immutable — a huge step up from the
> Hive-Engine days.
>
> Quick logistics question about BCN, and it's not a program one. Is the
> conference room set up to take a remote speaker over video link, or is it
> in-person only this year? I'd like to propose a talk in the tool, but I
> don't want to put something on the board that can't be delivered if it gets
> voted up. Either answer is fine, I just need to know before I submit.
>
> — Lasse

Send it on Hive (a reply or a memo) — he voted on 2026-09-08, so he is active.

**If remote is not on offer:** do not propose it and hope. Either travel or
skip this edition. Winning a slot you cannot deliver is worse than not
proposing.

**If it is:** put "remote (video link)" in the proposal itself, so the people
voting know what they are voting for.

---

## Roeland answered — 8 Sep 23:35 by mail

> "Hi Lasse im not sure yet lets see! i think there is another remote
> submission. feel free to indicate (remote)"

So: SUBMIT, and mark it remote in the title so voters know. Field of play
re-checked 9 Sep 01:00: still the same three proposals (howo 30, thebeedevs
30, offgridlife 5) plus the opening. Tool metadata is `{hf:{day,type:"talk",
title,summary,duration}}` — title and summary are what people read.

**Submit exactly this in the tool (title / summary / 20 min):**

Title: `Freezing an economy: a real token on MAGI, then the keys go in the fire — remote (video link)`

Summary: the abstract below, plus this closing line:
`Everything is shown live from the chain, not from slides — and the room
moves the economy once, on stage.`

## The talk itself — decisions 2026-09-09 (Lasse)

- **Remote, 20 min, no slides.** One browser: the stage page (REMOVED from the
  live site 9 Sep on Lasse's request until the talk is scheduled — restore with
  `git revert <this commit>`; it lived at commit 9108917) `lassecash.com/hivefest?stage`
  (the projector view: price, every trade as a tick, "chain says / repo
  builds" CID check, owner / update queue / recovery, live countdown to
  block 110,664,118, QR codes) and the ordinary site for the actions.
- **Live actions, by Lasse as @lasseehlers via Keychain:** a mint, a vote on
  a post, a buy on lassecash.com/pool and a buy on Altera (why two pools:
  0% fee paid by emission vs MAGI's fee split), while the room trades from
  the QR codes and the ticker fills.
- **NOT on stage: `fund` and the /rewards page** — Lasse: "a kind of private
  function… I just want to show the end product." /rewards is not in the nav;
  keep it that way.
- Reproducibility verified 2026-09-09: a fresh TinyGo build from HEAD gives
  `bafkreihztepf…` = the live contract's code CID.

## The proposal

**Title:** Freezing an economy: what it takes to put a real token on MAGI and
then throw away the keys

**Requested slot:** 20 min

**Abstract:**

> LasseCash launched in 2019 as a Hive-Engine tribe with a 51M hardcap and a
> halving schedule, and I held the keys to 20M unissued tokens for seven years
> without touching one. On 31 August it migrated to MAGI as a single contract
> that holds the whole economy: the reward pools, the mints, and a zero-fee
> LASSECASH:HBD pool. On 10 October the admin key burns and none of it can
> ever be changed again, including by me.
>
> This is what that actually took, with the numbers.
>
> - Why a claim-based migration instead of pushing balances: the push model
>   needed ~8.8M resource credits and thousands of HBD parked for weeks. A
>   Merkle root and 10,000 free RC per holder replaced it.
> - Three bugs that would have been permanent. A missing key reads as an empty
>   string on MAGI, not nil, which bricked the first deploy. Slashes in state
>   keys are silently dropped. A bare username in a transfer stranded 1,030
>   tokens forever, found by an ordinary person typing a name into a box.
> - Being told publicly by a VSC dev that I had coded everything custom when
>   standards existed — and rewriting the ledger onto MAGI's own token
>   standard in a day, five weeks before the freeze.
> - What "immutable" costs you: no bug fix, no new entrypoint, no new
>   parameter, forever. What survives is a bounded parameter registry the top
>   ten L-Share holders move by median, and nothing else.
>
> Useful whether or not you care about LasseCash: it is a worked example of
> shipping a real economy on Hive's L2, and of the specific ways MAGI will
> surprise you.

---

## Why this framing

**It leads with the engineering, not the token.** A room of Hive developers
will sit through a war story about a chain surprising you; they will not sit
through a pitch. Every bullet is a thing that went wrong and what it cost.

**It states the seven years without asking for credit.** "Held the keys to 20M
and never touched them" is checkable on-chain and does the work of a much
longer paragraph about trust.

**It includes the TibFox criticism deliberately.** Being publicly told you did
it wrong, and then fixing it in a day, is a better story than never having
been criticised — and everyone in that room has read the exchange or will find
it. Owning it is stronger than omitting it.

**20 minutes, not 30.** Two 30-minute core talks are already proposed. A
tighter slot is easier to schedule and easier to vote for.

**No price talk, no day-30 pitch, no invitation to buy.** The date lands nine
days before the migration mints mature, which is interesting, but a
conference talk that trails a market event reads as promotion. Mention day 30
only if asked in the room.

## What NOT to do

Do not raise, in the proposal or on stage, that Hive never supported
LasseCash. It may be true and it is not the room's fault, an audience hears it
instantly, and it converts a strong technical talk into a grievance. The work
is enough.
