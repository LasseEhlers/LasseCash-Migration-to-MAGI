package engine

import "testing"

func TestMerkleProofsVerifyForEveryLeafAndRejectTampering(t *testing.T) {
	for _, n := range []int{1, 2, 3, 7, 8, 1000, 11_236} {
		leaves := make([]Hash, n)
		for i := range leaves {
			leaves[i] = LeafHash("hive:acct"+itoa(int64(i)), Amount(i*7), Amount(i*3), i%5 == 0)
		}
		root, proofs := BuildTree(leaves)
		for i := range leaves {
			if !VerifyProof(leaves[i], proofs[i], root) {
				t.Fatalf("n=%d: leaf %d does not verify", n, i)
			}
			if len(proofs[i]) > MaxProofLen {
				t.Fatalf("n=%d: proof longer than MaxProofLen", n)
			}
		}
		// A different amount, a different kind, or another leaf's proof must fail.
		if n > 1 {
			bad := LeafHash("hive:acct1", Amount(7)+1, Amount(3), false)
			if VerifyProof(bad, proofs[1], root) {
				t.Fatalf("n=%d: tampered amount verified", n)
			}
			flipped := LeafHash("hive:acct1", Amount(7), Amount(3), true)
			if VerifyProof(flipped, proofs[1], root) {
				t.Fatalf("n=%d: burned flag flip verified", n)
			}
			if VerifyProof(leaves[1], proofs[0], root) {
				t.Fatalf("n=%d: another leaf's proof verified", n)
			}
		}
	}
}

func TestMerkleHexRoundTrip(t *testing.T) {
	h := LeafHash("hive:alice", LC(1), LC(2), false)
	s := HashToHex(h)
	back, ok := HexToHash(s)
	if !ok || back != h || len(s) != 64 {
		t.Fatalf("hex round trip failed: %q", s)
	}
	if _, ok := HexToHash(s[:63]); ok {
		t.Fatal("short hex accepted")
	}
	if _, ok := HexToHash("zz" + s[2:]); ok {
		t.Fatal("non-hex accepted")
	}
}
