"""
LasseCash emission / hardcap verification.
All math in BASE UNITS (integers). 1 LC = 100_000_000 units (8 decimals).
No floats anywhere in the accounting path.
"""

DEC = 8
UNIT = 10 ** DEC                      # base units per 1 LC
BLOCK_SECONDS = 3
ERA_BLOCKS = 31_536_000               # "3 years" as defined in the spec
ERA_1_EMISSION = 10_000_000 * UNIT    # 10M LC in era 1
EMISSION_CAP = 20_000_000 * UNIT      # new post-migration cap
HISTORIC_HARDCAP = 51_000_000 * UNIT

def lc(units):
    """Format base units as an exact decimal LC string."""
    sign = "-" if units < 0 else ""
    units = abs(units)
    return f"{sign}{units // UNIT}.{units % UNIT:0{DEC}d}"

print("=" * 74)
print("1. ERA LENGTH")
print("=" * 74)
secs = ERA_BLOCKS * BLOCK_SECONDS
days = secs / 86400
print(f"  {ERA_BLOCKS:,} blocks x {BLOCK_SECONDS}s = {secs:,}s = {days:g} days")
print(f"  -> spec calls this '3 years'; 1095 days = 3 x 365, ignores leap days.")
print(f"  -> a real 3-year span usually contains 1 leap day (1096 days),")
print(f"     so each halving lands ~1 day EARLY vs the calendar. Cumulative")
print(f"     drift over 25 eras: ~6 days. Harmless, but it is a real drift.")

print()
print("=" * 74)
print("2. PER-BLOCK REWARD PER ERA (exact integer division)")
print("=" * 74)
print(f"  {'Era':<5}{'Years':<10}{'Budget (LC)':>18}{'Units/block':>14}"
      f"{'LC/block':>14}{'Stranded':>14}")
print("  " + "-" * 70)

total_emitted = 0
total_stranded = 0
era = 0
budget = ERA_1_EMISSION
rows = []
while True:
    era += 1
    per_block = budget // ERA_BLOCKS          # floor: never over-issue
    if per_block == 0:
        print(f"  Era {era}: per-block reward floors to 0 units. Emission ends.")
        print(f"  -> effective end of emission: year {(era - 1) * 3}")
        total_stranded += budget
        break
    emitted = per_block * ERA_BLOCKS
    stranded = budget - emitted               # dust that is never issued
    total_emitted += emitted
    total_stranded += stranded
    if era <= 6 or era >= 23:
        rows.append((era, f"{(era-1)*3+1}-{era*3}", budget, per_block,
                     emitted, stranded))
    if era == 7:
        rows.append(None)
    budget //= 2                              # integer halving

for r in rows:
    if r is None:
        print(f"  {'...':<5}{'...':<10}{'...':>18}{'...':>14}{'...':>14}{'...':>14}")
        continue
    e, yrs, bud, pb, em, st = r
    print(f"  {e:<5}{yrs:<10}{lc(bud):>18}{pb:>14,}{lc(pb):>14}{lc(st):>14}")

print()
print(f"  Total actually emitted : {lc(total_emitted):>20} LC")
print(f"  Cap                    : {lc(EMISSION_CAP):>20} LC")
print(f"  Shortfall (never made) : {lc(EMISSION_CAP - total_emitted):>20} LC")
assert total_emitted <= EMISSION_CAP, "EMISSION EXCEEDS CAP"
print(f"  -> emission is UNDER cap. Flooring always errs downward. Correct")
print(f"     direction: the cap can never be breached by rounding.")

print()
print("=" * 74)
print("3. DOC'S QUOTED FIGURES vs EXACT")
print("=" * 74)
doc = {1: "0.317", 2: "0.158", 3: "0.079", 4: "0.039"}
budget = ERA_1_EMISSION
print(f"  {'Era':<5}{'Doc says':>12}{'Exact (8dp)':>16}{'Correct 3dp':>14}   Note")
print("  " + "-" * 70)
for e in range(1, 5):
    pb = budget // ERA_BLOCKS
    exact = pb / UNIT
    note = "ok" if f"{exact:.3f}" == doc[e] else f"doc truncated, should be {exact:.3f}"
    print(f"  {e:<5}{doc[e]:>12}{lc(pb):>16}{exact:>14.3f}   {note}")
    budget //= 2

print()
print("=" * 74)
print("4. ANNUAL EMISSION")
print("=" * 74)
budget = ERA_1_EMISSION
for e in range(1, 5):
    annual = budget // 3
    print(f"  Years {(e-1)*3+1}-{e*3}: {lc(budget):>16} LC / 3 = {lc(annual):>16} LC per year")
    budget //= 2

print()
print("=" * 74)
print("5. GEOMETRIC SERIES: does the halving schedule sum to 20M?")
print("=" * 74)
print("  Ideal sum = 10M / (1 - 1/2) = 20M exactly -- but only as a LIMIT.")
print("  The series APPROACHES 20M and never reaches it. The spec's own")
print("  wording ('20M forever thereafter asymptotically') matches this.")
print(f"  With integer floors, emission terminates at era {era} and tops out at:")
print(f"      {lc(total_emitted)} LC  ({lc(EMISSION_CAP - total_emitted)} LC short of 20M)")

print()
print("=" * 74)
print("6. 51M HARDCAP -- REQUIRES SNAPSHOT NUMBERS")
print("=" * 74)
print("  Total ever in existence = migrated_supply + emitted(<=20M)")
print()
print("  where migrated_supply = liquid_migrated + power_migrated")
print("        (dead/dust accounts and the @lassecash remainder are BURNED,")
print("         i.e. never migrated -- they reduce migrated_supply)")
print()
print("  Constraint that MUST hold:")
print(f"      migrated_supply <= {lc(HISTORIC_HARDCAP - EMISSION_CAP)} LC  (= 51M - 20M)")
print()
print("  >>> I cannot verify this without the real snapshot figures. <<<")
print("  Needed: liquid + power totals for QUALIFYING accounts only,")
print("          at snapshot height, in base units.")
print()
print("  Sanity check against the historic model in the spec:")
print("    11M founder + 20M (first-decade inflation) = 31M issued to date")
print("    51M - 31M = 20M headroom  ==  the new emission cap. Consistent.")
print("    BUT: the spec says the first-decade 20M ran out in ~7 years, and")
print("    that its REMAINDER is burned. Both cannot be true at once -- if it")
print("    was exhausted there is no remainder to burn. Needs the real number.")
