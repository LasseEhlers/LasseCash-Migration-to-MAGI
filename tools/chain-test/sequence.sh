#!/usr/bin/env bash
#
# The verified on-chain test sequence for the throwaway contract.
#
# One call at a time, and after each: wait until the STATE the call should
# have written is READABLE, not merely until an output exists. The night of
# 2026-08-21 proved an output's ok:true can lie (rc_limit freeze discarded
# state after a "successful" init), so readable state is the only standard.
#
# Each call uses rc_limit 1500 — small enough that a full run leaves headroom,
# because the FULL limit freezes for MAGI's 5-day thaw.
set -euo pipefail
cd "$(dirname "$0")/../.."

# ⚠️ UPDATE THIS after the next deploy — this id is throwaway #2 (slashed
# keys, state can never persist). The rekeyed TESTWINDOWS deploy gets a new id,
# which must also replace the pinned CONTRACT in call.js.
CID=vsc1BoLgTEZhcQKSGi9vCZN12yVjmM4mnvWrLB
GQL=https://api.vsc.eco/api/v1/graphql

state() { # state <key> -> value or "null"
  curl -s -X POST "$GQL" -H 'Content-Type: application/json' \
    -d "{\"query\":\"{ getStateByKeys(contractId:\\\"$CID\\\", keys:[\\\"$1\\\"]) }\"}" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data']['getStateByKeys'].get('$1'))"
}

step() { # step <name> <key-to-await> <expect-substr> <action> <payload> <rc_limit>
  local name=$1 key=$2 expect=$3 action=$4 payload=$5 rc=${6:-1500}
  echo "==> $name (rc_limit $rc)"
  node tools/chain-test/call.js "$action" "$payload" "$rc"
  for i in $(seq 1 40); do
    v=$(state "$key")
    if [ "$v" != "None" ] && [ -n "$v" ] && { [ -z "$expect" ] || [[ "$v" == *"$expect"* ]]; }; then
      echo "    verified: $key = $v"
      return 0
    fi
    sleep 15
  done
  echo "    FAILED: $key never became readable — diagnose via getDagByCID on the output"
  exit 1
}

# init is done separately (it is what the caller just verified).
# rc_limit sizing, measured (100,000 gas = 1 RC): transfer ~280, migrate ~650,
# mint ~2,500+the accrual walk. Freezing a limit parks it for 5 days, so each
# step gets what it needs and little more.
if [ "$(state bal_hive:lassecashmagi)" = "None" ]; then
  step "migrate 10,000 LC to self" "bal_hive:lassecashmagi" "" \
    migrate "hive:lassecashmagi|1000000000000|0" 1500
fi
step "mint 5,000 LC for 30 days" "mint_hive:lassecashmagi_1" "" \
  mint "500000000000|30" 6000
step "transfer 1 LC to lasseehlers" "bal_hive:lasseehlers" "100000000" \
  transfer "hive:lasseehlers|100000000" 1500

echo
echo "ALL VERIFIED. Real, readable state on MAGI mainnet:"
for k in cfg_init sup_migrated shares_total shr_hive:lassecashmagi \
         bal_hive:lassecashmagi bal_hive:lasseehlers acc_day; do
  echo "  $k = $(state "$k")"
done
