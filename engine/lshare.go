package engine

// L-Shares: the immutable time-lock staking units of LasseCash.
//
// An L-Share is three things at once, deliberately:
//   1. a claim on the 25% L-Share slice of block rewards
//   2. voting weight on Proof-of-Brain content (the old LASSECASH POWER)
//   3. governance weight (the top-10 holders set bounded parameters)
//
// Collapsing all three into one instrument is what lets LasseCash avoid the
// separate HP / witness-vote / proposal machinery that Hive carries.
//
// Everything here is integer math on base units. See units.go for why.

// --- fixed-point scales ---------------------------------------------------

// MultScale is the fixed-point scale for multipliers and fractions.
// 1.0 == MultScale, 1.5 == MultScale*3/2.
const MultScale int64 = 100_000_000

// ShareUnit is the base-unit scale for L-Shares, matching LASSECASH at 8dp.
const ShareUnit int64 = 100_000_000

// Shares is a quantity of L-Shares in base units (8 decimals).
type Shares int64

// --- immutable protocol constants ----------------------------------------
//
// These are hardcoded and have NO governance path. See CLAUDE.md.

const (
	// MinMintDays is the shortest possible lock.
	MinMintDays = 1
	// MaxMintDays is the longest possible lock: 3 years.
	MaxMintDays = 1095

	// MaxDurationBonus is the Longer-Pays-Better ceiling: 1.5x at MaxMintDays.
	MaxDurationBonus = MultScale / 2 // +0.5

	// MaxVolumeBonus is the Bigger-Pays-Better ceiling: 1.5x at the top amount.
	MaxVolumeBonus = MultScale / 2 // +0.5

	// ShareRateRatchetPct is the annual, upward-only share-rate increase.
	ShareRateRatchetPct = 7

	// GraceDays is the safe period after maturity: nothing happens.
	// Exists so illness or forgetfulness costs nothing.
	//
	// REVISED 2026-08-22: 30 -> 90. Thirty days was the harshest parameter in
	// the whole design. Someone who locked faithfully for three years and then
	// spent six weeks in hospital could not even ARM Good Accounting — the
	// window is [maturity, maturity+GraceDays) — and was bleeding, at zero by
	// day 120. Three years of good behaviour undone by one bad month.
	//
	// Ninety days is the same quarter of warning the pool's dormancy check
	// gives a liquidity provider, and the principle is the same one: be tight
	// with people who were GIVEN tokens, generous with people who COMMITTED
	// capital. A matured mint is committed capital. Recycling still happens,
	// just later; nothing about the perpetual engine depends on it being 30.
	//
	// This also widens the migration claim window to
	// MigrationMintDays + GraceDays + BleedDays = 210 days, and the Good
	// Accounting arming window to 90 days. Both derived, neither a new
	// constant. See state.ClaimDeadlineHeight.
	GraceDays = 90
	// BleedDays is how long the post-grace bleed takes to reach zero.
	BleedDays = 90
	// GoodAccountingArmDays is the window in which Good Accounting may be
	// armed: the GRACE month AFTER maturity, before the bleed starts.
	//
	// DECIDED 2026-08-21 (supersedes "final 7 days before maturity"): the
	// owner is then looking at a matured position with a real decision in
	// front of them, and the anti-abuse rule holds by construction — arming
	// is only possible BEFORE any bleed, so nobody can watch themselves lose
	// value and retroactively opt out. HEX arms after maturity too; unlike HEX
	// it stays owner-only, because it reshapes the owner's tax timing.
	GoodAccountingArmDays = GraceDays

	// GoodAccountingGraceDays is the grace period when Good Accounting Mode is
	// armed: 3 years, matching the maximum mint duration.
	//
	// Rationale: tax years are annual everywhere, so 1 year would offer only a
	// single year-end to choose from. Deferral is usually about reaching a
	// low-income or loss year, which is rarely next year specifically. 3 years
	// gives four tax years to pick from.
	//
	// It is deliberately FINITE. An infinite hold would strand the principal of
	// anyone who lost their keys, permanently removing it from the recycling
	// engine that funds the reward pool after emission ends.
	GoodAccountingGraceDays = 1095

	// MinEarlyEndRecovery is the floor on principal recovery for an early end,
	// reached at day 0. Rises linearly to MultScale (100%) at maturity.
	MinEarlyEndRecovery = MultScale / 2 // 50%
)

// GenesisShareRate is the cost of 1.00000000 L-Share at migration: 1 LASSECASH.
const GenesisShareRate = Amount(100_000_000)

// --- share rate -----------------------------------------------------------

// ShareRate returns the cost in LASSECASH base units of one whole L-Share at
// the given height.
//
// The rate ratchets upward by 7% per annum and NEVER decreases — that is the
// core promise to early minters. Full years compound; the fraction of a year
// is interpolated linearly so there is no cliff on the anniversary that a
// minter could game by waiting a day.
//
// Over 75 years this compounds to roughly 164x, so a late minter receives
// ~1/164 the shares per LASSECASH that a genesis minter did. That is the
// intended early-adopter reward and it is announced in advance.
func ShareRate(genesisHeight, height uint64) Amount {
	if height <= genesisHeight {
		return GenesisShareRate
	}
	elapsed := height - genesisHeight
	years := elapsed / HeightsPerYear
	frac := elapsed % HeightsPerYear

	rate := GenesisShareRate
	for i := uint64(0); i < years; i++ {
		next, ok := MulDiv(rate, 100+ShareRateRatchetPct, 100)
		if !ok || next < rate { // never let overflow make the rate fall
			return rate
		}
		rate = next
	}
	if frac > 0 {
		// Linear interpolation across the current year: + 7% * frac/year.
		bump, ok := MulDiv(rate, ShareRateRatchetPct*int64(frac),
			100*int64(HeightsPerYear))
		if ok {
			if sum, ok2 := rate.Add(bump); ok2 {
				rate = sum
			}
		}
	}
	return rate
}

// ShareRateInHbd converts the share rate at a height into HBD base units per
// whole L-Share, at the spot price implied by the pool reserves:
//
//	rate(LC/share) * hbdReserve / lcReserve
//
// The result is an ESTIMATE in the same sense every spot price is — reserves
// move between reading and acting — but the conversion itself lives here so
// no frontend ever multiplies a rate by a price in its own arithmetic.
// Returns ok=false while the pool is unseeded (lcReserve == 0).
func ShareRateInHbd(genesisHeight, height uint64, lcReserve, hbdReserve Amount) (Amount, bool) {
	if lcReserve <= 0 || hbdReserve < 0 {
		return 0, false
	}
	return MulDiv(ShareRate(genesisHeight, height), int64(hbdReserve), int64(lcReserve))
}

// --- multipliers ----------------------------------------------------------

// DurationMultiplier implements "Longer Pays Better".
//
//	1 day    -> 1.0x
//	1095 days-> 1.5x
//	linear in between
//
// Returns a fixed-point multiplier scaled by MultScale.
func DurationMultiplier(days int64) int64 {
	if days <= MinMintDays {
		return MultScale
	}
	if days >= MaxMintDays {
		return MultScale + MaxDurationBonus
	}
	// MultScale + (days-1)/(1095-1) * 0.5
	bonus := (days - MinMintDays) * MaxDurationBonus / (MaxMintDays - MinMintDays)
	return MultScale + bonus
}

// VolumeMultiplier implements "Bigger Pays Better".
//
//	<= start -> 1.0x
//	>= end   -> 1.5x
//	linear in between
//
// start and end are GOVERNABLE (defaults 10,000 and 100,000 LC) but the 1.5x
// ceiling is not. Callers must pass the values that were in force at mint
// time — a later governance change must never alter an existing mint.
func VolumeMultiplier(principal, start, end Amount) int64 {
	if end <= start {
		return MultScale // degenerate config: no bonus rather than divide by zero
	}
	if principal <= start {
		return MultScale
	}
	if principal >= end {
		return MultScale + MaxVolumeBonus
	}
	// principal can be near the 51M cap, so the product overflows int64.
	bonus, ok := MulDiv(principal-start, MaxVolumeBonus, int64(end-start))
	if !ok {
		return MultScale
	}
	return MultScale + int64(bonus)
}

// --- minting --------------------------------------------------------------

// Mint is a single time-lock position. Stored per-user in contract state.
//
// Shares are computed ONCE at creation and frozen. Nothing — not a governance
// vote, not a share-rate ratchet — may recompute them afterwards.
type Mint struct {
	Owner string
	// Principal is the LASSECASH locked, in base units.
	Principal Amount
	// Shares is the L-Shares granted, frozen at creation.
	Shares Shares
	// StartHeight is when the mint was created.
	StartHeight uint64
	// Days is the committed duration, 1..1095.
	Days int64
	// GoodAccounting, when true, permanently disables the post-maturity bleed.
	GoodAccounting bool
	// Ended is set once the position is closed (claimed or early-ended).
	Ended bool
	// AccStart is the reward-per-share accumulator at the moment this mint was
	// created. Its yield is the accumulator's RISE since then, so emission that
	// arrived before this mint existed can never be claimed by it.
	AccStart int64
	// ExpChunk locates this mint's entry in its maturity day's expiry list —
	// the chunked per-account schedule the accrual walk uses to retire voting
	// power at maturity (Lasse, 2026-08-21: ALL voting power ends at maturity).
	// A storage locator, not economics; it lives here because the mint record
	// is the one place both sides already share.
	ExpChunk uint64
}

// MintParams are the governable inputs captured at mint time.
type MintParams struct {
	// VolumeStart / VolumeEnd bound the Bigger-Pays-Better ramp.
	VolumeStart Amount
	VolumeEnd   Amount
	// ShareRate is the rate in force at mint height.
	ShareRate Amount
}

// ComputeShares returns the L-Shares granted for a mint.
//
//	shares = (principal / shareRate) * durationMultiplier * volumeMultiplier
//
// The two multipliers compose MULTIPLICATIVELY, so the maximum is 2.25x
// (1.5 x 1.5) for a maximum-size, maximum-duration mint.
//
// Every step floors. A minter can never receive more shares than the formula
// allows; rounding only ever costs them a fraction of a base unit.
func ComputeShares(principal Amount, days int64, p MintParams) (Shares, bool) {
	if principal <= 0 || days < MinMintDays || days > MaxMintDays {
		return 0, false
	}
	if p.ShareRate <= 0 {
		return 0, false
	}

	// base = principal / shareRate, carried at ShareUnit precision.
	base, ok := MulDiv(principal, ShareUnit, int64(p.ShareRate))
	if !ok {
		return 0, false
	}
	withDuration, ok := MulDiv(base, DurationMultiplier(days), MultScale)
	if !ok {
		return 0, false
	}
	final, ok := MulDiv(withDuration,
		VolumeMultiplier(principal, p.VolumeStart, p.VolumeEnd), MultScale)
	if !ok {
		return 0, false
	}
	return Shares(final), true
}

// NewMint creates a position. Caller must have already debited the principal.
func NewMint(owner string, principal Amount, days int64, height uint64,
	p MintParams) (Mint, bool) {
	shares, ok := ComputeShares(principal, days, p)
	if !ok || shares <= 0 {
		return Mint{}, false
	}
	return Mint{
		Owner:       owner,
		Principal:   principal,
		Shares:      shares,
		StartHeight: height,
		Days:        days,
	}, true
}

// MigrationMintDays is the lock on the mint that receives an account's legacy
// staked LASSECASH POWER at migration.
//
// ONE MONTH — decided by Lasse 2026-08-21 (the spec said six). Legacy stake
// is not a chosen commitment, and the founder's migrated stake alone is over
// half of all migration shares; a six-month lock would let that unchosen
// weight draw on the L-Share pool and dominate governance for half a year.
// One month resets the system fast: everyone is liquid at day 30 and decides
// fresh what to mint; a dead account's stake bleeds to zero by day 150 — five
// months — and recycles into the reward pool. Shorter than the 182-day
// Hive-Engine unstaking cooldown the stake was under, so nobody is locked
// longer than the rules they originally staked beneath.
const MigrationMintDays = 30

// NewMigrationMint converts legacy staked LASSECASH POWER into L-Shares.
//
// Per the spec: "Old staked power is translated directly into Migration
// L-Shares 1 to 1. These are automatically placed into a 6-month migration
// mint to flush out legacy liquidity and purge past dead weight."
//
// 1:1 means EXACTLY that — no Longer-Pays-Better, no Bigger-Pays-Better, no
// share rate. Legacy stake is not a voluntary new commitment, so it earns no
// multiplier; it simply keeps the weight it already had. The flush mechanic
// is the ordinary mint lifecycle: a dead account's migration mint matures,
// bleeds, and recycles into the reward pool.
func NewMigrationMint(owner string, staked Amount, height uint64) (Mint, bool) {
	if staked <= 0 {
		return Mint{}, false
	}
	return Mint{
		Owner:       owner,
		Principal:   staked,
		Shares:      Shares(staked),
		StartHeight: height,
		Days:        MigrationMintDays,
	}, true
}

// --- lifecycle ------------------------------------------------------------

// MaturityHeight is the height at which the lock completes.
func (m Mint) MaturityHeight() uint64 {
	return m.StartHeight + uint64(m.Days)*HeightsPerDay
}

// IsMature reports whether the lock has completed at the given height.
func (m Mint) IsMature(height uint64) bool {
	return height >= m.MaturityHeight()
}

// CanArmGoodAccounting reports whether Good Accounting Mode may be enabled now.
//
// The window opens AT maturity and closes when the ordinary grace ends — the
// moment the bleed would start. Never before maturity (nothing to decide yet)
// and never once bleeding (no retroactive opt-out).
func (m Mint) CanArmGoodAccounting(height uint64) bool {
	if m.Ended || m.GoodAccounting {
		return false
	}
	mat := m.MaturityHeight()
	return height >= mat && height < mat+uint64(GoodAccountingArmDays)*HeightsPerDay
}

// EarlyEndRecovery returns the fraction of principal recoverable by ending
// early at the given height, scaled by MultScale.
//
// Rises linearly from 50% at creation to 100% at maturity. Accrued rewards are
// forfeited entirely on any early end — only a mint held to maturity pays out.
func (m Mint) EarlyEndRecovery(height uint64) int64 {
	if height <= m.StartHeight {
		return MinEarlyEndRecovery
	}
	total := m.MaturityHeight() - m.StartHeight
	if total == 0 || height >= m.MaturityHeight() {
		return MultScale
	}
	elapsed := height - m.StartHeight
	// 50% + 50% * elapsed/total
	bonus := int64(elapsed) * (MultScale - MinEarlyEndRecovery) / int64(total)
	return MinEarlyEndRecovery + bonus
}

// GraceDaysFor returns the grace period applicable to this mint.
//
// Good Accounting Mode does not disable the bleed — it EXTENDS the grace. That
// keeps one code path instead of a second state machine, and guarantees that
// abandoned positions eventually recycle into the reward pool.
func (m Mint) GraceDaysFor() int64 {
	if m.GoodAccounting {
		return GoodAccountingGraceDays
	}
	return GraceDays
}

// BleedRemaining returns the fraction of value surviving the post-maturity
// bleed at the given height, scaled by MultScale.
//
// Timeline from maturity:
//
//	normal:          30d grace  -> 90d linear bleed -> zero at day 120
//	good accounting: 1095d grace -> 90d linear bleed -> zero at day 1185
//
// Applies to BOTH principal and accrued rewards.
func (m Mint) BleedRemaining(height uint64) int64 {
	mat := m.MaturityHeight()
	if height <= mat {
		return MultScale
	}
	past := height - mat
	graceEnd := uint64(m.GraceDaysFor()) * HeightsPerDay
	if past <= graceEnd {
		return MultScale
	}
	bleedSpan := uint64(BleedDays) * HeightsPerDay
	into := past - graceEnd
	if into >= bleedSpan {
		return 0
	}
	// 100% * (1 - into/bleedSpan)
	return MultScale - int64(into)*MultScale/int64(bleedSpan)
}

// LiquidationHeight is the height at which the position reaches zero.
func (m Mint) LiquidationHeight() uint64 {
	return m.MaturityHeight() +
		uint64(m.GraceDaysFor()+BleedDays)*HeightsPerDay
}

// Settlement is the outcome of closing a position.
type Settlement struct {
	// ToOwner is what the user receives (principal + rewards, after any
	// early-end slash or post-maturity bleed).
	ToOwner Amount
	// ToRewardPool is what is swept into the L-Share reward pool: the
	// early-end slash, forfeited rewards, and anything bled.
	ToRewardPool Amount
	// Early reports whether this was an early end rather than a claim.
	Early bool
}

// Settle computes the payout for closing a mint at the given height.
//
// accruedRewards is the mint's share of the reward pool, computed by the
// caller as: poolAccrued * (mint.Shares / totalNetworkShares).
//
// INVARIANT, asserted in tests: ToOwner + ToRewardPool == Principal +
// accruedRewards, exactly. No base unit is ever created or destroyed here.
func (m Mint) Settle(height uint64, accruedRewards Amount) Settlement {
	total := m.Principal + accruedRewards

	if !m.IsMature(height) {
		// Early end: linear principal recovery, ALL rewards forfeited.
		frac := m.EarlyEndRecovery(height)
		recovered, ok := MulDiv(m.Principal, frac, MultScale)
		if !ok {
			recovered = 0
		}
		return Settlement{
			ToOwner:      recovered,
			ToRewardPool: total - recovered,
			Early:        true,
		}
	}

	// Matured: principal + rewards, less any bleed.
	frac := m.BleedRemaining(height)
	kept, ok := MulDiv(total, frac, MultScale)
	if !ok {
		kept = 0
	}
	return Settlement{
		ToOwner:      kept,
		ToRewardPool: total - kept,
		Early:        false,
	}
}

// --- reward share ---------------------------------------------------------

// RewardShare returns a mint's slice of an accrued reward pool:
//
//	userReward = poolAccrued * userShares / totalShares
//
// Floors, so the pool can never be over-drawn by rounding.
func RewardShare(poolAccrued Amount, userShares, totalShares Shares) Amount {
	if totalShares <= 0 || userShares <= 0 || poolAccrued <= 0 {
		return 0
	}
	if userShares > totalShares {
		return 0 // caller bug; refuse rather than over-pay
	}
	out, ok := MulDiv(poolAccrued, int64(userShares), int64(totalShares))
	if !ok {
		return 0
	}
	return out
}
