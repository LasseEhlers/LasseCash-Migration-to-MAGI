#!/usr/bin/env bash
# LasseCash build & test. Needs only Docker — no local Go or TinyGo.
#
#   ./build.sh          run everything
#   ./build.sh test     engine + contract + simulator tests
#   ./build.sh wasm     build the MAGI contract + the browser engine
#   ./build.sh wasm-test  the 240x-clock TESTWINDOWS contract (throwaways only)
#   ./build.sh tree     rebuild the migration Merkle tree + static proofs
#   ./build.sh node     run the dev chain on :8080
#   ./build.sh web      run the frontend on :5173
#
set -euo pipefail
cd "$(dirname "$0")"

GO_IMAGE=golang:1.24-alpine
TINYGO_IMAGE=tinygo/tinygo:0.39.0

run_tests() {
  echo "==> engine tests (pure economics)"
  docker run --rm -v "$PWD/engine":/w -w /w "$GO_IMAGE" \
    sh -c 'go vet ./... && go test ./...'

  echo "==> contract state tests (storage + operations)"
  docker run --rm -v "$PWD":/repo -w /repo/contract "$GO_IMAGE" \
    sh -c 'go vet ./state/ && go test ./state/'

  echo "==> dev chain tests (simulator)"
  docker run --rm -v "$PWD":/repo -w /repo/node "$GO_IMAGE" \
    sh -c 'go vet ./... && go test ./...'

  echo "==> indexer tests (TypeScript)"
  # Integration tests need a DEMO-seeded chain (funded accounts, seeded pool).
  # :8080 may be serving the real snapshot for browsing, so prefer a demo node
  # on :8082 when one is listening; tests skip when neither answers.
  if curl -sf -o /dev/null --max-time 2 http://localhost:8082/chain; then
    ( cd api && LASSECASH_DEV_URL=http://localhost:8082 npm run --silent test )
  else
    ( cd api && npm run --silent test )
  fi

  if [ -d web/node_modules ]; then check_web; fi
}

run_web() {
  echo "==> LasseCash frontend on http://localhost:5173"
  echo "    (needs the dev chain: ./build.sh node in another terminal)"
  ( cd web && npm run dev )
}

check_web() {
  echo "==> frontend typecheck"
  ( cd web && npx svelte-kit sync >/dev/null 2>&1 && \
    npx svelte-check --tsconfig ./tsconfig.json --threshold error )
}

# The migration Merkle tree. Its ROOT is what the owner commits on-chain with
# set_snapshot, and the shard files under web/static/migration/proofs are what
# a holder's browser fetches to build one claim. Re-run after ANY change to
# tools/snapshot/data/migration_set.json — a stale tree means every claim is
# rejected by a root nobody can reproduce.
run_tree() {
  echo "==> migration Merkle tree"
  docker run --rm -v "$PWD":/repo -w /repo/node "$GO_IMAGE" \
    go run ./cmd/merkletree \
      -snapshot ../tools/snapshot/data/migration_set.json \
      -out ../web/static/migration
}

run_node() {
  echo "==> LasseCash dev chain on http://localhost:8080"
  docker run --rm -it -p 8080:8080 -v "$PWD":/repo -w /repo/node "$GO_IMAGE" \
    go run . -addr :8080
}

run_browser_engine() {
  echo "==> TinyGo build of the browser engine"
  docker run --rm -v "$PWD":/repo -w /repo/api/engine-wasm "$TINYGO_IMAGE" \
    tinygo build -o engine.wasm -target wasm -no-debug .
  mv api/engine-wasm/engine.wasm api/src/wasm/engine.wasm
  # The web app serves its own copy from static/ — sync it or the browser
  # runs a stale engine missing newer bridge functions (bitten 2026-08-21:
  # "must(...).consensusGroup is not a function").
  cp api/src/wasm/engine.wasm web/static/engine.wasm
  echo "    api/src/wasm/engine.wasm  $(stat -c%s api/src/wasm/engine.wasm) bytes (synced to web/static)"
}

run_wasm() {
  echo "==> TinyGo build of the MAGI contract"
  mkdir -p contract/artifacts
  docker run --rm -v "$PWD":/repo -w /repo/contract "$TINYGO_IMAGE" \
    tinygo build -gc=custom -scheduler=none -panic=trap -no-debug \
    -target=wasm-unknown -o artifacts/main.wasm ./app
  echo "    contract/artifacts/main.wasm  $(stat -c%s contract/artifacts/main.wasm) bytes"
}

# The 240x TEST build: 6-minute "days" compress every lifecycle window while
# emission and the share-rate ratchet stay on mainnet time. NEVER deploy this
# as the production contract — its init message is stamped [TESTWINDOWS] so a
# deployment can always be told apart by reading its state.
run_wasm_test() {
  echo "==> TinyGo build of the MAGI contract (TESTWINDOWS, 240x clock)"
  mkdir -p contract/artifacts
  docker run --rm -v "$PWD":/repo -w /repo/contract "$TINYGO_IMAGE" \
    tinygo build -gc=custom -scheduler=none -panic=trap -no-debug -tags testwindows \
    -target=wasm-unknown -o artifacts/main-testwindows.wasm ./app
  echo "    contract/artifacts/main-testwindows.wasm  $(stat -c%s contract/artifacts/main-testwindows.wasm) bytes"
  # The browser engine must carry the SAME clock as the contract it fronts:
  # engine.constants().heightsPerDay feeds all maturity math in the indexer,
  # and a mainnet-clock engine against a testwindows contract is 240x wrong.
  echo "==> TinyGo build of the browser engine (TESTWINDOWS)"
  docker run --rm -v "$PWD":/repo -w /repo/api/engine-wasm "$TINYGO_IMAGE" \
    tinygo build -o engine.wasm -target wasm -no-debug -tags testwindows .
  mv api/engine-wasm/engine.wasm api/src/wasm/engine-testwindows.wasm
  cp api/src/wasm/engine-testwindows.wasm web/static/engine-testwindows.wasm
  echo "    api/src/wasm/engine-testwindows.wasm  $(stat -c%s api/src/wasm/engine-testwindows.wasm) bytes (synced to web/static)"
}

case "${1:-all}" in
  test) run_tests ;;
  wasm) run_wasm; run_browser_engine ;;
  wasm-test) run_wasm_test ;;
  tree) run_tree ;;
  node) run_node ;;
  web)  run_web ;;
  all)  run_browser_engine; run_tests; run_wasm; echo; echo "All green." ;;
  *)    echo "usage: $0 [test|wasm|wasm-test|tree|node|web]" >&2; exit 1 ;;
esac
