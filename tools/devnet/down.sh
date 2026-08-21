#!/usr/bin/env bash
# down.sh — stop the devnet containers. Chain state is PRESERVED, so up.sh
# resumes the same chain (same contracts, same balances, same block height
# continuation). Use reset.sh for a clean genesis.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

exec > >(tee -a "$LC_DEVNET_LOGDIR/down.log") 2>&1
echo "=== devnet down $(date -Is) ==="
lcdevnet down
