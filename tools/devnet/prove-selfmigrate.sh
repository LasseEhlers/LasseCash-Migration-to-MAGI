#!/usr/bin/env bash
# prove-selfmigrate.sh — the two migration paths, inside a 10,000 RC budget.
#
# THE POINT: ensureMigrated is what protects real users during the sweep. An
# account that transacts while the migration is half done must move ITSELF
# first and then proceed. Proven in unit tests; never on a chain.
#
# The devnet account has 10,000 RC and no MAGI HBD, so every step is sized and
# the whole run is kept under budget: 3 seeded accounts, not 6.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
OUT="${LC_DEVNET_LOGDIR}/selfmigrate-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$OUT") 2>&1
say() { echo; echo "=== $* ==="; }
ME="hive:magi.test1"

rc() { local g; g="$(lcdevnet simulate -contract "$1" -action "$2" -payload "$3" -auth "$ME" -rc 9000 -node 1 2>&1 |
   grep -oE 'gas_used=[0-9]+' | head -1 | cut -d= -f2)"; [ -z "$g" ] && { echo 500; return; }
  python3 -c "print(max(500,int($g/100000*1.4)))"; }
call() { lcdevnet call -contract "$1" -action "$2" -payload "$3" -node 1 -rc "$(rc "$1" "$2" "$3")" 2>&1 | grep -E "result\[0\]|status: (CON|FAIL)"; }
budget() { lcdevnet gql -q "query{ getAccountRC(account:\"$ME\"){ amount } }" | grep -oE '[0-9]+' | head -1; }

G="$(lcdevnet gql -q 'query{localNodeInfo{last_processed_block}}' | grep -oE '[0-9]+' | head -1)"
lcdevnet deploy -wasm "$PROJECT_ROOT/contract/artifacts/magi-token.wasm" -name stok -node 1 >/dev/null 2>&1
TOKEN="$(cat "$LC_DEVNET_DIR/contracts/stok.id")"
lcdevnet deploy -wasm "$PROJECT_ROOT/contract/artifacts/main-tokenledger-push.wasm" -name score -node 1 >/dev/null 2>&1
CORE="$(cat "$LC_DEVNET_DIR/contracts/score.id")"
echo "token=$TOKEN core=$CORE genesis=$G  RC=$(budget)"

say "setup"
call "$TOKEN" init '{"name":"LasseCash","symbol":"LASSECASH","decimals":8,"maxSupply":"5100000000000000"}'
call "$CORE" init "$G"
# The deploy account gets a legacy row TOO, so it can prove self-migration.
call "$CORE" migrate_batch "$ME,50000000000,0|hive:m01,1,0|hive:m02,999999999999,0"
lcdevnet state -contract "$CORE" -keys "bal_$ME,bal_hive:m01,bal_hive:m02,sup_migrated"
echo "RC left: $(budget)"

say "switch the ledger"
call "$TOKEN" changeOwner "{\"newOwner\":\"contract:$CORE\"}"
call "$CORE" set_token "$TOKEN"
echo "RC left: $(budget)"

say "THE TEST — an account with a LEGACY row transacts. It must migrate itself."
call "$TOKEN" increaseAllowance "{\"spender\":\"contract:$CORE\",\"amount\":\"100000000\"}"
call "$CORE" transfer "hive:m09|100000000"
echo "--- the legacy row must be GONE and the token must hold the rest ---"
lcdevnet state -contract "$CORE" -keys "bal_$ME"
for a in "$ME" hive:m09; do printf '%-22s ' "$a"
  lcdevnet simulate -contract "$TOKEN" -action balanceOf -payload "{\"account\":\"$a\"}" -auth "$ME" -rc 9000 -node 1 \
    2>&1 | grep -oE '\{.\"balance[^}]*\}' | head -1; done
echo "RC left: $(budget)"

say "THE SWEEP — the owner moves the accounts that never showed up"
call "$CORE" migrate_ledger "hive:m01|hive:m02"
lcdevnet state -contract "$CORE" -keys "bal_hive:m01,bal_hive:m02,sup_migrated"
for a in hive:m01 hive:m02; do printf '%-22s ' "$a"
  lcdevnet simulate -contract "$TOKEN" -action balanceOf -payload "{\"account\":\"$a\"}" -auth "$ME" -rc 9000 -node 1 \
    2>&1 | grep -oE '\{.\"balance[^}]*\}' | head -1; done
printf '%-22s ' "totalSupply"
lcdevnet simulate -contract "$TOKEN" -action totalSupply -payload "" -auth "$ME" -rc 9000 -node 1 \
  2>&1 | grep -oE '\{.\"totalSupply[^}]*\}' | head -1
echo "RC left: $(budget)"
echo; echo "log: $OUT"
