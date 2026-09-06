# Unanswered Hive replies to @lassecashmagi — triage and drafts, 6 Sep 2026

Twelve replies to the claim-outreach comments, none answered. Five ask a real
question, seven only need a vote or a one-word thanks.

**These are drafts for Lasse to send, not comments to post automatically.**
Hive comments are permanent, public and in his name, and half of these are
support answers where a wrong one costs somebody money or a payout window.
His own point, made the same evening: AI-shaped text is now something people
notice and dislike. Auto-answering his own community with it, at volume, is
the version of that mistake that actually costs trust. Drafted in his voice,
sent by him.

## Needs a real answer (5)

### @imfarhad — a genuine bug report, and the most important one
> "I tried to do my first post on lassecash.com. **I got the following error -
> The chain refused this: cost limit exceeded.** I cannot see the post on
> lassecash.com, but I can see it on peakd, ecency etc."

His post exists on Hive and is NOT registered on LasseCash, so it is earning
nothing and the window never opened. Cause: `post` sizes its RC limit from a
dry run, but the limit is also capped at what the account actually holds, and
he has no HBD on MAGI — the node returns no RC record for `hive:imfarhad` at
all. So his ceiling is the free 10,000, and a post that had to settle a day of
accrual inside the same call blew through it.

> your post is fine on hive, it just never got registered on lassecash... that
> error means the call ran out of RC halfway through.
>
> on magi there are no fees, RC is the only cost, and a post normally fits the
> free 10.000 easily. but if the contract has to settle a day of rewards inside
> your call it gets a lot more expensive and stops there.
>
> two things fix it... try posting again a bit later, someone elses transaction
> usually clears the backlog first. or put 1-2 HBD on magi. that HBD is not
> spent, it IS your RC meter, and you can withdraw it whenever you want.
>
> sorry about that, its the roughest edge in the whole thing right now.

### @silvertop — same root cause, and he asks for the post himself
> "Still trying to figure out how everything works, looks like I am low on RC,
> maybe another post explain this better in detail!"

Confirmed: 3,362 RC available of 11,547 max when checked. He holds about 1.5
HBD on MAGI. He is right, and he is asking for the fix.

> you are right, and you are not the only one hitting it.
>
> the part nobody has explained properly: on magi there are no fees at all, RC
> is the cost of everything, and your RC meter is simply your HBD balance on
> magi plus a free 10.000. so a couple of HBD parked there and you never think
> about it again... and its not spent, you can take it back out any time.
>
> yours was low when I looked, it refills by itself over about 5 days.
>
> and yes I will write that post, you are right that it needs one :)

### @offgridlife
> "Am I earning again? Can I earn with #lassecash tag on my Hive posts?"

> yes and yes :)
>
> the #lassecash tag works from any hive frontend, peakd, ecency, whatever...
> it shows up on lassecash.com and it earns. the only condition is that you
> hold enough L-Shares, thats the single filter, no other rules.

### @erica005 and @bokica80 — the same general question
> "How does it work?" / "can you explain little better about that blockchain"

> short version... lassecash moved off hive-engine onto magi, which is a smart
> contract layer running on hive. same token, same 51 million cap, but now the
> posting rewards, the staking and the LASSECASH:HBD pool all live in one
> contract that nobody can change after october, including me.
>
> the whole thing is written up here: https://lassecash.com/about
>
> and if you held lassecash before, you can claim it at https://lassecash.com

## Needs nothing but a vote (7)

@andy4475 · @gungunkrishu · @imfarhad (the second one, "I have claimed my
share") · @barski · @tydynrain · @fredkese · @beelshops

All are thanks or confirmations. A vote is a better answer than a comment.

## The finding worth more than the twelve replies

**Two of the five real questions are the same problem, and it is the one
CLAUDE.md already calls "the wall every new LP walks into."** imfarhad could
not post; silvertop cannot act and does not know why. Neither of them did
anything wrong, and neither could have guessed that a token with no fees
requires a small HBD balance in order to be usable at all.

silvertop asked for the post directly. That post is worth more than answering
these twelve one at a time, and it is the cheapest trust win available right
now: no fees, RC is the meter, the meter is your HBD balance plus a free
allowance, the HBD is never spent and can be withdrawn. Say the word and I
will draft it.

Links checked 6 Sep: `lassecash.com` 200, `lassecash.com/about` redirects to
`/about/short` and resolves 200.
