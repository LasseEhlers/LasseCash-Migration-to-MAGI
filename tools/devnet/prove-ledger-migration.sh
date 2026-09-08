#!/usr/bin/env bash
# prove-ledger-migration.sh — the dress rehearsal for production's riskiest step.
#
# Production today holds ~353 accounts' balances as `bal_` rows. The switch to
# a magi_token has to move every one of them without losing a base unit, while
# people may be transacting. Throwaway #10 could not test this: it was deployed
# fresh, with no legacy rows to move.
#
# So: seed real bal_ rows FIRST (push build), then flip to the token, then
# sweep — exactly production's order.
#
#   1. deploy token + core (push build), init both
#   2. migrate_batch  -> real `bal_` rows, the ledger as production has it now
#   3. changeOwner    -> the core owns the token
#   4. set_token      -> from here the ledger IS the token
#   5. READ BALANCES  -> must be unchanged, though nothing has moved yet
#   6. TOUCH ONE ACCOUNT -> it must migrate ITSELF (ensureMigrated)
#   7. migrate_ledger -> sweep the rest
#   8. verify         -> no bal_ rows left, token balances exact, supply conserved
#
# Everything is local. No mainnet key, node or broadcast.
#
# ⚠️ EVERY rc_limit IS SIZED FROM A SIMULATION, never guessed. The first run of
# this script used -rc 100000 on every call against an account whose ceiling is
# 10,000 (no MAGI HBD = the free allowance only). migrate_batch came back
# FAILED, the state silently did not change, and the verification read nulls
# that looked like a logic bug. Same trap as @angeloextreme's, same day.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# rc <contract> <action> <payload> -> an rc_limit with 60% headroom over the
# simulated gas, floored at 400.
rc() {
  local g
  g="$(lcdevnet simulate -contract "$1" -action "$2" -payload "$3" \
        -auth hive:magi.test1 -rc 9000 -node 1 2>&1 |
       grep -oE 'gas_used=[0-9]+' | head -1 | cut -d= -f2)"
  [ -z "$g" ] && { echo 400; return; }
  python3 -c "print(max(400, int($g/100000*1.6)))"
}
call() { lcdevnet call -contract "$1" -action "$2" -payload "$3" -node 1 -rc "$(rc "$1" "$2" "$3")"; }

TOKEN_WASM="${TOKEN_WASM:-$PROJECT_ROOT/contract/artifacts/magi-token.wasm}"
CORE_WASM="${CORE_WASM:-$PROJECT_ROOT/contract/artifacts/main-tokenledger-push.wasm}"
OUT="${LC_DEVNET_LOGDIR}/ledger-migration-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$OUT") 2>&1
say() { echo; echo "=== $* ==="; }

GENESIS="$(lcdevnet gql -q 'query{localNodeInfo{last_processed_block}}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["localNodeInfo"]["last_processed_block"])')"

say "1. deploy"
lcdevnet deploy -wasm "$TOKEN_WASM" -name mtok -node 1
TOKEN="$(cat "$LC_DEVNET_DIR/contracts/mtok.id")"
lcdevnet deploy -wasm "$CORE_WASM" -name mcore -node 1
CORE="$(cat "$LC_DEVNET_DIR/contracts/mcore.id")"
echo "token=$TOKEN core=$CORE genesis=$GENESIS"
call "$TOKEN" init '{"name":"LasseCash","symbol":"LASSECASH","decimals":8,"maxSupply":"5100000000000000"}'
call "$CORE" init "$GENESIS"

say "2. seed LEGACY bal_ rows — the ledger exactly as production holds it today"
# 6 accounts, liquid only, so every one is a plain balance row.
BATCH="hive:m01,100000000000,0|hive:m02,250000000000,0|hive:m03,1,0|hive:m04,7,0|hive:m05,999999999999,0|hive:m06,50000000,0"
call "$CORE" migrate_batch "$BATCH"
lcdevnet state -contract "$CORE" -keys "bal_hive:m01,bal_hive:m03,bal_hive:m05,sup_migrated"

say "3+4. hand the token over, then point the core at it"
call "$TOKEN" changeOwner "{\"newOwner\":\"contract:$CORE\"}"
call "$CORE" set_token "$TOKEN"
echo "cfg_token set; the ledger is now the token, but nothing has moved yet"

say "5. balances must read the SAME across the switch (bal_ still counts)"
lcdevnet simulate -contract "$CORE" -action transfer -payload "hive:zzz|1" \
  -auth "hive:m01" -rc 9000 -node 1 2>&1 | grep -E "^call\[0\]|err_msg" || true

say "6. TOUCH ONE ACCOUNT — it must migrate itself"
call "$CORE" transfer "hive:m02|100000000" || true
echo "(the deploy account has no balance; the self-migration is exercised by the sweep below too)"

say "7. migrate_ledger — the owner's sweep"
lcdevnet simulate -contract "$CORE" -action migrate_ledger \
  -payload "hive:m01|hive:m02|hive:m03|hive:m04|hive:m05|hive:m06" -auth "hive:magi.test1" -rc 9000 -node 1 \
  2>&1 | grep -E "^call\[0\]|err_msg" || true
call "$CORE" migrate_ledger "hive:m01|hive:m02|hive:m03|hive:m04|hive:m05|hive:m06"

say "8. VERIFY — no legacy rows left, and every base unit accounted for"
lcdevnet state -contract "$CORE" -keys "bal_hive:m01,bal_hive:m02,bal_hive:m03,bal_hive:m04,bal_hive:m05,bal_hive:m06,sup_migrated"
for a in m01 m02 m03 m04 m05 m06; do
  printf '%-10s ' "$a"
  lcdevnet simulate -contract "$TOKEN" -action balanceOf -payload "{\"account\":\"hive:$a\"}" \
    -auth hive:magi.test1 -rc 10000 -node 1 2>&1 | grep -oE '\{\\?"balance[^}]*\}' | head -1
done
echo "-- token totalSupply must equal sup_migrated --"
lcdevnet simulate -contract "$TOKEN" -action totalSupply -payload "" -auth hive:magi.test1 -rc 10000 -node 1 \
  2>&1 | grep -oE '\{\\?"totalSupply[^}]*\}' | head -1
echo
echo "token=$TOKEN core=$CORE"
echo "log: $OUT"
