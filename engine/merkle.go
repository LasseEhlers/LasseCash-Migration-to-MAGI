package engine

// The migration snapshot as a Merkle tree.
//
// DECIDED 2026-08-21: the migration is CLAIM-based. The owner commits ONE
// root at genesis; each holder claims their own leaf with a proof, paying
// their own (free) RC. The tree — every account, qualifying AND burned, with
// liquid and staked figures — is published in full, so the root is a
// verifiable, permanent record of who held what and who was burned.
//
// This file is the single definition of the hashing, shared by the contract
// (verification) and the tools (tree building). If they ever differ, every
// claim fails — loudly, and before any money moves.
//
// Pure Go, no reflect, no fmt, and its own 2 KB SHA-256 (sha256.go) — the
// standard library's cost 54 KB of contract binary.

// Hash is a SHA-256 digest.
type Hash [32]byte

// MaxProofLen bounds a claim's proof: 2^32 leaves is far beyond any snapshot.
const MaxProofLen = 32

// leafDomain separates leaf hashes from interior-node hashes, so a proof can
// never present an interior node as a leaf (the classic second-preimage trick).
const leafDomain = "lassecash-migration-leaf-v1|"

// LeafHash commits one account's snapshot position.
//
//	sha256("lassecash-migration-leaf-v1|" + account + "|" + liquid + "|" + staked + "|" + m|b)
//
// Amounts are decimal base units; the final letter is m (migrates) or b
// (burned). A burned leaf cannot be claimed, only recorded.
func LeafHash(account string, liquid, staked Amount, burned bool) Hash {
	kind := "m"
	if burned {
		kind = "b"
	}
	return Sha256([]byte(leafDomain + account + "|" +
		itoa(int64(liquid)) + "|" + itoa(int64(staked)) + "|" + kind))
}

// ParentHash combines two children in SORTED order, so a proof needs no
// left/right bits: the verifier simply hashes the pair in canonical order.
func ParentHash(a, b Hash) Hash {
	if lessHash(b, a) {
		a, b = b, a
	}
	var buf [64]byte
	copy(buf[:32], a[:])
	copy(buf[32:], b[:])
	return Sha256(buf[:])
}

func lessHash(a, b Hash) bool {
	for i := 0; i < 32; i++ {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return false
}

// VerifyProof walks a leaf up through its siblings and compares to the root.
func VerifyProof(leaf Hash, proof []Hash, root Hash) bool {
	if len(proof) > MaxProofLen {
		return false
	}
	h := leaf
	for _, sib := range proof {
		h = ParentHash(h, sib)
	}
	return h == root
}

// BuildTree returns the root and, for every leaf index, its proof. Leaves
// are hashed pairwise level by level; an odd leaf at the end of a level is
// promoted unchanged (not duplicated, which would let one proof serve two
// positions). Used by the tools and by tests — the contract never builds.
func BuildTree(leaves []Hash) (Hash, [][]Hash) {
	n := len(leaves)
	proofs := make([][]Hash, n)
	if n == 0 {
		return Hash{}, proofs
	}
	// idx[i] tracks which current-level node leaf i sits under.
	level := append([]Hash(nil), leaves...)
	idx := make([]int, n)
	for i := range idx {
		idx[i] = i
	}
	for len(level) > 1 {
		next := make([]Hash, 0, (len(level)+1)/2)
		for i := 0; i < len(level); i += 2 {
			if i+1 < len(level) {
				next = append(next, ParentHash(level[i], level[i+1]))
			} else {
				next = append(next, level[i]) // odd one out: promoted
			}
		}
		for leaf := range idx {
			pos := idx[leaf]
			sib := pos ^ 1
			if sib < len(level) {
				proofs[leaf] = append(proofs[leaf], level[sib])
			}
			idx[leaf] = pos / 2
		}
		level = next
	}
	return level[0], proofs
}

// --- hex, without fmt or encoding/hex (binary size) --------------------

const hexDigits = "0123456789abcdef"

// HashToHex renders a hash as 64 lowercase hex characters.
func HashToHex(h Hash) string {
	var out [64]byte
	for i, b := range h {
		out[2*i] = hexDigits[b>>4]
		out[2*i+1] = hexDigits[b&0x0f]
	}
	return string(out[:])
}

// HexToHash parses 64 hex characters. ok=false on any malformed input.
func HexToHash(s string) (Hash, bool) {
	var h Hash
	if len(s) != 64 {
		return h, false
	}
	for i := 0; i < 32; i++ {
		hi, ok1 := hexVal(s[2*i])
		lo, ok2 := hexVal(s[2*i+1])
		if !ok1 || !ok2 {
			return Hash{}, false
		}
		h[i] = hi<<4 | lo
	}
	return h, true
}

func hexVal(c byte) (byte, bool) {
	switch {
	case c >= '0' && c <= '9':
		return c - '0', true
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10, true
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10, true
	}
	return 0, false
}

// itoa renders an int64 without strconv (kept out of the hot path's binary).
func itoa(v int64) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
