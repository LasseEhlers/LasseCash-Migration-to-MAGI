package engine

import (
	"crypto/sha256"
	"testing"
)

// The contract's tiny SHA-256 must be byte-identical to the standard library
// for every message length that matters (padding boundaries included).
func TestSmallSha256MatchesStdlib(t *testing.T) {
	msg := make([]byte, 0, 300)
	for n := 0; n <= 260; n++ {
		if got, want := Sha256(msg), Hash(sha256.Sum256(msg)); got != want {
			t.Fatalf("length %d: mismatch", n)
		}
		msg = append(msg, byte(n*31+7))
	}
	// A realistic leaf and a realistic 64-byte parent input.
	leaf := []byte("lassecash-migration-leaf-v1|hive:lasseehlers|22141356699780|700127499037966|m")
	if Sha256(leaf) != Hash(sha256.Sum256(leaf)) {
		t.Fatal("leaf mismatch")
	}
}
