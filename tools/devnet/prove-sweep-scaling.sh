#!/usr/bin/env bash
# prove-sweep-scaling.sh — is migrate_ledger LINEAR in batch size?
#
# WHY THIS MATTERS: in August migrate_batch was found to be SUPERLINEAR
# (6.1M*n^2 + 226M*n) because every account re-read and rewrote the 20-seat
# board. A 50-account batch could not execute at all until it was fixed. The
# production sweep plans batches of ~50, so migrate_ledger must be checked the
# same way rather than assumed.
#
# Seeding costs RC; MEASURING does not, because simulateContractCalls is free.
# So: seed once, then simulate every batch size.
#
# ⚠️ 2026-09-06: the first version of this script ran every owner call from
# node 1 and printed its table WITHOUT CHECKING THE SEED. node 1's meter
# (10,000 RC, no HBD on the devnet) ran out during the deploys, migrate_batch
# and set_token both returned ok=false, and migrate_ledger was then measured
# against accounts holding NOTHING with no token configured. The table looked
# like a clean pass — gas flat at ~1.0M, RC/account falling 10.2 -> 0.6 — and
# it was measuring an empty parse. Two fixes below, both load-bearing:
#   1. the owner calls are SPLIT ACROSS NODES so no single 10,000-RC meter
#      carries the whole seeding;
#   2. every seeding call is CHECKED, and the seed is verified by reading a
#      balance back, before a single number is printed.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
OUT="${LC_DEVNET_LOGDIR}/sweep-scaling-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$OUT") 2>&1

N_SEED="${N_SEED:-8}"          # accounts to seed; sized to fit one 10,000-RC meter
TOKEN_NODE=3                   # owns the magi_token
CORE_NODE=2                    # owns the core contract
ME="hive:magi.test${CORE_NODE}"

rcof() { "$LC_DEVNET_BIN" gql -q "query{ getAccountRC(account:\"hive:magi.test$1\"){ amount } }" |
         grep -oE '[0-9]+' | head -1; }

# Every seeding call goes through here. A failed call ABORTS — it must never
# again be possible to measure a chain that was not actually seeded.
must() { # must <node> <contract> <action> <payload>
  local node="$1" c="$2" a="$3" p="$4" out
  out="$("$LC_DEVNET_BIN" call -contract "$c" -action "$a" -payload "$p" -node "$node" -rc 9000 2>&1 |
         grep -E 'result\[0\]' || true)"
  echo "  node$node $a -> $out"
  case "$out" in
    *"ok=true"*) : ;;
    *) echo "SEEDING FAILED at '$a' (node$node RC left: $(rcof "$node")). Nothing measured." >&2; exit 1 ;;
  esac
}

G="$("$LC_DEVNET_BIN" gql -q 'query{localNodeInfo{last_processed_block}}' | grep -oE '[0-9]+' | head -1)"
echo "devnet height $G · RC: node$TOKEN_NODE=$(rcof $TOKEN_NODE) node$CORE_NODE=$(rcof $CORE_NODE)"

"$LC_DEVNET_BIN" deploy -wasm "$PROJECT_ROOT/contract/artifacts/magi-token.wasm" -name ktok -node "$TOKEN_NODE" >/dev/null 2>&1
TOKEN="$(cat "$LC_DEVNET_DIR/contracts/ktok.id")"
"$LC_DEVNET_BIN" deploy -wasm "$PROJECT_ROOT/contract/artifacts/main-tokenledger-push.wasm" -name kcore -node "$CORE_NODE" >/dev/null 2>&1
CORE="$(cat "$LC_DEVNET_DIR/contracts/kcore.id")"
echo "token=$TOKEN (node$TOKEN_NODE) core=$CORE (node$CORE_NODE)"

must "$TOKEN_NODE" "$TOKEN" init '{"name":"LasseCash","symbol":"LASSECASH","decimals":8,"maxSupply":"5100000000000000"}'
must "$CORE_NODE"  "$CORE"  init "$G"

# Liquid-only accounts: the cheapest possible seeding, so the RC budget goes
# on state rather than on mints.
SEED="$(python3 -c "print('|'.join(f'hive:k{i:02d},100000000,0' for i in range($N_SEED)))")"
must "$CORE_NODE" "$CORE" migrate_batch "$SEED"
must "$TOKEN_NODE" "$TOKEN" changeOwner "{\"newOwner\":\"contract:$CORE\"}"
must "$CORE_NODE"  "$CORE"  set_token "$TOKEN"
echo "RC left: node$TOKEN_NODE=$(rcof $TOKEN_NODE) node$CORE_NODE=$(rcof $CORE_NODE)"

# ── The seed must be REAL before anything is measured ────────────────────────
# A legacy row is what migrate_ledger moves. If bal_ is empty the sweep has
# nothing to do and every gas figure below is a measurement of parsing.
echo
echo "verifying the seed..."
BAL="$("$LC_DEVNET_BIN" gql -q "query{ getStateByKeys(contractId:\"$CORE\", keys:[\"bal_hive:k00\",\"cfg_token\"]) }" 2>&1)"
echo "$BAL"
case "$BAL" in
  *100000000*) : ;;
  *) echo "ABORT: bal_hive:k00 does not hold the seeded 1 LASSECASH — nothing to sweep." >&2; exit 1 ;;
esac
case "$BAL" in
  *"$TOKEN"*) : ;;
  *) echo "ABORT: cfg_token is not set to $TOKEN — migrate_ledger would be a no-op." >&2; exit 1 ;;
esac

echo
echo "=== migrate_ledger gas by batch size (simulated — free) ==="
printf '%4s %16s %10s %14s\n' "n" "gas" "RC" "RC/account"
for n in $(python3 -c "
n=1
out=[]
while n <= $N_SEED:
    out.append(str(n)); n*=2
print(' '.join(out))"); do
  P="$(python3 -c "print('|'.join(f'hive:k{i:02d}' for i in range($n)))")"
  RAW="$("$LC_DEVNET_BIN" simulate -contract "$CORE" -action migrate_ledger -payload "$P" -auth "$ME" -rc 100000 -node 1 2>&1)"
  g="$(echo "$RAW" | grep -oE 'gas_used=[0-9]+' | head -1 | cut -d= -f2)"
  if [ -z "$g" ]; then echo "  simulate returned no gas for n=$n:"; echo "$RAW" | head -5; continue; fi
  case "$RAW" in *"success=false"*|*"err"*) echo "  ⚠️  n=$n simulation reports a failure:"; echo "$RAW" | head -3 ;; esac
  python3 -c "
g=$g; n=$n
print(f'{n:4d} {g:16,} {g/100000:10.0f} {g/100000/n:14.1f}')"
done

echo
echo "LINEAR means RC/account stays flat as n grows. Rising = superlinear = the"
echo "August bug's shape, and the production batch size must come down."
echo "log: $OUT"
