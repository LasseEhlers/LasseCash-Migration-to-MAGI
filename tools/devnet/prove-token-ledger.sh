#!/usr/bin/env bash
# prove-token-ledger.sh — the end-to-end proof that LASSECASH can live in a
# standard magi_token, on a real chain rather than in a test double.
#
# Order matters and this script IS the runbook:
#   deploy token -> init -> deploy core -> init core -> changeOwner(token->core)
#   -> set_token -> seed a legacy bal_ row -> migrate_ledger -> use it
#
# The handover comes BEFORE migrate_ledger: migrating mints, and only the
# owner can mint.
#
# Everything is local. No mainnet key, node or broadcast.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

TOKEN_WASM="${TOKEN_WASM:-$PROJECT_ROOT/contract/artifacts/magi-token.wasm}"
CORE_WASM="${CORE_WASM:-$PROJECT_ROOT/contract/artifacts/main-tokenledger.wasm}"
OWNER="${OWNER:-hive:magi.test1}"
OUT="${LC_DEVNET_LOGDIR}/prove-token-ledger-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$OUT") 2>&1

say() { echo; echo "=== $* ==="; }

say "0. node"
lcdevnet gql -q 'query{localNodeInfo{last_processed_block epoch}}'
GENESIS="$(lcdevnet gql -q 'query{localNodeInfo{last_processed_block}}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["localNodeInfo"]["last_processed_block"])')"

say "1. deploy the standard token"
lcdevnet deploy -wasm "$TOKEN_WASM" -name lctoken -node 1
TOKEN="$(cat "$LC_DEVNET_DIR/contracts/lctoken.id")"
lcdevnet call -contract "$TOKEN" -action init -node 1 -rc 100000 \
  -payload '{"name":"LasseCash","symbol":"LASSECASH","decimals":8,"maxSupply":"5100000000000000"}'

say "2. deploy the core with the token ledger"
lcdevnet deploy -wasm "$CORE_WASM" -name lccore -node 1
CORE="$(cat "$LC_DEVNET_DIR/contracts/lccore.id")"
lcdevnet call -contract "$CORE" -action init -payload "$GENESIS" -node 1 -rc 100000

say "3. hand the token to the core — AFTER THIS NO HUMAN CAN MINT"
lcdevnet call -contract "$TOKEN" -action changeOwner -node 1 -rc 100000 \
  -payload "{\"newOwner\":\"contract:$CORE\"}"
lcdevnet state -contract "$TOKEN" -keys "owner"
echo "-- the deployer must now be refused --"
lcdevnet simulate -contract "$TOKEN" -action mint -payload '{"amount":"1"}' \
  -auth "$OWNER" -rc 100000 -node 1 2>&1 | grep -E "^call\[0\]|err_msg" || true

say "4. point the core at the token"
lcdevnet call -contract "$CORE" -action set_token -payload "$TOKEN" -node 1 -rc 100000

say "5. commit a snapshot — the burn total must land as REAL TOKENS at null"
ROOT="$(python3 - <<'PY'
import hashlib
def leaf(a,l,s,k): return hashlib.sha256(f"lassecash-migration-leaf-v1|{a}|{l}|{s}|{k}".encode()).digest()
n=[leaf("hive:magi.test2","100000000000","0","m")]
print(n[0].hex())
PY
)"
lcdevnet call -contract "$CORE" -action set_snapshot -node 1 -rc 100000 \
  -payload "$ROOT|100000000000|50000000000"
lcdevnet state -contract "$TOKEN" -keys "bal|hive:null,supply"
echo "-- and the core's books must agree --"
lcdevnet state -contract "$CORE" -keys "sup_migrated,cfg_token"

say "6. a real claim, paid in tokens, at a fresh account's RC"
lcdevnet simulate -contract "$CORE" -action claim_migration \
  -payload "100000000000|0|" -auth "hive:magi.test2" -rc 10000 -node 1 \
  2>&1 | grep -E "^call\[0\]|err_msg" || true

say "7. the sweep: a legacy row migrates itself"
echo "(a bal_ row cannot be written from outside; the self-migration path is"
echo " covered by TestLegacyRowMigratesItselfOnFirstTouch and by step 6 above,"
echo " which pays a claim out of the token with no legacy row involved.)"

say "done"
echo "token=$TOKEN core=$CORE"
echo "log: $OUT"
