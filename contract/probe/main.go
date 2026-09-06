// Package main is a MEASUREMENT PROBE, never a deployment.
//
// It answers one question that decides whether LASSECASH's ledger can move
// into a standard `magi_token` before the key burn (docs/STANDARD-TOKEN-SPIKE.md):
//
//	what does ONE cross-contract token call cost, in gas, on top of a local
//	state write?
//
// Today `claim_migration` costs 4,017–5,892 RC against a fresh account's free
// 10,000. If a credit becomes a ContractCall into another contract, the claim
// grows by (calls x marginal). Below 10,000 the migration model survives;
// above it, every unclaimed holder must buy HBD first, which is the thing
// claim-based migration exists to avoid.
//
// Each entrypoint takes `<n>|<tokenId>|<to>|<amount>` and does n of something,
// so the marginal cost is a subtraction and the fixed overhead cancels:
//
//	marginal_call  = (gas(call_n, n=5) - gas(call_n, n=1)) / 4
//	marginal_write = (gas(write_n, n=5) - gas(write_n, n=1)) / 4
//
// Build:  docker run --rm -v "$PWD":/repo -w /repo/contract tinygo/tinygo:0.39.0 \
//           tinygo build -gc=custom -scheduler=none -panic=trap -no-debug \
//           -target=wasm-unknown -o artifacts/probe.wasm ./probe
package main

import (
	_ "contract-template/runtime" // supplies alloc/free for -gc=custom
	"contract-template/sdk"
	"strconv"
	"strings"
)

func ret(s string) *string { return &s }

// args splits `<n>|<tokenId>|<to>|<amount>`; n defaults to 1.
func args(payload *string) (int, string, string, string) {
	if payload == nil {
		return 0, "", "", ""
	}
	f := strings.Split(*payload, "|")
	if len(f) < 4 {
		return 0, "", "", ""
	}
	n, err := strconv.Atoi(f[0])
	if err != nil || n < 0 || n > 50 {
		return 0, "", "", ""
	}
	return n, f[1], f[2], f[3]
}

// noop is the floor: entry, parse, return. Everything else subtracts this.
//
//go:wasmexport noop
func Noop(payload *string) *string {
	n, _, _, _ := args(payload)
	return ret("noop " + strconv.Itoa(n))
}

// write_n does n LOCAL state writes — what a credit costs today.
//
//go:wasmexport write_n
func WriteN(payload *string) *string {
	n, _, to, amount := args(payload)
	for i := 0; i < n; i++ {
		sdk.StateSetObject("probe_"+to+"_"+strconv.Itoa(i), amount)
	}
	return ret("wrote " + strconv.Itoa(n))
}

// call_n does n cross-contract `transfer` calls into a magi_token — what a
// credit would cost if the balance lived there. THE measurement.
//
//go:wasmexport call_n
func CallN(payload *string) *string {
	n, token, to, amount := args(payload)
	for i := 0; i < n; i++ {
		sdk.ContractCall(token, "transfer", `{"to":"`+to+`","amount":"`+amount+`"}`, nil)
	}
	return ret("called " + strconv.Itoa(n))
}

// read_n does n cross-contract STATE READS — the cheap half of the same
// question: a balance can be read without a call, so a design that reads
// directly and writes through calls may sit well under one that does both.
//
//go:wasmexport read_n
func ReadN(payload *string) *string {
	n, token, to, _ := args(payload)
	last := ""
	for i := 0; i < n; i++ {
		if v := sdk.ContractStateGet(token, "bal|"+to); v != nil {
			last = *v
		}
	}
	return ret("read " + strconv.Itoa(n) + " " + last)
}

func main() {}
