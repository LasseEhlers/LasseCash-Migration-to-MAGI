#!/usr/bin/env bash
# XSS vectors against the post renderer. Post bodies are attacker-controlled,
# and admitHtml() deliberately turns some of them back into markup — so the
# allowlist needs a suite that tries to get past it, not a happy-path test.
#
#   ./tools/markdown-check/run.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d)
web/node_modules/.bin/esbuild web/src/lib/markdown.ts --format=esm --outfile="$OUT/md.mjs" --log-level=error
cp tools/markdown-check/vectors.mjs "$OUT/"
node "$OUT/vectors.mjs"
