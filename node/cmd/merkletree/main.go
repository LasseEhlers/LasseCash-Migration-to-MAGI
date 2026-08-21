// Command merkletree builds the migration Merkle tree and writes the static
// files the claim page serves.
//
//	go run ./cmd/merkletree \
//	  -snapshot ../tools/snapshot/data/migration_set.json \
//	  -out ../web/static/migration
//
// The root it prints is what the owner commits with
// `set_snapshot <rootHex>|<qualifierTotal>|<burnTotal>` — and the totals go
// with it, because the contract checks the whole snapshot against the 51M
// hardcap once, at commit time, rather than trusting later claims.
package main

import (
	"flag"
	"fmt"
	"log"

	"github.com/lassecash/node/migtree"
)

func main() {
	snapshot := flag.String("snapshot", "../tools/snapshot/data/migration_set.json",
		"path to migration_set.json")
	out := flag.String("out", "../web/static/migration", "output directory")
	flag.Parse()

	tree, err := migtree.BuildFromFile(*snapshot)
	if err != nil {
		log.Fatalf("build: %v", err)
	}
	if err := tree.Write(*out); err != nil {
		log.Fatalf("write: %v", err)
	}

	qualifiers := 0
	for _, e := range tree.Entries {
		if !e.Burned {
			qualifiers++
		}
	}
	fmt.Printf("root             %s\n", tree.RootHex())
	fmt.Printf("leaves           %d  (%d qualifying, %d burned)\n",
		len(tree.Entries), qualifiers, len(tree.Entries)-qualifiers)
	fmt.Printf("qualifier_total  %s LC  (%d base units)\n",
		lc(tree.QualifierTotal), tree.QualifierTotal)
	fmt.Printf("burn_total       %s LC  (%d base units)\n",
		lc(tree.BurnTotal), tree.BurnTotal)
	fmt.Printf("whole snapshot   %s LC\n", lc(tree.QualifierTotal+tree.BurnTotal))
	fmt.Printf("shards           %d\n", tree.ShardCount())
	fmt.Printf("written to       %s\n", *out)
	fmt.Printf("\ncommit with: set_snapshot %s|%d|%d\n",
		tree.RootHex(), tree.QualifierTotal, tree.BurnTotal)
}

// lc renders base units at the fixed 8 decimals, never rounded.
func lc(units int64) string {
	return fmt.Sprintf("%d.%08d", units/100_000_000, units%100_000_000)
}
