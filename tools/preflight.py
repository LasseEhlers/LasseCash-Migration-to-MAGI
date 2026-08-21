#!/usr/bin/env python3
"""
Preflight for ./deploy.sh — verify a deploy can succeed BEFORE spending 10 HBD.

Checks, in the order they cause failures in practice:

  1. the configured key really is the account's ACTIVE key
  2. >= 10 HBD sits on HIVE LAYER 1 (not on MAGI)
  3. resource credits are not exhausted

⚠️ THE PRIVATE KEY IS NEVER PRINTED, LOGGED OR TRANSMITTED. It is read, turned
into a PUBLIC key locally, and compared. Nothing else touches it. Keep it that
way: the file exists in plaintext only because the upstream deployer requires
it, and a diagnostic that echoed it would be a worse bug than the one it finds.

Pure standard library on purpose — a deploy preflight that needs `npm install`
is one more thing to break at the moment you least want it to.
"""
import hashlib
import json
import sys
import urllib.request

HIVE_API = "https://api.hive.blog"
DEPLOY_FEE = 10.0

# --- secp256k1, enough to turn a private key into a public one ----------------
# Only point multiplication is needed. No signing, no verification.
P = 2**256 - 2**32 - 977
Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798
Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8

B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58decode(s: str) -> bytes:
    n = 0
    for ch in s:
        i = B58.find(ch)
        if i < 0:
            raise ValueError("not base58")
        n = n * 58 + i
    out = n.to_bytes((n.bit_length() + 7) // 8, "big")
    # Leading '1's are leading zero bytes, and dropping them shifts every
    # subsequent slice — which would silently produce the wrong key.
    return b"\x00" * (len(s) - len(s.lstrip("1"))) + out


def point_add(a, b):
    if a is None:
        return b
    if b is None:
        return a
    (x1, y1), (x2, y2) = a, b
    if x1 == x2 and (y1 + y2) % P == 0:
        return None
    if a == b:
        lam = 3 * x1 * x1 * pow(2 * y1, P - 2, P)
    else:
        lam = (y2 - y1) * pow(x2 - x1, P - 2, P)
    lam %= P
    x3 = (lam * lam - x1 - x2) % P
    return (x3, (lam * (x1 - x3) - y1) % P)


def point_mul(k: int):
    result, addend = None, (Gx, Gy)
    while k:
        if k & 1:
            result = point_add(result, addend)
        addend = point_add(addend, addend)
        k >>= 1
    return result


def wif_to_compressed_pubkey(wif: str) -> bytes:
    """Private WIF -> 33-byte compressed public key. The secret goes no further."""
    raw = b58decode(wif)
    if len(raw) < 37 or raw[0] != 0x80:
        raise ValueError("not a Hive private WIF (expected a key starting with 5)")
    secret = int.from_bytes(raw[1:33], "big")
    x, y = point_mul(secret)
    return bytes([2 + (y & 1)]) + x.to_bytes(32, "big")


def stm_to_compressed_pubkey(key: str) -> bytes:
    """'STM...' -> the same 33-byte form, so the two are directly comparable."""
    raw = b58decode(key[3:])
    return raw[:33]


# --- Hive queries -------------------------------------------------------------
def rpc(method: str, params):
    body = json.dumps({"jsonrpc": "2.0", "method": method, "params": params, "id": 1})
    req = urllib.request.Request(
        HIVE_API, data=body.encode(), headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        out = json.load(r)
    if "error" in out:
        raise RuntimeError(out["error"])
    return out["result"]


OK, BAD = "  \033[32mOK\033[0m  ", "  \033[31mFAIL\033[0m"


def main() -> int:
    try:
        cfg = json.load(open(sys.argv[1]))
    except FileNotFoundError:
        print("No config. Run: ./deploy.sh init")
        return 1

    account = cfg.get("HiveUsername", "")
    wif = cfg.get("HiveActiveKey", "")
    if not account or not wif:
        print("Config is missing HiveUsername or HiveActiveKey.")
        return 1

    print(f"Preflight for @{account}\n")
    failed = []

    accounts = rpc("condenser_api.get_accounts", [[account]])
    if not accounts:
        print(f"{BAD} account @{account} does not exist on Hive")
        return 1
    acct = accounts[0]

    # 1. Authority. This is the check that actually catches things: MAGI reports
    #    "Missing Active Authority", which reads like a permissions problem but
    #    is nearly always the wrong key copied from the wrong wallet window.
    on_chain = acct["active"]["key_auths"][0][0]
    try:
        mine = wif_to_compressed_pubkey(wif)
        if mine == stm_to_compressed_pubkey(on_chain):
            print(f"{OK} active key matches @{account}")
        else:
            # Name the role it IS, so the fix is obvious rather than a hunt.
            role = next(
                (
                    r
                    for r in ("owner", "posting")
                    if mine == stm_to_compressed_pubkey(acct[r]["key_auths"][0][0])
                ),
                None,
            )
            if mine == stm_to_compressed_pubkey(acct["memo_key"]):
                role = "memo"
            print(f"{BAD} wrong key — this is the {role.upper()} key" if role
                  else f"{BAD} wrong key — it belongs to some other account")
            print(f"       need the private key for {on_chain}")
            failed.append("key")
    except ValueError as e:
        print(f"{BAD} {e}")
        failed.append("key")

    # 2. The fee is a HIVE LAYER 1 transfer. HBD held on MAGI cannot pay it,
    #    which is a genuinely easy mistake when both balances exist.
    hbd = float(acct["hbd_balance"].split()[0])
    if hbd >= DEPLOY_FEE:
        print(f"{OK} {hbd:.3f} HBD on Hive L1 (deploy costs {DEPLOY_FEE:.0f})")
    else:
        print(f"{BAD} only {hbd:.3f} HBD on Hive L1 — need {DEPLOY_FEE:.0f}")
        print("       HBD on MAGI does not count; the fee is an L1 transfer")
        failed.append("hbd")

    # 3. RC. MAGI has no fees, so RC is the entire cost of everything else.
    rc = rpc("rc_api.find_rc_accounts", {"accounts": [account]})["rc_accounts"][0]
    mx, cur = int(rc["max_rc"]), int(rc["rc_manabar"]["current_mana"])
    pct = cur / mx * 100 if mx else 0
    if pct >= 10:
        print(f"{OK} RC {pct:.0f}% of {mx / 1e9:.1f}G")
    else:
        print(f"{BAD} RC {pct:.0f}% — too low to broadcast reliably")
        failed.append("rc")

    print()
    if failed:
        print("NOT READY. Nothing was spent. Fix the above and re-run.")
        return 1
    print("READY. ./deploy.sh deploy will spend 10 HBD.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
