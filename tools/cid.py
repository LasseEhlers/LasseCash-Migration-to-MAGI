#!/usr/bin/env python3
"""Compute a MAGI contract code CID from a local .wasm file.

MAGI addresses contract code by CIDv1 with the raw codec and a sha256
multihash, rendered in base32. That is the string findContract/
findPendingContractUpdates return as `code`, so this is how you prove that
what is deployed (or queued) is the artifact sitting in your tree — the only
check that catches "I rebuilt after I queued".

    python3 tools/cid.py contract/artifacts/main-tokenledger.wasm

Verified 2026-09-06: main.wasm reproduces bafkreieh7bs...5baa, the CID MAGI
reported for the queued 5 September update, and main-tokenledger.wasm
reproduces bafkreihztep...nrsu, the code throwaway #10 actually runs.
"""
import base64
import hashlib
import sys


def cid(path: str) -> str:
    with open(path, "rb") as fh:
        digest = hashlib.sha256(fh.read()).digest()
    # 0x01 CIDv1 | 0x55 raw codec | 0x12 sha2-256 | 0x20 32-byte length
    raw = bytes([0x01, 0x55, 0x12, 0x20]) + digest
    return "b" + base64.b32encode(raw).decode().lower().rstrip("=")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__.strip(), file=sys.stderr)
        sys.exit(2)
    for p in sys.argv[1:]:
        print(f"{cid(p)}  {p}")
