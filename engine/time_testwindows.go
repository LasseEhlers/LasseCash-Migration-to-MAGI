//go:build testwindows

package engine

// TEST BUILD — NEVER THE PRODUCTION PROTOCOL.
//
// A "day" is 6 minutes (120 heights), so every day-denominated window runs
// 240x fast: a 30-day mint matures in 3 hours, grace passes in 3, the bleed
// completes in 9, a viral post pays out in 42 minutes. Emission and the
// share-rate ratchet are pinned to mainnet time (see emission.go), so the
// VALUES observed on a test deployment are real — only the WAITING is
// compressed.
//
// Build: ./build.sh wasm-test  (adds -tags testwindows)
const HeightsPerDay = 6 * HeightsPerMinute // 120

// BuildVariant marks every init of this build, so a throwaway deployment can
// never be confused with the real chain by anyone who reads its state.
const BuildVariant = " [TESTWINDOWS BUILD 240x]"
