#!/usr/bin/env bash
# up.sh — bring the local MAGI devnet up. Idempotent.
#
# First run provisions everything (docker image build, HAF Hive testnet from
# genesis, MongoDB, hafah/drone API stack, N magi nodes, genesis election,
# account funding) and can take 20-40 minutes. Later runs just restart the
# containers against the existing chain state, which takes a minute or two.
#
# Ports and URLs are printed at the end; see README.md for the full table.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

exec > >(tee -a "$LC_DEVNET_LOGDIR/up.log") 2>&1
echo "=== devnet up $(date -Is) ==="
lcdevnet up
