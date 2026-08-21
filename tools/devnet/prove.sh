#!/usr/bin/env bash
# prove.sh — end-to-end proof that the local devnet runs the real LasseCash
# contract, and the measurement harness for migrate_batch gas.
#
# Sequence:
#   1. localNodeInfo   — the node's GraphQL answers and the chain is advancing
#   2. deploy          — contract/artifacts/main.wasm onto the devnet
#   3. call init       — owner-only, <genesisHeight>
#   4. getStateByKeys  — read cfg_init / cfg_genesis / cfg_settled back
#   5. simulate migrate_batch across batch sizes, printing gas_used and
#      rc_used for each. Two shapes, because they cost wildly different
#      amounts: accounts WITH staked POWER (each creates a migration mint)
#      and accounts with LIQUID ONLY.
#   6. real broadcasts, sized to the caller's actual RC, then read the
#      migrated balances and L-Shares back out of contract state
#
# Everything is local. No mainnet key, node or broadcast is involved.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

WASM="${WASM:-$PROJECT_ROOT/contract/artifacts/main.wasm}"
NAME="${NAME:-lassecash}"
OUT="${LC_DEVNET_LOGDIR}/prove-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$OUT") 2>&1

# Batch sizes to measure. Override with e.g. SIZES="1 5 25".
SIZES="${SIZES:-1 2 3 5 10 15 20 22 24 25 30 50}"

BATCHDIR="$LC_DEVNET_HOME/batches"
mkdir -p "$BATCHDIR"
python3 - "$BATCHDIR" "$SIZES" <<'PY'
import sys
d, sizes = sys.argv[1], sys.argv[2].split()
for n in (int(x) for x in sizes):
    # 1.00000000 LC liquid + 0.50000000 LC staked POWER per account
    open(f"{d}/batch{n}.txt", "w").write(
        "|".join(f"hive:lctest{i:04d},100000000,50000000" for i in range(n)))
    # liquid only — no migration mint
    open(f"{d}/liq{n}.txt", "w").write(
        "|".join(f"hive:lcliq{i:04d},100000000,0" for i in range(n)))
PY

echo "=== 1. node info ==="
lcdevnet gql -q 'query{localNodeInfo{last_processed_block epoch}}'

echo
echo "=== 2. deploy $WASM ($(stat -c%s "$WASM") bytes) ==="
lcdevnet deploy -wasm "$WASM" -name "$NAME" -node 1
CID="$(cat "$LC_DEVNET_DIR/contracts/$NAME.id")"
OWNER="hive:magi.test1"
echo "contract=$CID owner=$OWNER"

echo
echo "=== 3. init ==="
GENESIS="$(lcdevnet gql -q 'query{localNodeInfo{last_processed_block}}' \
           | python3 -c 'import json,sys;print(json.load(sys.stdin)["localNodeInfo"]["last_processed_block"])')"
echo "genesis height: $GENESIS"
lcdevnet call -contract "$CID" -action init -payload "$GENESIS" -node 1 -rc 100000

echo
echo "=== 4. read cfg_init back ==="
lcdevnet state -contract "$CID" -keys cfg_init,cfg_genesis,cfg_settled

echo
echo "=== 5a. migrate_batch gas — accounts WITH staked POWER (creates a mint) ==="
for n in $SIZES; do
  printf '%-4s ' "$n"
  lcdevnet simulate -contract "$CID" -action migrate_batch \
    -payload-file "$BATCHDIR/batch$n.txt" -auth "$OWNER" -rc 100000 -node 1 \
    2>&1 | grep -E "^call\[0\]|err_msg" | tr '\n' ' '
  echo
done

echo
echo "=== 5b. migrate_batch gas — LIQUID ONLY (no mint) ==="
for n in $SIZES; do
  printf '%-4s ' "$n"
  lcdevnet simulate -contract "$CID" -action migrate_batch \
    -payload-file "$BATCHDIR/liq$n.txt" -auth "$OWNER" -rc 100000 -node 1 \
    2>&1 | grep -E "^call\[0\]|err_msg" | tr '\n' ' '
  echo
done

echo
echo "=== 6. real broadcasts ==="
echo "RC available to $OWNER:"
lcdevnet gql -q 'query{getAccountRC(account:"hive:magi.test1"){amount max_rcs}}'
echo "-- 25 liquid-only accounts (~6,805 RC) --"
lcdevnet call -contract "$CID" -action migrate_batch \
  -payload "$(cat "$BATCHDIR/liq25.txt")" -node 1 -rc 7000
echo "-- 1 staked account (~2,605 RC) — proves the migration-mint path --"
lcdevnet call -contract "$CID" -action migrate_batch \
  -payload "hive:lcstake0001,100000000,50000000" -node 1 -rc 2800

echo
echo "=== 7. read migrated state back ==="
lcdevnet state -contract "$CID" \
  -keys "bal_hive:lcliq0000,bal_hive:lcliq0024,bal_hive:lcstake0001,shr_hive:lcstake0001,gov_board,sup_migrated"

echo
echo "log: $OUT"
