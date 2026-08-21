//go:build !testwindows

package engine

// HeightsPerDay is the real day: 28,800 three-second heights.
//
// Every lifecycle window in the protocol — mint maturity, the 30-day grace,
// the 90-day bleed, the 7/30-day payout windows, LP loyalty aging, the
// accrual walk's step — is denominated in these days.
const HeightsPerDay = 24 * HeightsPerHour // 28_800

// BuildVariant is stamped into the init message so a deployment can never be
// mistaken for the other build. Empty on the real protocol.
const BuildVariant = ""
