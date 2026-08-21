package engine

import (
	"fmt"
	"testing"
)

// --- bounds are the whole safety story ------------------------------------

func TestParamsRejectOutOfBounds(t *testing.T) {
	r := NewRegistry()
	p, ok := r.Param(ParamVolumeStart)
	if !ok {
		t.Fatal("volume_start not registered")
	}

	// Inside bounds: accepted.
	if !r.Set(ParamVolumeStart, int64(LC(5_000))) {
		t.Fatal("in-bounds value rejected")
	}
	if got := r.MustGet(ParamVolumeStart); got != int64(LC(5_000)) {
		t.Fatalf("value not applied: got %d", got)
	}

	// Outside bounds: refused, and the old value must survive intact.
	for _, bad := range []int64{p.Min - 1, p.Max + 1, -1, 1 << 62} {
		if r.Set(ParamVolumeStart, bad) {
			t.Fatalf("out-of-bounds value %d was ACCEPTED", bad)
		}
	}
	if got := r.MustGet(ParamVolumeStart); got != int64(LC(5_000)) {
		t.Fatalf("rejected write corrupted the value: %d", got)
	}

	// Unknown keys are refused rather than silently created.
	if r.Set(ParamKey("attacker.backdoor"), 1) {
		t.Fatal("unknown key was accepted — registry must be closed")
	}
}

// The bounds must make catastrophic settings unreachable, not merely unlikely.
func TestBoundsMakeAbuseImpossible(t *testing.T) {
	r := NewRegistry()
	// Nobody can make the volume bonus require an impossible amount, nor can
	// they set a posting threshold above the registered ceiling.
	if r.Set(ParamVolumeEnd, int64(LC(100_000_000))) {
		t.Fatal("volume_end could be set beyond the entire supply")
	}
	if r.Set(ParamPostThresholdViral, int64(LC(1_000_000_000))) {
		t.Fatal("posting threshold could be set absurdly high — would silence everyone")
	}
	// And every registered parameter must actually have sane bounds.
	for _, k := range r.Keys() {
		p, _ := r.Param(k)
		if p.Min > p.Max {
			t.Fatalf("%s: Min %d > Max %d", k, p.Min, p.Max)
		}
		if !p.InBounds(p.Value) {
			t.Fatalf("%s: default %d is outside its own bounds [%d,%d]",
				k, p.Value, p.Min, p.Max)
		}
	}
}

// Deterministic ordering: validators must agree on state.
func TestRegistryKeysAreDeterministic(t *testing.T) {
	a := NewRegistry().Keys()
	for i := 0; i < 20; i++ {
		b := NewRegistry().Keys()
		if len(a) != len(b) {
			t.Fatal("key count varies between instances")
		}
		for j := range a {
			if a[j] != b[j] {
				t.Fatalf("key order varies: %v vs %v", a, b)
			}
		}
	}
}

// --- governance must not reach backwards in time --------------------------

// The property that stops the top-10 voting themselves everyone else's weight.
func TestParamChangeDoesNotAffectExistingMints(t *testing.T) {
	r := NewRegistry()
	p := r.MintParamsAt(gen, gen)

	m, ok := NewMint("alice", LC(50_000), 1095, gen, p)
	if !ok {
		t.Fatal("mint failed")
	}
	sharesBefore := m.Shares

	// Governance moves the goalposts as unfavourably as the bounds allow.
	if !r.Set(ParamVolumeStart, int64(LC(50_000))) {
		t.Fatal("in-bounds change rejected")
	}
	if !r.Set(ParamVolumeEnd, int64(LC(5_000_000))) {
		t.Fatal("in-bounds change rejected")
	}

	if m.Shares != sharesBefore {
		t.Fatalf("existing mint was re-weighted by governance: %s -> %s",
			fmtLC(Amount(sharesBefore)), fmtLC(Amount(m.Shares)))
	}

	// A NEW mint of identical size/duration should now get fewer shares,
	// proving the change took effect going forward.
	p2 := r.MintParamsAt(gen, gen)
	m2, _ := NewMint("bob", LC(50_000), 1095, gen, p2)
	if m2.Shares >= sharesBefore {
		t.Fatalf("new mint got %s shares, expected fewer than the old %s",
			fmtLC(Amount(m2.Shares)), fmtLC(Amount(sharesBefore)))
	}
	t.Logf("same mint before change: %s shares; after: %s shares",
		fmtLC(Amount(sharesBefore)), fmtLC(Amount(m2.Shares)))
}

// --- consensus group ------------------------------------------------------

func TestConsensusGroupTakesTopTen(t *testing.T) {
	var holders []Holder
	for i := 0; i < 25; i++ {
		holders = append(holders, Holder{
			Account: fmt.Sprintf("acct%02d", i),
			Shares:  Shares(int64(25-i) * ShareUnit),
		})
	}
	g := ConsensusGroup(holders)
	if len(g) != ConsensusSize {
		t.Fatalf("group size %d, want %d", len(g), ConsensusSize)
	}
	if g[0].Account != "acct00" {
		t.Fatalf("largest holder should lead, got %s", g[0].Account)
	}
	for i := 1; i < len(g); i++ {
		if g[i].Shares > g[i-1].Shares {
			t.Fatal("group is not sorted by holding")
		}
	}
}

func TestConsensusGroupIgnoresZeroHolders(t *testing.T) {
	g := ConsensusGroup([]Holder{
		{"a", Shares(5 * ShareUnit)}, {"b", 0}, {"c", Shares(3 * ShareUnit)}, {"d", 0},
	})
	if len(g) != 2 {
		t.Fatalf("zero-share accounts must not take seats: %+v", g)
	}
}

// Ties must resolve identically on every node or consensus forks.
func TestConsensusGroupIsDeterministicOnTies(t *testing.T) {
	holders := []Holder{
		{"zeta", Shares(10 * ShareUnit)}, {"alpha", Shares(10 * ShareUnit)},
		{"mike", Shares(10 * ShareUnit)}, {"beta", Shares(10 * ShareUnit)},
	}
	first := ConsensusGroup(holders)
	// Feed the same set in a different order; the result must be identical.
	shuffled := []Holder{holders[2], holders[0], holders[3], holders[1]}
	second := ConsensusGroup(shuffled)
	for i := range first {
		if first[i].Account != second[i].Account {
			t.Fatalf("tie-break not deterministic: %v vs %v", first, second)
		}
	}
	if first[0].Account != "alpha" {
		t.Fatalf("ties should break by name, got %s first", first[0].Account)
	}
}

// --- voting ---------------------------------------------------------------

// --- median governance ----------------------------------------------------

func topTen(t *testing.T) []Member {
	t.Helper()
	var hs []Holder
	for i := 0; i < 10; i++ {
		hs = append(hs, Holder{fmt.Sprintf("m%d", i), Shares(int64(100-i) * ShareUnit)})
	}
	return ConsensusGroup(hs)
}

// The headline property: the median is the value in force, with no proposal,
// no quorum, and no tallying step.
func TestMedianIsTheEffectiveValue(t *testing.T) {
	r := NewRegistry()
	g := NewGovernance()
	members := topTen(t)

	// Lasse's worked example: fees spread across the legal range.
	want := []int64{1, 2, 4, 5, 2, 3, 8, 9, 6, 7} // tenths of a percent
	for i, v := range want {
		if !g.SetPreference(r, members, fmt.Sprintf("m%d", i),
			ParamPostThresholdViral, v*ShareUnit) {
			t.Fatalf("m%d could not set preference", i)
		}
	}
	got := g.Effective(r, members, ParamPostThresholdViral)
	// sorted: 1 2 2 3 4 | 5 6 7 8 9  -> lower median = 4
	if got != 4*ShareUnit {
		t.Fatalf("median = %d, want %d", got/ShareUnit, 4)
	}
}

// Why the median and not the mean: one absurd vote must not move the outcome.
func TestExtremeVoteCannotSkewMedian(t *testing.T) {
	r := NewRegistry()
	g := NewGovernance()
	members := topTen(t)
	p, _ := r.Param(ParamPostThresholdViral)

	for i := 0; i < 10; i++ {
		g.SetPreference(r, members, fmt.Sprintf("m%d", i), ParamPostThresholdViral, 100*ShareUnit)
	}
	baseline := g.Effective(r, members, ParamPostThresholdViral)

	// The largest holder swings to the legal maximum.
	g.SetPreference(r, members, "m0", ParamPostThresholdViral, p.Max)
	after := g.Effective(r, members, ParamPostThresholdViral)

	if after != baseline {
		t.Fatalf("one extreme vote moved the median %d -> %d; median must resist it",
			baseline/ShareUnit, after/ShareUnit)
	}

	// Even a MAJORITY of one entity's seats can only drag it inside bounds.
	for i := 0; i < 6; i++ {
		g.SetPreference(r, members, fmt.Sprintf("m%d", i), ParamPostThresholdViral, p.Max)
	}
	captured := g.Effective(r, members, ParamPostThresholdViral)
	if captured < p.Min || captured > p.Max {
		t.Fatalf("captured governance escaped bounds: %d not in [%d,%d]",
			captured, p.Min, p.Max)
	}
	t.Logf("6 of 10 seats captured -> value %d, still inside bounds [%d,%d]",
		captured/ShareUnit, p.Min/ShareUnit, p.Max/ShareUnit)
}

// Bounds are the real protection, so out-of-range votes must never take effect.
func TestPreferencesAreBounded(t *testing.T) {
	r := NewRegistry()
	g := NewGovernance()
	members := topTen(t)
	p, _ := r.Param(ParamVolumeStart)

	if g.SetPreference(r, members, "m0", ParamVolumeStart, p.Max+1) {
		t.Fatal("out-of-bounds preference accepted")
	}
	if g.SetPreference(r, members, "m0", ParamVolumeStart, p.Min-1) {
		t.Fatal("below-minimum preference accepted")
	}
	if g.SetPreference(r, members, "m0", ParamKey("unknown.key"), 5) {
		t.Fatal("preference on unknown parameter accepted")
	}
	// Even if a rogue value reached storage, the median must clamp it.
	raw := Preferences{"m0": p.Max * 1000, "m1": p.Min, "m2": p.Value}
	got := EffectiveValue(p, members, raw)
	if got < p.Min || got > p.Max {
		t.Fatalf("median produced out-of-bounds value %d", got)
	}
}

// Only sitting members govern. Losing a seat must drop your vote at once.
func TestOnlyMembersGovern(t *testing.T) {
	r := NewRegistry()
	g := NewGovernance()
	members := topTen(t)

	if g.SetPreference(r, members, "outsider", ParamPostThresholdViral, 5*ShareUnit) {
		t.Fatal("a non-member set a preference")
	}

	for i := 0; i < 10; i++ {
		g.SetPreference(r, members, fmt.Sprintf("m%d", i), ParamPostThresholdViral,
			int64(i+1)*ShareUnit)
	}
	before := g.Effective(r, members, ParamPostThresholdViral)

	// m0 and m1 are ejected from the group; their votes must stop counting.
	smaller := members[2:]
	after := g.Effective(r, smaller, ParamPostThresholdViral)
	if after == before {
		t.Fatal("ejected members still influenced the outcome")
	}
	t.Logf("median %d with 10 seats -> %d after two ejections",
		before/ShareUnit, after/ShareUnit)
}

func TestUnsetPreferencesAreSkippedNotZero(t *testing.T) {
	r := NewRegistry()
	g := NewGovernance()
	members := topTen(t)

	// Only three members express a preference; the rest are silent.
	g.SetPreference(r, members, "m0", ParamPostThresholdViral, 10*ShareUnit)
	g.SetPreference(r, members, "m1", ParamPostThresholdViral, 20*ShareUnit)
	g.SetPreference(r, members, "m2", ParamPostThresholdViral, 30*ShareUnit)

	got := g.Effective(r, members, ParamPostThresholdViral)
	if got != 20*ShareUnit {
		t.Fatalf("median of 3 votes = %d, want 20 (silent members must be "+
			"skipped, not counted as zero)", got/ShareUnit)
	}

	// With nobody voting at all, the registered default must stand.
	empty := NewGovernance()
	def, _ := r.Get(ParamPostThresholdViral)
	if got := empty.Effective(r, members, ParamPostThresholdViral); got != def {
		t.Fatalf("no votes: got %d, want registered default %d", got, def)
	}
}

// Every node must compute the same value from the same state.
func TestMedianIsDeterministic(t *testing.T) {
	r := NewRegistry()
	members := topTen(t)
	p, _ := r.Param(ParamPostThresholdViral)
	prefs := Preferences{}
	for i := 0; i < 10; i++ {
		prefs[fmt.Sprintf("m%d", i)] = int64((i*7)%10+1) * ShareUnit
	}
	first := EffectiveValue(p, members, prefs)
	for i := 0; i < 50; i++ {
		if got := EffectiveValue(p, members, prefs); got != first {
			t.Fatalf("median varied between calls: %d vs %d", first, got)
		}
	}
}

// The posting-threshold bounds are frozen with the contract. Decided by Lasse
// 2026-08-21 — viral $0.01–$10 and deep $0.10–$100 at the opening price of
// 0.001 HBD, with a one-share floor so protection can never be switched
// off and a ceiling so a captured top-10 can squeeze but never exclude.
func TestPostingThresholdBoundsArePinned(t *testing.T) {
	reg := NewRegistry()
	cases := []struct {
		key                   ParamKey
		min, def, max         int64
	}{
		{ParamPostThresholdViral, ShareUnit, 1_000 * ShareUnit, 10_000 * ShareUnit},
		{ParamPostThresholdDeep, ShareUnit, 10_000 * ShareUnit, 100_000 * ShareUnit},
		{ParamPostThresholdComment, ShareUnit, 100 * ShareUnit, 10_000 * ShareUnit},
	}
	for _, c := range cases {
		p, ok := reg.Param(c.key)
		if !ok {
			t.Fatalf("%s not registered", c.key)
		}
		if p.Min != c.min || p.Value != c.def || p.Max != c.max {
			t.Fatalf("%s: bounds moved to [%d, %d, %d], want [%d, %d, %d] — frozen forever",
				c.key, p.Min, p.Value, p.Max, c.min, c.def, c.max)
		}
	}
}
