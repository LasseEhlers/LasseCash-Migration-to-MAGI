#!/usr/bin/env bash
#
# Deploy the LasseCash contract to MAGI.
#
#   ./deploy.sh build     build the deployer tool (once, ~5 min)
#   ./deploy.sh init      generate the config files
#   ./deploy.sh preflight check the deploy can succeed BEFORE spending anything
#   ./deploy.sh deploy    deploy the contract          <-- COSTS 10 HBD
#   ./deploy.sh update    push a new version to an existing contract
#
# COSTS 10 HBD from the deploying account's Hive (L1) balance, and needs that
# account's ACTIVE key.
#
# ⚠️ THE ACTIVE KEY GOES IN A PLAINTEXT FILE. That is how the upstream tool
# works, not a choice we made. Use a SECONDARY Hive account holding only the
# ~11 HBD it needs, and pass -owner to make your real account the owner. Then a
# leak of that file costs you a spare account, not your stack.
#
set -euo pipefail
cd "$(dirname "$0")"

DEPLOYER_DIR="${DEPLOYER_DIR:-$HOME/.lassecash-deployer}"
DEPLOYER="$DEPLOYER_DIR/contract-deployer"
# Which artifact to ship. Default is the production build; override for a
# throwaway test deploy of the 240x-clock variant:
#
#   WASM=contract/artifacts/main-testwindows.wasm ./deploy.sh deploy
#
WASM="${WASM:-contract/artifacts/main.wasm}"
GO_IMAGE=golang:1.25

build_deployer() {
  echo "==> fetching vsc-eco/go-vsc-node"
  mkdir -p "$DEPLOYER_DIR"
  if [ -d "$DEPLOYER_DIR/src/.git" ]; then
    git -C "$DEPLOYER_DIR/src" pull --ff-only
  else
    git clone --depth 1 https://github.com/vsc-eco/go-vsc-node.git "$DEPLOYER_DIR/src"
  fi

  echo "==> building contract-deployer (needs the WasmEdge C library; a few minutes)"
  docker run --rm \
    -v "$DEPLOYER_DIR/src":/src \
    -v "$DEPLOYER_DIR/cache":/root/.cache/go-build \
    -v "$DEPLOYER_DIR/mod":/go/pkg/mod \
    -w /src "$GO_IMAGE" bash -c '
      set -e
      apt-get update -qq >/dev/null 2>&1
      apt-get install -y -qq curl git build-essential >/dev/null 2>&1
      curl -sSf https://raw.githubusercontent.com/WasmEdge/WasmEdge/master/utils/install.sh \
        | bash -s -- -v 0.13.5 >/dev/null 2>&1
      export CGO_CFLAGS="-I/root/.wasmedge/include"
      export CGO_LDFLAGS="-L/root/.wasmedge/lib"
      export LD_LIBRARY_PATH=/root/.wasmedge/lib
      go build -buildvcs=false -o /src/contract-deployer ./cmd/contract-deployer
    '
  # Keep the WasmEdge runtime alongside the binary — it is dynamically linked,
  # so the library has to travel with it.
  docker run --rm -v "$DEPLOYER_DIR":/out "$GO_IMAGE" bash -c '
    apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq curl >/dev/null 2>&1
    curl -sSf https://raw.githubusercontent.com/WasmEdge/WasmEdge/master/utils/install.sh \
      | bash -s -- -v 0.13.5 >/dev/null 2>&1
    mkdir -p /out/wasmedge && cp -r /root/.wasmedge/* /out/wasmedge/
  '
  cp "$DEPLOYER_DIR/src/contract-deployer" "$DEPLOYER"
  echo "    built: $DEPLOYER"
}

# The deployer links against WasmEdge, so it runs inside the same image that
# built it rather than on the host.
run_deployer() {
  # -it only when a terminal is attached, so this also works from a script.
  local tty=(); [ -t 0 ] && tty=(-it)
  # Run as the invoking user, or the generated config lands owned by root and
  # you cannot edit the very file you have to put your key in.
  # --network host: the deployer runs libp2p and must reach witnesses to upload
  # the WASM to the data-availability layer and collect a storage proof.
  # Docker's default bridge blocks the inbound side of that handshake, and the
  # tool simply hangs rather than reporting it.
  docker run --rm "${tty[@]}" --network host --user "$(id -u):$(id -g)" \
    -v "$DEPLOYER_DIR/wasmedge":/wasmedge:ro \
    -v "$DEPLOYER_DIR/src":/src \
    -v "$PWD":/repo \
    -e HOME=/tmp \
    -w /repo "$GO_IMAGE" bash -c '
      # WasmEdge is installed into the build image at /root; as a non-root user
      # we only need the shared library on the path.
      export LD_LIBRARY_PATH=/wasmedge/lib
      exec /src/contract-deployer "$@"
    ' _ "$@"
}

require_built() {
  [ -x "$DEPLOYER_DIR/src/contract-deployer" ] || {
    echo "Deployer not built yet. Run: ./deploy.sh build" >&2
    exit 1
  }
}

# Verifies key / HBD / RC before anything is spent. Never prints the key.
preflight() {
  python3 tools/preflight.py deploy-data/config/identityConfig.json
}

require_wasm() {
  [ -f "$WASM" ] || { echo "No $WASM — run ./build.sh wasm first" >&2; exit 1; }
  echo "    contract: $WASM ($(stat -c%s "$WASM") bytes)"
}

case "${1:-help}" in
  build)
    build_deployer
    ;;

  init)
    require_built
    run_deployer -init -data-dir /repo/deploy-data
    cat <<'EOF'

Now edit deploy-data/config/identityConfig.json:

    {
      "HiveUsername": "your-deploy-account",
      "HiveActiveKey": "5J..."          <-- PRIVATE ACTIVE WIF
    }

⚠️ Use a SECONDARY account funded with ~11 HBD. This file holds a private key
   in plaintext. deploy-data/ is gitignored; delete it when you are done.
EOF
    ;;

  preflight)
    preflight
    ;;

  deploy)
    require_built
    require_wasm
    # Run the checks automatically. The failure they catch costs a full
    # upload-and-storage-proof round trip to discover otherwise, and the error
    # MAGI returns for it points at the wrong thing.
    preflight || { echo; echo "Refusing to deploy."; exit 1; }
    echo
    echo "==> deploying to MAGI mainnet — THIS SPENDS 10 HBD"
    read -rp "    type 'deploy' to continue: " confirm
    [ "$confirm" = "deploy" ] || { echo "aborted"; exit 1; }
    # Capture the output: the tool exits 0 even when the Hive broadcast fails,
    # so success has to be judged from what it printed, not the exit code.
    out=$(run_deployer \
      -data-dir /repo/deploy-data \
      -wasmPath "/repo/$WASM" \
      -name "LasseCash" \
      -description "LasseCash core — L-Shares, Proof-of-Brain, LASSECASH:HBD pool" \
      ${OWNER:+-owner "$OWNER"} 2>&1) || true
    echo "$out"
    echo
    if echo "$out" | grep -qi 'failed to broadcast\|Missing Active Authority\|error'; then
      echo "DEPLOY FAILED — no HBD was spent."
      echo "The WASM uploaded and witnesses signed a storage proof; only the"
      echo "Hive broadcast was rejected. Fix the cause and re-run."
      exit 1
    fi
    echo "Save the contract id above."
    echo
    echo "  THROWAWAY  -> web/.env.magi, then: npm run dev -- --mode magi"
    echo "  PRODUCTION -> the Cloudflare Pages environment, never a file here"
    echo
    echo "NOT web/.env: that is what the default build reads, so an id there"
    echo "turns every local build into a throwaway build without saying so."
    ;;

  update)
    require_built
    require_wasm
    : "${CONTRACT_ID:?set CONTRACT_ID=<existing contract id>}"
    echo "==> queueing an update for $CONTRACT_ID"
    echo "    MAGI timelocks contract updates and shows them publicly before"
    echo "    they activate — announced, not sneaked."
    run_deployer \
      -data-dir /repo/deploy-data \
      -wasmPath "/repo/$WASM" \
      -contractId "$CONTRACT_ID"
    ;;

  *)
    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
