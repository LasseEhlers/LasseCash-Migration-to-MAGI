//go:build js && wasm

// Command engine-wasm exposes the LasseCash engine to the browser.
//
// This is a BRIDGE, not an implementation. Every function here forwards
// directly to github.com/lassecash/engine — the same package the MAGI contract
// and the dev chain run. There is deliberately no arithmetic in this file
// beyond marshalling, because a formula written here would be exactly the
// second implementation the golden rule exists to prevent.
//
// ALL AMOUNTS CROSS THE BRIDGE AS STRINGS, in base units. JavaScript numbers
// cannot hold the products involved (every multiplier is 1e8-scaled, so
// amount x multiplier reaches ~1e23), and decimal fractions are not exactly
// representable in binary at any magnitude.
//
// Build:
//
//	docker run --rm -v "$PWD":/src -w /src tinygo/tinygo:0.39.0 \
//	  tinygo build -o engine.wasm -target wasm -no-debug .
package main

import (
	"strconv"
	"syscall/js"

	"github.com/lassecash/engine"
)

func main() {
	js.Global().Set("__lassecashEngine", js.ValueOf(map[string]any{
		// pure functions of user input — exact, never stale
		"mintQuote":          js.FuncOf(mintQuote),
		"shareRate":          js.FuncOf(shareRate),
		"shareRateHbd":       js.FuncOf(shareRateHbd),
		"durationMultiplier": js.FuncOf(durationMultiplier),
		"volumeMultiplier":   js.FuncOf(volumeMultiplier),
		"loyaltyMultiplier":  js.FuncOf(loyaltyMultiplier),
		"voteCost":           js.FuncOf(voteCost),
		"canPost":            js.FuncOf(canPost),
		"voteWeight":         js.FuncOf(voteWeight),
		"votePower":          js.FuncOf(votePower),
		"trancheView":        js.FuncOf(trancheView),
		"routePayout":        js.FuncOf(routePayout),
		"blockSplit":         js.FuncOf(blockSplit),
		"dailyRewards":       js.FuncOf(dailyRewards),
		"supplyLimits":       js.FuncOf(supplyLimits),

		// governed values — exact for the state rows handed in, but chain state
		// moves, so re-read before signing
		"effectiveValue": js.FuncOf(effectiveValue),
		"consensusGroup": js.FuncOf(consensusGroup),

		// functions of live pool state — ESTIMATES, label them as such
		"swapOut":        js.FuncOf(swapOut),
		"lcToHbd":        js.FuncOf(lcToHbd),
		"rewardShare":    js.FuncOf(rewardShare),
		"entitlement":    js.FuncOf(entitlement),
		"liquidityQuote": js.FuncOf(liquidityQuote),
		"mintPreview":    js.FuncOf(mintPreview),

		// constants, so the UI never hardcodes a bound the chain enforces
		"constants": js.ValueOf(map[string]any{
			"decimals":        engine.Decimals,
			"unit":            str(engine.Unit),
			"multScale":       str(engine.MultScale),
			"minMintDays":     engine.MinMintDays,
			"maxMintDays":     engine.MaxMintDays,
			"minMintAmount":   amt(engine.MinMintAmount),
			"graceDays":       engine.GraceDays,
			"bleedDays":       engine.BleedDays,
			"goodAcctArmDays": engine.GoodAccountingArmDays,
			"goodAcctGrace":   engine.GoodAccountingGraceDays,
			"loyaltyMaxDays":  engine.LoyaltyMaxDays,
			// The lock on the mint an account's legacy LASSECASH POWER becomes.
			// The claim page needs it to build the synthetic mint it previews,
			// and a hardcoded 30 in TypeScript would be exactly the second
			// implementation the golden rule exists to prevent.
			"migrationMintDays": engine.MigrationMintDays,
			"heightsPerDay":     str(int64(engine.HeightsPerDay)),
			"heightsPerYear":    str(int64(engine.HeightsPerYear)),
			"secondsPerHeight":  engine.SecondsPerHeight,
			"viralPayoutDays":   engine.ViralPayoutDays,
			"deepPayoutDays":    engine.DeepPayoutDays,
			"fullVoteCostPct":   engine.FullVoteCostPct,

			// The governable parameter keys, so a caller never hardcodes a
			// string the registry owns.
			"paramVolumeStart":          string(engine.ParamVolumeStart),
			"paramVolumeEnd":            string(engine.ParamVolumeEnd),
			"paramPostThresholdViral":   string(engine.ParamPostThresholdViral),
			"paramPostThresholdDeep":    string(engine.ParamPostThresholdDeep),
			"paramPostThresholdComment": string(engine.ParamPostThresholdComment),
			"paramPromoteMinBurn":       string(engine.ParamPromoteMinBurn),
			"promoteCutoffPct":          engine.PromoteCutoffPct,
		}),
	}))
	select {} // keep the instance alive for the host to call into
}

// --- marshalling ----------------------------------------------------------

func str(v int64) string         { return strconv.FormatInt(v, 10) }
func amt(a engine.Amount) string { return strconv.FormatInt(int64(a), 10) }

// arg reads a base-unit string argument. Missing or malformed values become 0,
// which every engine function then rejects — failing closed.
func arg(args []js.Value, i int) engine.Amount {
	if i >= len(args) {
		return 0
	}
	v, err := strconv.ParseInt(args[i].String(), 10, 64)
	if err != nil {
		return 0
	}
	return engine.Amount(v)
}

func argI(args []js.Value, i int) int64 {
	if i >= len(args) {
		return 0
	}
	if args[i].Type() == js.TypeNumber {
		return int64(args[i].Int())
	}
	v, _ := strconv.ParseInt(args[i].String(), 10, 64)
	return v
}

func argU(args []js.Value, i int) uint64 {
	v := argI(args, i)
	if v < 0 {
		return 0
	}
	return uint64(v)
}

func argB(args []js.Value, i int) bool {
	return i < len(args) && args[i].Truthy()
}

func argS(args []js.Value, i int) string {
	if i >= len(args) || args[i].Type() != js.TypeString {
		return ""
	}
	return args[i].String()
}

// argBoard reads a `[{account, shares, preference?}, ...]` argument into the two
// shapes the engine wants: holders to rank, and the standing preferences of
// whoever ends up ranked.
//
// A preference is ABSENT unless it parses as an integer. Null, undefined and —
// importantly — the empty string all mean "no row", because a missing key on
// MAGI reads back as a pointer to an empty string, not as nil (see the
// empty-vs-nil bug in CLAUDE.md). Absent is not zero: engine.EffectiveValue
// skips a member with no preference rather than counting them as voting for 0.
func argBoard(args []js.Value, i int) ([]engine.Holder, engine.Preferences) {
	prefs := engine.Preferences{}
	if i >= len(args) || args[i].Type() != js.TypeObject {
		return nil, prefs
	}
	list := args[i]
	n := list.Length()
	holders := make([]engine.Holder, 0, n)
	for j := 0; j < n; j++ {
		e := list.Index(j)
		account := field(e, "account")
		if account == "" {
			continue
		}
		// A malformed or missing share count leaves the holder at zero, which
		// ConsensusGroup drops — no seat, no vote.
		shares, _ := strconv.ParseInt(field(e, "shares"), 10, 64)
		holders = append(holders, engine.Holder{
			Account: account, Shares: engine.Shares(shares),
		})
		if v, err := strconv.ParseInt(field(e, "preference"), 10, 64); err == nil {
			prefs[account] = v
		}
	}
	return holders, prefs
}

// field reads a string property, treating anything that is not a string —
// undefined, null, a number — as absent rather than calling String() on it.
func field(v js.Value, name string) string {
	p := v.Get(name)
	if p.Type() != js.TypeString {
		return ""
	}
	return p.String()
}

// --- pure functions of user input -----------------------------------------

// mintQuote(principal, days, shareRate, volumeStart, volumeEnd)
//
// Exactly what the contract computes at mint creation. Since all five inputs
// come from the caller, this is not an estimate — it is the number.
func mintQuote(_ js.Value, a []js.Value) any {
	principal := arg(a, 0)
	days := argI(a, 1)
	p := engine.MintParams{
		ShareRate:   arg(a, 2),
		VolumeStart: arg(a, 3),
		VolumeEnd:   arg(a, 4),
	}
	dur := engine.DurationMultiplier(days)
	vol := engine.VolumeMultiplier(principal, p.VolumeStart, p.VolumeEnd)
	combined, _ := engine.MulDiv(engine.Amount(dur), vol, engine.MultScale)

	shares, ok := engine.ComputeShares(principal, days, p)
	return map[string]any{
		"ok":                 ok,
		"shares":             amt(engine.Amount(shares)),
		"durationMultiplier": str(dur),
		"volumeMultiplier":   str(vol),
		"combinedMultiplier": str(int64(combined)),
	}
}

// shareRate(genesisHeight, height) — the upward-only 7%/yr ratchet.
func shareRate(_ js.Value, a []js.Value) any {
	return amt(engine.ShareRate(argU(a, 0), argU(a, 1)))
}

// shareRateHbd(genesisHeight, height, lcReserve, hbdReserve) — the rate
// converted at the pool's spot price. ESTIMATE: reserves move.
func shareRateHbd(_ js.Value, a []js.Value) any {
	v, ok := engine.ShareRateInHbd(argU(a, 0), argU(a, 1), arg(a, 2), arg(a, 3))
	if !ok {
		return ""
	}
	return amt(v)
}

// lcToHbd(amount, lcReserve, hbdReserve) — a LASSECASH amount at the pool's
// spot price, for the "≈ X HBD" figures beside LASSECASH sums. ESTIMATE:
// reserves move. Empty string while the pool is unseeded — there is no price
// yet, and a zero would read as "worthless" rather than "unknown".
func lcToHbd(_ js.Value, a []js.Value) any {
	v, ok := engine.LcToHbd(arg(a, 0), arg(a, 1), arg(a, 2))
	if !ok {
		return ""
	}
	return amt(v)
}

// durationMultiplier(days) — Longer Pays Better, 1.00x to 1.50x.
func durationMultiplier(_ js.Value, a []js.Value) any {
	return str(engine.DurationMultiplier(argI(a, 0)))
}

// volumeMultiplier(principal, start, end) — Bigger Pays Better, 1.00x to 1.50x.
func volumeMultiplier(_ js.Value, a []js.Value) any {
	return str(engine.VolumeMultiplier(arg(a, 0), arg(a, 1), arg(a, 2)))
}

// loyaltyMultiplier(ageDays) — liquidity loyalty, 1.00x to 1.90x at 90 days.
func loyaltyMultiplier(_ js.Value, a []js.Value) any {
	return str(engine.LoyaltyMultiplier(argI(a, 0)))
}

// voteCost(weightPct) — vote power consumed by a vote of this weight.
func voteCost(_ js.Value, a []js.Value) any {
	return str(engine.VoteCost(argI(a, 0)))
}

// canPost(shares, threshold) — may an account holding `shares` publish into a
// window whose governed threshold is `threshold`?
//
// Both arguments are base-unit strings (L-Shares, 1e8-scaled). The comparison
// is one line, which is exactly why it belongs here and not in TypeScript: the
// contract refuses a post with engine.CanPost, so a frontend that decides
// eligibility any other way is a second implementation of the rule — and the
// place it would be wrong is a post shown as publishable that the chain then
// rejects, or a tagged Hive post shown on LasseCash that never qualified.
func canPost(_ js.Value, a []js.Value) any {
	return engine.CanPost(engine.Shares(arg(a, 0)), int64(arg(a, 1)))
}

// voteWeight(shares, powerSpent) — the rshares a vote contributes.
func voteWeight(_ js.Value, a []js.Value) any {
	return str(engine.VoteWeight(engine.Shares(arg(a, 0)), argI(a, 1)))
}

// votePower(power, lastHeight, height, window) — current meter reading.
// window: 0 viral (7-day regen), 1 deep (30-day regen).
func votePower(_ js.Value, a []js.Value) any {
	vp := engine.VotePower{Power: argI(a, 0), LastHeight: argU(a, 1)}
	return str(vp.Current(window(argI(a, 3)), argU(a, 2)))
}

// trancheView(shares, startHeight, weight, accStart, height, totalShares,
// lcReserve, hbdReserve, poolLiq, accSeen, accHeld, acc, totalWeight) — a
// liquidity tranche's live figures, exactly as the contract computes them:
// age, loyalty multiplier, withdrawable LC/HBD, and the reward owed now.
func trancheView(_ js.Value, a []js.Value) any {
	age := engine.AgeDays(argU(a, 1), argU(a, 4))
	lc, hbd, _ := engine.WithdrawAmounts(engine.Shares(arg(a, 0)), engine.Shares(arg(a, 5)), arg(a, 6), arg(a, 7))
	owed := engine.PoolRewardsOwed(engine.Shares(arg(a, 2)), argI(a, 3), arg(a, 8), arg(a, 9), arg(a, 10), argI(a, 11), engine.Shares(arg(a, 12)))
	return map[string]any{
		"age_days":       age,
		"loyalty":        str(engine.LoyaltyMultiplier(age)),
		"value_lc":       amt(lc),
		"value_hbd":      amt(hbd),
		"pending_reward": amt(owed),
	}
}

// routePayout(amount) — the 20% liquid / 80% pending split on PoB rewards.
func routePayout(_ js.Value, a []js.Value) any {
	liquid, pending := engine.RoutePayout(arg(a, 0))
	return map[string]any{"liquid": amt(liquid), "pending": amt(pending)}
}

// blockSplit(amount) — 50% Proof-of-Brain / 25% L-Share / 25% liquidity,
// with PoB further split 25% viral / 75% deep.
func blockSplit(_ js.Value, a []js.Value) any {
	al := engine.Split(arg(a, 0))
	viral, deep := engine.SplitPoB(al.ProofOfBrain)
	return map[string]any{
		"proofOfBrain": amt(al.ProofOfBrain),
		"lshare":       amt(al.LShare),
		"liquidity":    amt(al.Liquidity),
		"viral":        amt(viral),
		"deep":         amt(deep),
	}
}

// dailyRewards(genesisHeight, height) — the emission of the day containing
// `height`, split into its pools. EXACT: the schedule is closed-form.
func dailyRewards(_ js.Value, a []js.Value) any {
	sc := engine.DefaultSchedule
	sc.GenesisHeight = argU(a, 0)
	h := argU(a, 1)
	day := uint64(0)
	if h > sc.GenesisHeight {
		day = (h - sc.GenesisHeight) / uint64(engine.HeightsPerDay)
	}
	from := sc.GenesisHeight + day*uint64(engine.HeightsPerDay)
	total := sc.EmissionBetween(from, from+uint64(engine.HeightsPerDay))
	al := engine.Split(total)
	viral, deep := engine.SplitPoB(al.ProofOfBrain)
	return map[string]any{
		"total":        amt(total),
		"proofOfBrain": amt(al.ProofOfBrain),
		"lshare":       amt(al.LShare),
		"liquidity":    amt(al.Liquidity),
		"viral":        amt(viral),
		"deep":         amt(deep),
	}
}

// supplyLimits(snapshotTotal) — the hardcap picture: the committed snapshot
// plus the full emission cap against the historic 51M. `lost` is what was
// issued on the old chains but no account holds any more: never mintable by
// anyone, because nobody can issue. EXACT.
func supplyLimits(_ js.Value, a []js.Value) any {
	snapshot := arg(a, 0)
	maxEver := snapshot + engine.EmissionCap
	lost := engine.HistoricHardCap - maxEver
	if lost < 0 {
		lost = 0
	}
	return map[string]any{
		"hardcap":     amt(engine.HistoricHardCap),
		"emissionCap": amt(engine.EmissionCap),
		"maxEver":     amt(maxEver),
		"lost":        amt(lost),
	}
}

// --- governed values ------------------------------------------------------

// effectiveValue(paramKey, [{account, shares, preference?}, ...])
//
// The value currently in force for a governable parameter: the LOWER MEDIAN of
// the standing preferences held by the top-10 L-Share holders, with every
// preference first clamped into the parameter's hardcoded bounds, and the
// registered default standing when nobody has voted.
//
// The caller supplies exactly what the frozen public state ABI exposes — the
// `gov_board` accounts, their `shr_<account>` balances, and their
// `gov_<param>_<account>` preference rows — and NOTHING here interprets them.
// Ranking is engine.ConsensusGroup (same tie-break, same zero-share drop as the
// contract) and the median, the clamping and the default are
// engine.EffectiveValue. This mirrors contract/state/governance.go
// EffectiveParam step for step; the only difference is where the rows came from.
//
// Shares are required, not incidental: the member set IS the ranking, so a
// caller that passed only preferences would have had to re-implement
// betterThan in its own language to know whose preferences count.
//
// Exact for the rows handed in. Chain state moves, so a value that will be
// signed against must be re-read, exactly like a share rate.
func effectiveValue(_ js.Value, a []js.Value) any {
	p, found := engine.NewRegistry().Param(engine.ParamKey(argS(a, 0)))
	if !found {
		// Fail closed: an unknown key must never look like a value of zero.
		return map[string]any{"ok": false, "value": "0",
			"min": "0", "max": "0", "defaultValue": "0"}
	}
	holders, prefs := argBoard(a, 1)
	members := engine.ConsensusGroup(holders)
	return map[string]any{
		"ok":           true,
		"value":        str(engine.EffectiveValue(p, members, prefs)),
		"min":          str(p.Min),
		"max":          str(p.Max),
		"defaultValue": str(p.Value),
	}
}

// consensusGroup([{account, shares}, ...])
//
// The top-10 L-Share holders, ranked exactly as engine.ConsensusGroup ranks
// them on-chain: shares descending, ties broken by account ascending, holders
// with zero (or fewer) shares dropped. This is the SAME ranking a foreign
// dApp contract derives from the frozen public state ABI (`gov_board` +
// `shr_<account>`, see CLAUDE.md's "Public state ABI") by reading the
// identical engine.ConsensusGroup Go function — nothing here re-implements
// the tie-break.
//
// Reuses argBoard, which is also effectiveValue's rows reader; the
// `preference` field it may carry is simply unused here.
//
// Exact for the rows handed in. The board and share balances move on-chain,
// so a membership check built on this must be re-read before it is relied on.
func consensusGroup(_ js.Value, a []js.Value) any {
	holders, _ := argBoard(a, 0)
	members := engine.ConsensusGroup(holders)
	out := make([]any, len(members))
	for i, m := range members {
		out[i] = map[string]any{
			"account": m.Account,
			"shares":  amt(engine.Amount(m.Shares)),
		}
	}
	return out
}

// --- functions of live pool state (ESTIMATES) -----------------------------

// swapOut(reserveIn, reserveOut, amountIn)
//
// ESTIMATE. Reserves move between preview and broadcast, so the UI must label
// this and every submit must carry a minOut. There is no fee argument: the
// LASSECASH:HBD swap fee is hardcoded to zero.
func swapOut(_ js.Value, a []js.Value) any {
	resIn, resOut, in := arg(a, 0), arg(a, 1), arg(a, 2)
	out, ok := engine.SwapOut(resIn, resOut, in)

	res := map[string]any{"ok": ok, "amountOut": amt(out)}
	if ok && in > 0 {
		if rate, okR := engine.MulDiv(out, engine.Unit, int64(in)); okR {
			res["rate"] = amt(rate)
		}
		if spot, okS := engine.MulDiv(resOut, engine.Unit, int64(resIn)); okS && spot > 0 {
			if exec, okE := engine.MulDiv(out, engine.Unit, int64(in)); okE {
				if imp, okI := engine.MulDiv(spot-exec, 100*engine.Unit, int64(spot)); okI {
					res["priceImpactPct"] = amt(imp)
				}
			}
		}
	}
	return res
}

// rewardShare(pool, userShares, totalShares) — ESTIMATE; the pool grows with
// every block and total shares move as others mint.
// entitlement(shares, accStart, accEnd) — EXACT accrued yield for a mint.
//
// The accumulator readings come from chain state; the arithmetic stays in the
// engine, because `shares * (accEnd - accStart) / AccScale` is exactly the
// kind of formula the golden rule forbids re-typing in TypeScript.
func entitlement(_ js.Value, a []js.Value) any {
	return amt(engine.Entitlement(engine.Shares(arg(a, 0)), int64(arg(a, 1)), int64(arg(a, 2))))
}

func rewardShare(_ js.Value, a []js.Value) any {
	return amt(engine.RewardShare(arg(a, 0), engine.Shares(arg(a, 1)), engine.Shares(arg(a, 2))))
}

// liquidityQuote(lcIn, lcReserve, hbdReserve, totalShares) — ESTIMATE.
func liquidityQuote(_ js.Value, a []js.Value) any {
	lcIn, lcRes, hbdRes := arg(a, 0), arg(a, 1), arg(a, 2)
	total := engine.Shares(arg(a, 3))

	if total <= 0 || lcRes <= 0 || hbdRes <= 0 {
		return map[string]any{"ok": true, "isFirstDeposit": true,
			"hbdNeeded": "0", "shares": amt(lcIn)}
	}
	need, okN := engine.HbdRequiredFor(lcIn, lcRes, hbdRes)
	shares, okS := engine.LPSharesFor(lcIn, lcRes, total)
	return map[string]any{
		"ok": okN && okS, "isFirstDeposit": false,
		"hbdNeeded": amt(need), "shares": amt(engine.Amount(shares)),
	}
}

// mintPreview(principal, shares, startHeight, days, goodAccounting, height, accruedYield)
//
// What closing this mint right now would pay. ESTIMATE only because
// accruedYield depends on the live pool; the curve itself is exact.
func mintPreview(_ js.Value, a []js.Value) any {
	m := engine.Mint{
		Principal:      arg(a, 0),
		Shares:         engine.Shares(arg(a, 1)),
		StartHeight:    argU(a, 2),
		Days:           argI(a, 3),
		GoodAccounting: argB(a, 4),
	}
	height := argU(a, 5)
	yield := arg(a, 6)
	s := m.Settle(height, yield)

	return map[string]any{
		"toOwner":           amt(s.ToOwner),
		"toRewardPool":      amt(s.ToRewardPool),
		"early":             s.Early,
		"maturityHeight":    str(int64(m.MaturityHeight())),
		"mature":            m.IsMature(height),
		"canArm":            m.CanArmGoodAccounting(height),
		"recoveryFraction":  str(m.EarlyEndRecovery(height)),
		"bleedRemaining":    str(m.BleedRemaining(height)),
		"liquidationHeight": str(int64(m.LiquidationHeight())),
	}
}

func window(w int64) engine.Window {
	if w == 1 {
		return engine.Deep
	}
	return engine.Viral
}
