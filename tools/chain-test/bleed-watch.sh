#!/usr/bin/env bash
# Autonomous mid-bleed observation for mint #2 (the deliberately abandoned one).
#
# Waits out maturity (+6min) and grace (+3h), then to the bleed's midpoint
# (+4.5h more), SIMULATES the claim to get the chain's predicted mid-bleed
# payout, claims for real, and verifies: the payout matches the prediction,
# roughly half the value is gone, and the slashed half swept into the L-Share
# pool rather than vanishing. The last real-chain observation the core
# economics needed.
set -euo pipefail
cd "$(dirname "$0")/../.."
CID=vsc1BqLfLpKdMSfmHCe4o15ssWMiWJZw3yoZ8C
GQL=https://api.vsc.eco/api/v1/graphql

gql() { curl -s -X POST "$GQL" -H 'Content-Type: application/json' -d "$1"; }
state() {
  gql "{\"query\":\"{ getStateByKeys(contractId:\\\"$CID\\\", keys:[\\\"$1\\\"]) }\"}" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['getStateByKeys'].get('$1') or '')"
}
height() {
  gql '{"query":"{ localNodeInfo { last_processed_block } }"}' \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['localNodeInfo']['last_processed_block'])"
}

# 1. Wait for the mint record, extract its start height.
until REC=$(state "mint_hive:lassecashmagi_2") && [ -n "$REC" ]; do sleep 20; done
START=$(echo "$REC" | cut -d'|' -f3)
# 1-day lock, 30d grace, 90d bleed, at 120 heights/testwindows-day.
TARGET=$(( START + 120 + 3600 + 5400 ))   # bleed midpoint ≈ 50% remaining
echo "mint #2 start=$START; claiming mid-bleed at height $TARGET"

# 2. Wait for the midpoint (hours; poll gently).
until H=$(height) && [ "${H:-0}" -ge "$TARGET" ]; do sleep 600; done

# 3. The chain's own prediction, then the real claim.
BAL0=$(state "bal_hive:lassecashmagi")
POOL0=$(state "pool_lshare")
PRED=$(gql "{\"query\":\"query(\$i: SimulateContractCallsInput!){ simulateContractCalls(input:\$i){ ret } }\",\"variables\":{\"i\":{\"tx_id\":\"sim\",\"required_auths\":\"hive:lassecashmagi\",\"calls\":[{\"contract_id\":\"$CID\",\"action\":\"claim_mint\",\"payload\":\"2\",\"rc_limit\":100000}]}}}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['simulateContractCalls'][0]['ret'])")
echo "prediction at height $(height): $PRED   (balance $BAL0, pool $POOL0)"
node tools/chain-test/call.js claim_mint "2" 3000

# 4. Verify the record ends and report the deltas.
until REC=$(state "mint_hive:lassecashmagi_2") && [ "$(echo "$REC" | cut -d'|' -f6)" = "1" ]; do sleep 20; done
BAL1=$(state "bal_hive:lassecashmagi")
POOL1=$(state "pool_lshare")
echo "MID-BLEED CLAIM SETTLED"
echo "  predicted: $PRED"
echo "  balance:   $BAL0 -> $BAL1  (delta $(( BAL1 - BAL0 )))"
echo "  L-pool:    $POOL0 -> $POOL1  (delta $(( POOL1 - POOL0 )))"
echo "Verify: delta(balance) matches the predicted figure; the missing value"
echo "appears in the pool delta (plus that block's emission slice)."
