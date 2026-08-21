package state

import (
	"strings"

	"github.com/lassecash/engine"
)

// Governance: the bounded parameter registry and the top-10 consensus group.
//
// THE LEADERBOARD PROBLEM
//
// engine.ConsensusGroup ranks holders to find the top 10, but the contract
// cannot enumerate accounts — that is unbounded iteration and would blow the
// gas budget (see CLAUDE.md). There is no "all accounts" key and there must
// never be one.
//
// So the top 10 is maintained INCREMENTALLY as a stored leaderboard:
//
//   - When an account's L-Shares rise, it is offered to the board: O(10).
//   - When they fall, its entry is updated in place if it is on the board.
//   - Anyone may call Promote to offer any account for a seat.
//
// The consequence, stated plainly: after a large holder ends a mint, the board
// can be momentarily stale — an account that now deserves a seat does not hold
// one until someone offers it. That is why Promote is permissionless and
// costs only RC. Nobody can be wrongly INCLUDED (every entry is re-read from
// live share state before use), only wrongly excluded, and any observer with an
// interest can fix an exclusion in one transaction.
//
// The alternative — scanning every holder on every vote — is not affordable at
// any account count worth having.

const keyBoard = "gov_board"

// BoardSize is how many accounts the leaderboard tracks. It holds more than
// ConsensusSize so that a demotion has a replacement ready without a scan.
const BoardSize = 20

// board is the stored leaderboard, most shares first.
func board(s Store) []string {
	raw := get(s, keyBoard)
	if raw == nil {
		return nil
	}
	return strings.Split(*raw, sep)
}

func putBoard(s Store, accounts []string) {
	if len(accounts) > BoardSize {
		accounts = accounts[:BoardSize]
	}
	s.Set(keyBoard, strings.Join(accounts, sep))
}

// Promote offers an account for a leaderboard seat.
//
// Permissionless by design: the board can only ever wrongly EXCLUDE, and anyone
// noticing an exclusion can correct it. Shares are read live, so a caller
// cannot promote an account that does not deserve it.
func Promote(s Store, account string) Result {
	if account == "" {
		return fail("no account")
	}
	if SharesOf(s, account) <= 0 {
		return fail("account holds no L-Shares")
	}
	offer(s, account)
	return ok("promoted")
}

// offer inserts or repositions an account on the leaderboard. O(BoardSize).
func offer(s Store, account string) {
	cur := board(s)
	shares := SharesOf(s, account)

	// Cheap exits first — gas is charged to the caller, and offer() runs on
	// EVERY share change. Measured on the devnet (2026-08-21): the board
	// rewrite on every mint was a large slice of a migration batch's cost.
	onBoard := false
	for _, a := range cur {
		if a == account {
			onBoard = true
			break
		}
	}
	if shares <= 0 {
		if !onBoard {
			return // nothing to remove, nothing to write
		}
	} else if !onBoard && len(cur) >= BoardSize &&
		!betterSeat(s, account, shares, cur[len(cur)-1]) {
		return // full board and this account does not beat the last seat
	}

	// Drop any existing entry so repositioning cannot duplicate it.
	next := make([]string, 0, len(cur)+1)
	for _, a := range cur {
		if a != account {
			next = append(next, a)
		}
	}
	if shares <= 0 {
		putBoard(s, next)
		return
	}

	inserted := false
	out := make([]string, 0, len(next)+1)
	for _, a := range next {
		if !inserted && betterSeat(s, account, shares, a) {
			out = append(out, account)
			inserted = true
		}
		out = append(out, a)
	}
	if !inserted {
		out = append(out, account)
	}
	if len(out) > BoardSize {
		out = out[:BoardSize]
	}
	if sameBoard(cur, out) {
		return // no change: do not pay for a write
	}
	putBoard(s, out)
}

func sameBoard(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// betterSeat reports whether `account` (holding `shares`) outranks `other`.
// Ties break by account name so every node orders the board identically.
func betterSeat(s Store, account string, shares engine.Shares, other string) bool {
	o := SharesOf(s, other)
	if shares != o {
		return shares > o
	}
	return account < other
}

// ConsensusMembers returns the current top-10 consensus group.
//
// Share counts are re-read live from state, so a stale board entry whose holder
// has since sold cannot retain influence — engine.ConsensusGroup re-ranks and
// drops zero-share accounts.
func ConsensusMembers(s Store) []engine.Member {
	accounts := board(s)
	holders := make([]engine.Holder, 0, len(accounts))
	for _, a := range accounts {
		holders = append(holders, engine.Holder{Account: a, Shares: SharesOf(s, a)})
	}
	return engine.ConsensusGroup(holders)
}

// --- parameters -----------------------------------------------------------

// Registry returns the genesis parameter registry: defaults and, crucially,
// the hardcoded Min/Max bounds. Bounds are compiled in and no vote can move
// them; only a timelocked contract update could, and that is public before it
// activates.
func Registry() *engine.Registry { return engine.NewRegistry() }

// preferences reads the standing preferences of the current consensus members
// for one parameter. O(ConsensusSize) reads.
func preferences(s Store, members []engine.Member, key engine.ParamKey) engine.Preferences {
	prefs := engine.Preferences{}
	for _, m := range members {
		v := get(s, govKey(string(key), m.Account))
		if v == nil {
			continue
		}
		prefs[m.Account] = decI64(*v)
	}
	return prefs
}

// EffectiveParam returns the value currently in force for a parameter: the
// median of the standing preferences of the top 10.
//
// There are no proposals and no voting rounds. Each member keeps a preferred
// value, changeable at any time, and the median is simply what applies. An
// extreme vote is self-neutralising; the bounds cap the damage even if one
// entity holds every seat.
func EffectiveParam(s Store, key engine.ParamKey) int64 {
	reg := Registry()
	p, found := reg.Param(key)
	if !found {
		return 0
	}
	members := ConsensusMembers(s)
	return engine.EffectiveValue(p, members, preferences(s, members, key))
}

// SetPreference records a consensus member's standing preference.
//
// Refused for non-members and for values outside the parameter's bounds, so a
// member sees the error immediately rather than having their vote silently
// clamped to something they did not choose.
func SetPreference(s Store, ctx Ctx, key string, value int64) Result {
	reg := Registry()
	pk := engine.ParamKey(key)
	p, found := reg.Param(pk)
	if !found {
		return fail("unknown parameter")
	}
	if !p.InBounds(value) {
		return fail("value outside bounds [" + encI64(p.Min) + "," + encI64(p.Max) + "]")
	}
	members := ConsensusMembers(s)
	if !engine.IsMember(members, ctx.Sender) {
		return fail("not a consensus member")
	}
	s.Set(govKey(key, ctx.Sender), encI64(value))
	return ok("preference recorded")
}
