package engine

// No imports. `sort.Slice` would pull `reflect` into the WASM contract, which
// costs binary size and gas for no benefit — every collection sorted here is at
// most ConsensusSize entries or a handful of parameter keys.

// Governance: the bounded parameter registry and the top-10 consensus group.
//
// THE CENTRAL IDEA: parameters are DATA, not code.
//
// A naive design hardcodes each tunable as a struct field, which means every
// new dApp fee requires a contract rewrite. Instead, parameters live in a
// registry keyed by string. Adding a parameter for a future dApp is a state
// write, not a redeploy — which is what makes [REDACTED]/[REDACTED] fees
// injectable later without touching the migration contract.
//
// THE SAFETY PROPERTY: every parameter carries hardcoded Min/Max bounds. The
// top-10 may move a value inside its bounds and can NEVER leave them. A fee
// bounded [0.1%, 1%] cannot become 50%, no matter who controls consensus.
// Bounds are compiled in; only values are governable.
//
// WHAT IS NOT HERE, DELIBERATELY: the 51M hardcap, the 20M emission cap, the
// halving curve, the 1.5x multiplier ceilings, the 3-year maximum, the 7%
// ratchet, and the 50/25/25 split. Those are immutable constants with no
// governance path at all. See CLAUDE.md.

// ParamKey identifies a governable parameter.
type ParamKey string

const (
	// ParamVolumeStart / ParamVolumeEnd bound the Bigger-Pays-Better ramp.
	// Defaults 1,000 and 50,000 LC (revised 2026-08-22 — see NewRegistry).
	ParamVolumeStart ParamKey = "mint.volume_start"
	ParamVolumeEnd   ParamKey = "mint.volume_end"

	// Minimum L-Shares required to unlock posting, per content window.
	ParamPostThresholdViral ParamKey = "post.threshold_viral"
	ParamPostThresholdDeep  ParamKey = "post.threshold_deep"
	// ParamPostThresholdComment gates COMMENTS: a reply registered with the
	// contract earns like a viral post but needs only this (lower) stake.
	ParamPostThresholdComment ParamKey = "post.threshold_comment"
	// ParamPromoteMinBurn is the smallest burn that buys a promoted slot.
	ParamPromoteMinBurn ParamKey = "promote.min_burn"

	// NOTE: there is deliberately no swap-fee parameter. The LASSECASH:HBD
	// swap fee is hardcoded to zero and is not governable at all — see the
	// swap-fee note in pool.go.
)

// Param is one governable value with its immutable bounds.
type Param struct {
	Key   ParamKey
	Value int64
	// Min and Max are hardcoded at registration and can never be changed by
	// governance — only by a contract update, which is timelocked and public.
	Min int64
	Max int64
	// Desc is shown in the governance UI.
	Desc string
}

// InBounds reports whether v is a legal value for this parameter.
func (p Param) InBounds(v int64) bool { return v >= p.Min && v <= p.Max }

// Registry holds all governable parameters.
type Registry struct {
	params map[ParamKey]Param
}

// NewRegistry returns the genesis parameter set.
//
// To add a parameter for a future dApp, register it here (or via a timelocked
// contract update) with bounds chosen so that no consensus vote can make it
// dangerous. Existing parameters are never removed — a key that has been used
// must keep its meaning forever.
func NewRegistry() *Registry {
	r := &Registry{params: map[ParamKey]Param{}}
	// Bigger-Pays-Better defaults REVISED 2026-08-22: 10,000 -> 1,000 start,
	// 100,000 -> 50,000 end.
	//
	// Measured against the actual post-migration set (262 accounts, C6): at
	// 10,000 / 100,000 only 40 accounts would ever see any volume bonus and
	// only 13 could reach the 1.50x ceiling. 201 of 241 holders — 83% — could
	// never touch the mechanic at all, and 164 of them hold under 1,000 LC.
	// A bonus that most of the community can never reach is not an incentive,
	// it is concentration with extra steps.
	//
	// These are DEFAULTS, not bounds. The bounds below are frozen with the
	// contract; the top-10 median can move the values inside them forever.
	r.register(Param{
		Key: ParamVolumeStart, Value: int64(LC(1_000)),
		Min: int64(LC(100)), Max: int64(LC(50_000)),
		Desc: "Bigger Pays Better: amount below which no volume bonus applies",
	})
	r.register(Param{
		Key: ParamVolumeEnd, Value: int64(LC(50_000)),
		Min: int64(LC(1_000)), Max: int64(LC(5_000_000)),
		Desc: "Bigger Pays Better: amount at which the full 1.5x bonus applies",
	})
	// Defaults are Lasse's (2026-08-21): 1,000 to go viral, 10,000 for deep.
	// The top-10 tune from there, inside these bounds.
	//
	// BOUNDS DECIDED 2026-08-21 (Lasse; frozen forever with the contract).
	//
	// Denominated in L-SHARES — the unit of commitment — because a price-
	// denominated threshold would need an on-chain oracle, and the only one
	// available (our own pool) is thin and manipulable. The top-10 IS the
	// oracle: ten humans with the most stake, each keeping a standing number,
	// median in force, tracking the real-world price at human speed.
	//
	// The CEILING is the anti-capture rule. The top-10 hold the most shares by
	// definition; without a ceiling six colluding seats could set the deep
	// threshold above everyone's holdings but their own and farm the 37.5% of
	// emission that deep posting pays — capture, which would pay a cartel more
	// than the price damage costs it. At the ceiling (~$100 of stake at the
	// opening price) a captured committee can at worst squeeze deep posting
	// to ~20 accounts: painful, visible, and reversible. Never exclusive.
	//
	// The FLOOR is one L-Share: near-zero at any plausible price, so nobody is
	// ever locked out, but never exactly zero, so protection cannot be
	// switched off. Newcomers earn L-Shares by posting viral and grow into
	// deep — the ladder is built in. The ranges span three orders of
	// magnitude each, enough to track a 100x price move in either direction.
	r.register(Param{
		Key: ParamPostThresholdViral, Value: int64(1_000 * ShareUnit),
		Min: ShareUnit, Max: int64(10_000 * ShareUnit),
		Desc: "L-Shares required to post viral (7-day) content",
	})
	r.register(Param{
		Key: ParamPostThresholdDeep, Value: int64(10_000 * ShareUnit),
		Min: ShareUnit, Max: int64(100_000 * ShareUnit),
		Desc: "L-Shares required to post deep (30-day) content",
	})
	// Comments — DECIDED 2026-08-22. Lasse: a separate, lower threshold so
	// the conversation is open to anyone with ~10 cents of stake while tip
	// bots and "nice post!" never appear on LasseCash: a comment is shown
	// here only if its author holds this much, and it can earn (viral
	// economics, 7 days) only if registered — which the threshold gates.
	// Comments written below the threshold still exist on Hive; they are
	// simply not part of LasseCash. Bounds ≈ $0.001 … $10 at opening price.
	r.register(Param{
		Key: ParamPostThresholdComment, Value: int64(100 * ShareUnit),
		Min: ShareUnit, Max: int64(10_000 * ShareUnit),
		Desc: "L-Shares required to comment (7-day viral economics)",
	})
	// Promote-by-burn — DECIDED 2026-08-22. Steem's version died in a dead
	// "Promoted" tab where 0.00001 bought a position. Here a burn (to null,
	// visible forever) buys a clearly labelled slot every Nth row of the
	// SAME trending list, ordered by burn, never above the voted posts; the
	// slot rule lives in the frontend. The floor kills dust promotions; the
	// ceiling on the MINIMUM stops a captured top-10 from abolishing
	// promotion for everyone but themselves (at most a ~$10 burn). Promotion closes at 75% of the
	// post's window (engine.PromoteCutoff) — no burning for nothing.
	r.register(Param{
		Key: ParamPromoteMinBurn, Value: int64(100 * Unit),
		Min: Unit, Max: int64(10_000 * Unit),
		Desc: "minimum LASSECASH burn to promote a post",
	})
	return r
}

func (r *Registry) register(p Param) {
	r.params[p.Key] = p
}

// Get returns a parameter's current value.
func (r *Registry) Get(k ParamKey) (int64, bool) {
	p, ok := r.params[k]
	if !ok {
		return 0, false
	}
	return p.Value, true
}

// MustGet returns a value, or the zero value if unregistered. For call sites
// where an unknown key is a programming error rather than a runtime condition.
func (r *Registry) MustGet(k ParamKey) int64 {
	v, _ := r.Get(k)
	return v
}

// Param returns the full definition including bounds.
func (r *Registry) Param(k ParamKey) (Param, bool) {
	p, ok := r.params[k]
	return p, ok
}

// Keys returns all registered keys in deterministic order. Contract state must
// never depend on Go map iteration order.
func (r *Registry) Keys() []ParamKey {
	out := make([]ParamKey, 0, len(r.params))
	for k := range r.params {
		out = append(out, k)
	}
	// Insertion sort: the registry holds a handful of keys, and this avoids
	// dragging reflect into the contract via sort.Slice.
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j] < out[j-1]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// Set applies a governance decision.
//
// Rejects unknown keys and out-of-bounds values. Callers must have already
// verified that the decision carries sufficient consensus weight.
//
// A change here affects FUTURE mints only. Existing mints captured their
// parameters at creation and are frozen — governance can never retroactively
// dilute an existing minter.
func (r *Registry) Set(k ParamKey, v int64) bool {
	p, ok := r.params[k]
	if !ok || !p.InBounds(v) {
		return false
	}
	p.Value = v
	r.params[k] = p
	return true
}

// MintParamsAt builds the MintParams to freeze into a new mint.
func (r *Registry) MintParamsAt(genesisHeight, height uint64) MintParams {
	return MintParams{
		VolumeStart: Amount(r.MustGet(ParamVolumeStart)),
		VolumeEnd:   Amount(r.MustGet(ParamVolumeEnd)),
		ShareRate:   ShareRate(genesisHeight, height),
	}
}

// --- consensus group ------------------------------------------------------

// ConsensusSize is the number of accounts in the governing group.
const ConsensusSize = 10

// Holder is an account's L-Share balance, for ranking.
type Holder struct {
	Account string
	Shares  Shares
}

// Member is a seat in the consensus group.
//
// NOTE: there is no voting WEIGHT here, deliberately. Governance is by median
// of standing preferences, and each of the ten seats contributes exactly one
// number to that median. Holding more L-Shares wins you a seat; it does not
// make your number count more once you are in.
//
// This is why there is no whale-weight cap: there is no weight to cap.
type Member struct {
	Account string
	Shares  Shares
}

// betterThan reports whether a outranks b: more shares first, then lower
// account name. Ties MUST break deterministically or two validators could
// compute different consensus groups from identical state.
func betterThan(a, b Holder) bool {
	if a.Shares != b.Shares {
		return a.Shares > b.Shares
	}
	return a.Account < b.Account
}

// ConsensusGroup returns the top-10 L-Share holders.
//
// This is a PARTIAL SELECTION, not a sort. Sorting every holder would be
// O(n log n) over potentially every account on the chain (11,236 today) and
// would pull `reflect` into the contract via sort.Slice. Selecting the top 10
// by insertion into a fixed 10-slot window is O(n * 10), allocation-free after
// the initial slice, and uses no reflection — which matters because WASM gas is
// charged against the caller's RC.
func ConsensusGroup(holders []Holder) []Member {
	var top [ConsensusSize]Holder
	n := 0

	for _, h := range holders {
		if h.Shares <= 0 {
			continue
		}
		// Reject early if the window is full and h cannot displace the last.
		if n == ConsensusSize && !betterThan(h, top[n-1]) {
			continue
		}
		// Find the insertion point, shifting weaker entries right.
		i := n
		if i == ConsensusSize {
			i = ConsensusSize - 1 // overwrite the weakest
		} else {
			n++
		}
		for i > 0 && betterThan(h, top[i-1]) {
			top[i] = top[i-1]
			i--
		}
		top[i] = h
	}

	members := make([]Member, n)
	for i := 0; i < n; i++ {
		members[i] = Member{Account: top[i].Account, Shares: top[i].Shares}
	}
	return members
}

// IsMember reports whether an account currently holds a consensus seat.
func IsMember(members []Member, account string) bool {
	for _, m := range members {
		if m.Account == account {
			return true
		}
	}
	return false
}

// --- median governance ----------------------------------------------------
//
// There are no proposals. There is no quorum, no voting round, no funding
// request, and nothing to deliver on. Each member of the top 10 simply keeps a
// standing preferred value for each parameter, changeable at any time, and the
// MEDIAN of those preferences is the value in force.
//
// Why the median rather than an average or a majority vote:
//
//   - Extreme votes are self-neutralising. A member who wants 10,000% moves the
//     outcome no further than one who wants one notch above the median. With an
//     average, a single absurd vote would drag the result badly.
//   - There is nothing to time or manipulate. No proposal window to snipe, no
//     quorum to withhold, no round to front-run.
//   - It is continuous. The value simply IS the median at any moment; no
//     tallying job has to run, and nothing can get stuck.
//
// What the median does NOT defend against is one entity holding several of the
// ten seats. That is accepted: the hardcoded Min/Max bounds are what actually
// limit the damage. Even a group entirely controlled by one party can only move
// a value inside its bounds.

// Preferences maps account -> preferred value for a single parameter.
type Preferences map[string]int64

// EffectiveValue returns the value currently in force for a parameter: the
// median of the standing preferences held by current consensus members.
//
// Rules:
//   - Only preferences from CURRENT members count. Losing a seat drops your
//     vote immediately; no stale influence.
//   - Members with no preference set are skipped rather than counted as zero.
//   - Every preference is clamped into the parameter's bounds before the median
//     is taken, so an out-of-range value degrades to the nearest legal one
//     instead of being able to skew or spoil the result.
//   - With no preferences at all, the registered default stands.
//   - For an even count, the LOWER of the two middle values is used. This is
//     deterministic integer arithmetic with no rounding, so every node agrees.
func EffectiveValue(p Param, members []Member, prefs Preferences) int64 {
	if len(members) == 0 || len(prefs) == 0 {
		return p.Value
	}
	// At most ConsensusSize votes, so an insertion sort is both faster than
	// sort.Slice here and free of the reflect dependency it would pull into
	// the contract.
	var votes [ConsensusSize]int64
	n := 0
	for _, m := range members {
		v, ok := prefs[m.Account]
		if !ok || n == ConsensusSize {
			continue
		}
		v = clamp(v, p.Min, p.Max)
		i := n
		for i > 0 && votes[i-1] > v {
			votes[i] = votes[i-1]
			i--
		}
		votes[i] = v
		n++
	}
	if n == 0 {
		return p.Value
	}
	// Lower median: exact, integer, and identical on every node.
	return votes[(n-1)/2]
}

func clamp(v, lo, hi int64) int64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// Governance holds every member's standing preferences for every parameter.
type Governance struct {
	// prefs[key][account] = preferred value
	prefs map[ParamKey]Preferences
}

// NewGovernance returns an empty preference store.
func NewGovernance() *Governance {
	return &Governance{prefs: map[ParamKey]Preferences{}}
}

// SetPreference records a member's standing preference for a parameter.
//
// Rejects unknown parameters and non-members. Values outside the bounds are
// rejected here so the member gets immediate feedback, and clamped again at
// median time as a belt-and-braces guard.
func (g *Governance) SetPreference(r *Registry, members []Member,
	account string, k ParamKey, v int64) bool {
	p, ok := r.Param(k)
	if !ok || !p.InBounds(v) || !IsMember(members, account) {
		return false
	}
	if g.prefs[k] == nil {
		g.prefs[k] = Preferences{}
	}
	g.prefs[k][account] = v
	return true
}

// ClearPreference removes a member's preference for a parameter.
func (g *Governance) ClearPreference(account string, k ParamKey) {
	if g.prefs[k] != nil {
		delete(g.prefs[k], account)
	}
}

// Preferences returns the standing preferences for a parameter.
func (g *Governance) Preferences(k ParamKey) Preferences {
	if g.prefs[k] == nil {
		return Preferences{}
	}
	return g.prefs[k]
}

// Effective returns the value currently in force for a parameter.
func (g *Governance) Effective(r *Registry, members []Member, k ParamKey) int64 {
	p, ok := r.Param(k)
	if !ok {
		return 0
	}
	return EffectiveValue(p, members, g.Preferences(k))
}

// EffectiveMintParams builds the parameters to freeze into a new mint, using
// the currently-effective governed values.
func (g *Governance) EffectiveMintParams(r *Registry, members []Member,
	genesisHeight, height uint64) MintParams {
	return MintParams{
		VolumeStart: Amount(g.Effective(r, members, ParamVolumeStart)),
		VolumeEnd:   Amount(g.Effective(r, members, ParamVolumeEnd)),
		ShareRate:   ShareRate(genesisHeight, height),
	}
}
