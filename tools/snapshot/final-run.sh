#!/usr/bin/env bash
# THE snapshot run — LAUNCH-RUNBOOK §2, executed as one command at block X.
# Stops hard on any failure; prints the record to fill into the genesis post.
set -euo pipefail
cd "$(dirname "$0")"

echo "== Hive block at start:"
curl -s https://api.hive.blog -d '{"jsonrpc":"2.0","method":"condenser_api.get_dynamic_global_properties","params":[],"id":1}' | python3 -c "import sys,json;print(json.load(sys.stdin)['result']['head_block_number'])"

python3 fetch.py balances
python3 fetch.py activity
RES=$(python3 fetch.py resolve | tee /dev/stderr | tail -1)
case "$RES" in *"0 remain truncated"*|*"no truncated"*) ;; *)
  echo "STOP: resolve did not reach zero truncated walks"; exit 1;; esac
python3 apply_criteria.py --write
python3 check_snapshot.py            # exits non-zero on any invariant break
python3 build_status.py

cd ../..
./build.sh tree
docker run --rm -v "$PWD":/repo -w /repo/node "$(grep -oP 'GO_IMAGE=\K\S+' build.sh | tr -d '"')" go test ./migtree/
python3 tools/snapshot/make_admin_data.py

echo "== RECORD FOR THE GENESIS POST =="
python3 -c "import json;d=json.load(open('web/static/migration/root.json'));[print(k,d[k]) for k in d]"
python3 -c "
import json;d=json.load(open('tools/snapshot/data/migration_set.json'))
mig=d['migrate'];print('accounts in',len(mig));print('burn accounts',len(d['burn_inactive'])+len(d['burn_protocol']))"
echo "NEXT: git add -A && git commit -m 'Migration snapshot at Hive block X: root <root>' && git push"
