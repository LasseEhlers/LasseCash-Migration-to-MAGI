#!/usr/bin/env bash
# devnet.sh — passthrough to the lcdevnet driver for everything that is not
# up/down/reset: status, logs, deploy, call, simulate, state, gql.
#
#   ./tools/devnet/devnet.sh status
#   ./tools/devnet/devnet.sh deploy -wasm contract/artifacts/main.wasm -name lassecash
#   ./tools/devnet/devnet.sh call -contract vsc1... -action init -payload 100
#   ./tools/devnet/devnet.sh state -contract vsc1... -keys cfg_init,cfg_genesis
#   ./tools/devnet/devnet.sh simulate -contract vsc1... -action migrate_batch \
#        -auth hive:magi.test1 -rc 100000 -payload-file /tmp/batch50.txt
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
lcdevnet "$@"
