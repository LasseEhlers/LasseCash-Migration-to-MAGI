"""
Emission schedule options for LasseCash on MAGI.

CORRECTED: MAGI block time is 30s (10 Hive blocks x 3s), verified against
witnessSchedule on api.vsc.eco. The original spec assumed 3s.

All math in base units. 1 LC = 100_000_000 units (8 decimals).
"""

DEC = 8
UNIT = 10 ** DEC
CAP = 20_000_000 * UNIT

MAGI_BLOCK_SECONDS = 30
BLOCKS_PER_YEAR = 365 * 86400 // MAGI_BLOCK_SECONDS      # 1_051_200

def lc(u):
    return f"{u // UNIT:,}.{u % UNIT:08d}"

def simulate(era_years, reduction_num, reduction_den, cap=CAP):
    """
    Geometric emission. Each era pays out `budget`, then budget is multiplied
    by (reduction_num/reduction_den). Sum of the infinite series must equal
    `cap`, so first-era budget = cap * (1 - r).

    Returns (first_budget, eras_until_zero, total_emitted, years).
    """
    era_blocks = era_years * BLOCKS_PER_YEAR
    # a = cap * (1 - r) = cap * (den - num) / den
    budget = cap * (reduction_den - reduction_num) // reduction_den
    first_budget = budget
    total = 0
    era = 0
    while True:
        era += 1
        per_block = budget // era_blocks
        if per_block == 0:
            break
        total += per_block * era_blocks
        budget = budget * reduction_num // reduction_den
        if era > 100_000:                      # safety
            break
    return first_budget, era - 1, total, (era - 1) * era_years


print("=" * 78)
print("MAGI BLOCK TIME — VERIFIED FROM CHAIN")
print("=" * 78)
print("  witnessSchedule slot spacing = 10 Hive blocks, constant across")
print("  heights 100,000,000 -> 109,190,000. Hive block = 3s.")
print(f"  => MAGI block = {MAGI_BLOCK_SECONDS}s. Round = 120 slots = 1 hour.")
print(f"  => blocks per year = {BLOCKS_PER_YEAR:,}")
print()
print("  IMPACT: the spec's '31,536,000 blocks = 3 years' assumed 3s blocks.")
print(f"  At 30s that same block count is {31_536_000 * 30 / (365*86400):.0f} YEARS.")
print("  Emission must be re-denominated or the schedule stretches 10x.")

print()
print("=" * 78)
print("OPTION A — keep 50% halving, 3-year eras, corrected block time")
print("=" * 78)
a, eras, total, years = simulate(3, 1, 2)
print(f"  First era budget : {lc(a)} LC over 3 years")
print(f"  Per-block (era 1): {lc(a // (3 * BLOCKS_PER_YEAR))} LC")
print(f"  Emission ends    : era {eras}, year {years}")
print(f"  Total emitted    : {lc(total)} LC")

print()
print("=" * 78)
print("OPTION B — gentler reduction per era (same 20M cap, same 3-year eras)")
print("=" * 78)
print("  The reduction rate is the real lever on longevity. A smaller cut per")
print("  era stretches emission enormously while the TOTAL stays exactly 20M.")
print("  Cost: lower rewards in the early years.")
print()
print(f"  {'Cut/era':>9}{'Era-1 budget':>20}{'Era-1 LC/block':>18}"
      f"{'Ends (yr)':>12}{'Total emitted':>20}")
print("  " + "-" * 74)
for num, den, label in [(1, 2, "-50%"), (2, 3, "-33%"), (3, 4, "-25%"),
                        (9, 10, "-10%"), (19, 20, "-5%")]:
    a, eras, total, years = simulate(3, num, den)
    pb = a // (3 * BLOCKS_PER_YEAR)
    print(f"  {label:>9}{lc(a):>20}{lc(pb):>18}{years:>12,}{lc(total):>20}")

print()
print("=" * 78)
print("OPTION C — longer eras (for reference; same 50% halving)")
print("=" * 78)
print(f"  {'Era len':>9}{'Era-1 budget':>20}{'Era-1 LC/block':>18}{'Ends (yr)':>12}")
print("  " + "-" * 60)
for ey in [3, 4, 6, 8, 10]:
    a, eras, total, years = simulate(ey, 1, 2)
    pb = a // (ey * BLOCKS_PER_YEAR)
    print(f"  {ey:>7}y{lc(a):>20}{lc(pb):>18}{years:>12,}")

print()
print("=" * 78)
print("COMPARISON: BITCOIN")
print("=" * 78)
btc_years = 0
subsidy = 50 * 10**8            # satoshis
halvings = 0
total_btc = 0
while subsidy > 0:
    total_btc += subsidy * 210_000
    subsidy //= 2
    halvings += 1
print(f"  Bitcoin: 50 BTC subsidy, halving every 210,000 blocks (~4 years),")
print(f"  8 decimals. Subsidy floors to 0 after {halvings} halvings.")
print(f"  Final coin mined ~year 2140 — {2140 - 2026} years from now,")
print(f"  {2140 - 2009} years total from genesis.")
print(f"  Total supply: {total_btc / 10**8:,.8f} BTC (not exactly 21M — same")
print("  integer-flooring dust effect we found in LasseCash).")

print()
print("=" * 78)
print("THE HARD TRUTH ABOUT 'FOREVER'")
print("=" * 78)
print("""  A finite hard cap and perpetual NEW ISSUANCE are mathematically
  incompatible. If total supply is capped at 51M, issuance must terminate.
  Bitcoin has exactly this property: it is not forever either, it ends 2140.

  But 'rewards forever' is a DIFFERENT claim from 'issuance forever' — and
  that one IS achievable, because recycled tokens are not new issuance and
  never touch the cap. LasseCash already has three recycling sources:

    1. Early-mint penalty slash  (50-100% of principal)
    2. The 4-month post-maturity bleed
    3. Full liquidation of positions abandoned past day 120

  All three sweep into the reward pool. That pool can keep paying long after
  the last new token is emitted, funded purely by churn. Emission is the
  BOOTSTRAP; recycling is the PERPETUAL ENGINE.

  Recommendation: stop treating emission length as the thing that makes
  LasseCash 'forever'. Stretch emission enough to bootstrap properly
  (Option B at -10%/era gives ~500 years, which is forever in practice),
  and let recycling carry the reward pool beyond it.""")
