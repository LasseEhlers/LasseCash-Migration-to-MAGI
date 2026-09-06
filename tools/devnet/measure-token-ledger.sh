#!/usr/bin/env bash
# measure-token-ledger.sh — what does a cross-contract token call COST?
#
# The go/no-go for moving LASSECASH's ledger into a standard `magi_token`
# (docs/STANDARD-TOKEN-SPIKE.md). Today `claim_migration` costs 4,017-5,892 RC
# against a fresh account's free 10,000. If a credit becomes a call into
# another contract, the claim grows by (calls x marginal cost). Under 10,000
# the claim-based migration survives; over it, every unclaimed holder has to
# buy HBD first — the exact thing the pull model exists to avoid.
#
# Marginal costs come from a SUBTRACTION so the fixed entry overhead cancels:
#     marginal = (gas(n=5) - gas(n=1)) / 4
#
# Everything is local. No mainnet key, node or broadcast.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

TOKEN_WASM="${TOKEN_WASM:-$PROJECT_ROOT/contract/artifacts/magi-token.wasm}"
PROBE_WASM="${PROBE_WASM:-$PROJECT_ROOT/contract/artifacts/probe.wasm}"
OWNER="${OWNER:-hive:magi.test1}"
OUT="${LC_DEVNET_LOGDIR}/token-ledger-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$OUT") 2>&1

echo "=== 0. node ==="
lcdevnet gql -q 'query{localNodeInfo{last_processed_block epoch}}'

echo
echo "=== 1. deploy the STANDARD TOKEN ($(stat -c%s "$TOKEN_WASM") bytes) ==="
lcdevnet deploy -wasm "$TOKEN_WASM" -name magitoken -node 1
TOKEN="$(cat "$LC_DEVNET_DIR/contracts/magitoken.id")"
echo "token=$TOKEN"

echo
echo "=== 2. deploy the PROBE ($(stat -c%s "$PROBE_WASM") bytes) ==="
lcdevnet deploy -wasm "$PROBE_WASM" -name probe -node 1
PROBE="$(cat "$LC_DEVNET_DIR/contracts/probe.id")"
echo "probe=$PROBE"

echo
echo "=== 3. init the token (owner = $OWNER) ==="
lcdevnet call -contract "$TOKEN" -action init -node 1 -rc 100000 \
  -payload '{"name":"LasseCash","symbol":"LASSECASH","decimals":8,"maxSupply":"5100000000000000"}'

echo
echo "=== 4. mint to the owner, then fund the probe so its transfers succeed ==="
lcdevnet call -contract "$TOKEN" -action mint -node 1 -rc 100000 -payload '{"amount":"100000000000000"}'
lcdevnet call -contract "$TOKEN" -action transfer -node 1 -rc 100000 \
  -payload "{\"to\":\"contract:$PROBE\",\"amount\":\"10000000000000\"}"
lcdevnet state -contract "$TOKEN" -keys "bal|$OWNER,bal|contract:$PROBE,owner,supply"

echo
echo "=== 5. THE MEASUREMENT — gas per shape, n=1 and n=5 ==="
echo "    (a cross-contract call is what a credit becomes; a local write is what it costs today)"
for action in noop write_n call_n read_n; do
  for n in 1 5; do
    printf '%-8s n=%-2s ' "$action" "$n"
    lcdevnet simulate -contract "$PROBE" -action "$action" \
      -payload "$n|$TOKEN|hive:lctarget|1000" -auth "$OWNER" -rc 100000 -node 1 \
      2>&1 | grep -E "^call\[0\]|err_msg" | tr '\n' ' '
    echo
  done
done

echo
echo "=== 6. can the token be OWNED BY A CONTRACT? (the whole design rests on it) ==="
lcdevnet call -contract "$TOKEN" -action changeOwner -node 1 -rc 100000 \
  -payload "{\"newOwner\":\"contract:$PROBE\"}"
lcdevnet state -contract "$TOKEN" -keys "owner"
echo "-- the old human owner must now be REFUSED a mint --"
lcdevnet simulate -contract "$TOKEN" -action mint -payload '{"amount":"1"}' \
  -auth "$OWNER" -rc 100000 -node 1 2>&1 | grep -E "^call\[0\]|err_msg" || true

echo
echo "token=$TOKEN probe=$PROBE"
echo "log: $OUT"
