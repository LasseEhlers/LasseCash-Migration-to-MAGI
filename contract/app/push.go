//go:build push

// PUSH migration — the REHEARSED FALLBACK, excluded from the production build.
//
// The live migration is CLAIM-based (set_snapshot / claim_migration, in
// main.go). These owner-only entrypoints credit accounts directly and cost
// ~8.8M RC for the whole snapshot — which is why they lost. They stay
// buildable (`-tags push`) for rehearsals and as a fallback, but a frozen
// contract should carry no entrypoint it will never use.
package main

import (
	"strconv"
	"strings"

	"contract-template/sdk"
	"contract-template/state"

	"github.com/lassecash/engine"
)

// migrate credits a snapshot position: liquid balance plus staked LASSECASH
// POWER, the latter becoming the 6-month migration mint. Owner only, and only
// before emission starts — after that the migrated supply is fixed and the
// hardcap arithmetic depends on it.
//
//	args: <account>|<liquid>|<staked>
//
//go:wasmexport migrate
func Migrate(a *string) *string {
	_, env := ctx()
	requireOwner(env)
	args := state.ParseArgs(*a)
	account := args.Str(0)
	liquid, okL := args.Amount(1)
	staked, okS := args.Amount(2)
	if account == "" || !okL || !okS {
		sdk.Abort("usage: <account>|<liquid>|<staked>")
	}
	return finish(state.CreditMigration(store{}, account, liquid, staked))
}

// migrate_batch credits up to state.MaxMigrateBatch snapshot balances in one
// call. Owner only, genesis phase only — exactly like migrate, of which this
// is the bulk form.
//
// EXISTS FOR RC ECONOMICS: MAGI freezes a call's full rc_limit for its 5-day
// thaw, so the 6,039-account migration as single calls would park ~1,800 HBD
// of RC. Batched at 50 it is ~121 calls.
//
//	args: <account>,<liquid>,<staked>|<account>,<liquid>,<staked>|…
//
// Commas inside a triple, pipe between triples: account names (hive:… and
// did:pkh:…) can contain colons but never commas, and amounts are bare
// integers, so splitting each triple at its LAST TWO commas is unambiguous.
//
//go:wasmexport migrate_batch
func MigrateBatch(a *string) *string {
	_, env := ctx()
	requireOwner(env)
	return finish(state.CreditMigrationBatch(store{}, parseTriples(*a)))
}

// burn_batch records up to state.MaxMigrateBatch NON-qualifying snapshot
// accounts: each one's LASSECASH and LASSECASH POWER are credited to hive:null
// and a per-account receipt (`mig_<account>` = burned|liquid|staked) is
// written, so who held what is readable on MAGI forever. Owner only, genesis
// phase only. Same wire format as migrate_batch.
//
//	args: <account>,<liquid>,<staked>|…
//
//go:wasmexport burn_batch
func BurnBatch(a *string) *string {
	_, env := ctx()
	requireOwner(env)
	return finish(state.BurnMigrationBatch(store{}, parseTriples(*a)))
}

// parseTriples reads `<account>,<liquid>,<staked>|…`. Commas inside a triple,
// pipe between triples: account names (hive:… and did:pkh:…) can contain
// colons but never commas, and amounts are bare integers, so splitting each
// triple at its LAST TWO commas is unambiguous.
func parseTriples(payload string) []state.MigrationEntry {
	args := state.ParseArgs(payload)
	entries := make([]state.MigrationEntry, 0, len(args))
	for i := range args {
		triple := args.Str(i)
		cutS := strings.LastIndexByte(triple, ',')
		cutL := -1
		if cutS > 0 {
			cutL = strings.LastIndexByte(triple[:cutS], ',')
		}
		if cutL <= 0 || cutS == len(triple)-1 {
			sdk.Abort("usage: <account>,<liquid>,<staked>|…")
		}
		liq, errL := strconv.ParseInt(triple[cutL+1:cutS], 10, 64)
		stk, errS := strconv.ParseInt(triple[cutS+1:], 10, 64)
		if errL != nil || errS != nil || liq < 0 || stk < 0 {
			sdk.Abort("bad amount for " + triple[:cutL])
		}
		entries = append(entries, state.MigrationEntry{
			Account: triple[:cutL],
			Liquid:  engine.Amount(liq),
			Staked:  engine.Amount(stk),
		})
	}
	return entries
}
