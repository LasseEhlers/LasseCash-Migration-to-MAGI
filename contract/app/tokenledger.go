package main

import (
	"contract-template/sdk"
	"contract-template/state"

	"github.com/lassecash/engine"
)

// The SDK half of the token ledger: LASSECASH held in a standard MAGI
// `magi_token` that THIS CONTRACT owns.
//
// state/ never imports sdk, so this is the injected implementation — exactly
// the arrangement `assets` uses for HBD. See docs/TOKEN-LEDGER-PLAN.md.
//
// UNITS: the token is initialised with decimals=8 and its integer amounts are
// our base units, one for one. There is no conversion here, and there must
// never be one — the HBD milli-unit bug (2026-08-22) came from exactly this
// kind of silent mismatch and would have been fatal after the burn.

// keyTokenContract holds the deployed token's contract id. In STATE, not
// hardcoded, so a compatible redeploy can be pointed at — and deliberately
// NOT governable: a top-ten able to repoint the ledger could point it at a
// token they control and mint themselves everything.
const keyTokenContract = "cfg_token"

// tokenLedger implements state.Tokens against a deployed magi_token.
//
// Every method returns true on the happy path and cannot return false on the
// real chain: sdk.ContractCall ABORTS and unwinds the whole transaction when
// the callee fails, the same convention assets.Draw documents for HiveDraw.
// The bool exists so state/ can be tested against a double that fails.
type tokenLedger struct {
	id   string // the token contract
	self string // this contract, as the token addresses it: contract:vsc1...
}

func (t tokenLedger) TokenSelf() string { return t.self }

// TokenBalance reads the token's own state directly — a state read, not a
// contract call. Measured 17 RC on the devnet against 301 for a call, and
// cheaper even than a local write (97), because reads are not weighted 19x.
func (t tokenLedger) TokenBalance(account string) engine.Amount {
	raw := sdk.ContractStateGet(t.id, "bal|"+account)
	if raw == nil {
		return 0
	}
	amt, ok := state.DecodeTokenAmount(*raw)
	if !ok {
		// Refusing beats guessing: a balance we cannot decode is either
		// corruption or a contract that is not the token we think it is, and
		// truncating it would invent or destroy money.
		sdk.Abort("token balance unreadable")
	}
	return amt
}

func (t tokenLedger) TokenMint(amount engine.Amount) bool {
	if amount <= 0 {
		return false
	}
	sdk.ContractCall(t.id, "mint", `{"amount":"`+decimal(amount)+`"}`, nil)
	return true
}

func (t tokenLedger) TokenTransfer(to string, amount engine.Amount) bool {
	if amount <= 0 || to == "" {
		return false
	}
	sdk.ContractCall(t.id, "transfer",
		`{"to":"`+to+`","amount":"`+decimal(amount)+`"}`, nil)
	return true
}

// TokenTransferFrom spends the allowance the user granted this contract in the
// same signed transaction — the site bundles `increaseAllowance` ahead of the
// action, exactly as it already does for the BTC swap.
func (t tokenLedger) TokenTransferFrom(from string, amount engine.Amount) bool {
	if amount <= 0 || from == "" {
		return false
	}
	sdk.ContractCall(t.id, "transferFrom",
		`{"from":"`+from+`","to":"`+t.self+`","amount":"`+decimal(amount)+`"}`, nil)
	return true
}

// decimal renders base units as the plain decimal string the token's JSON
// wants. No floats, ever.
func decimal(a engine.Amount) string {
	if a == 0 {
		return "0"
	}
	n := int64(a)
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// tokenStore is a Store whose LASSECASH lives in the token.
type tokenStore struct {
	store
	tokenLedger
}

// st returns the store this contract should use.
//
// Until `cfg_token` is set the legacy `bal_` ledger runs, unchanged — which
// is what makes the switch a code update rather than a migration cliff. Once
// it is set, balances live in the token and any `bal_` row still present
// migrates itself the first time its account is touched.
func st() state.Store {
	id := sdk.StateGetObject(keyTokenContract)
	if id == nil || *id == "" {
		return store{}
	}
	self := ""
	if c := sdk.GetEnvKey("contract.id"); c != nil {
		self = "contract:" + *c
	}
	return tokenStore{tokenLedger: tokenLedger{id: *id, self: self}}
}

// set_token points this contract at its magi_token. Owner only, once.
//
// Run AFTER the token is deployed and BEFORE its ownership is handed to this
// contract, so the order is: deploy token -> set_token here -> migrate_ledger
// -> changeOwner on the token. From then on only this contract can mint, and
// after the key burn nobody can change any of it.
//
//	args: <tokenContractId>
//
//go:wasmexport set_token
func SetToken(a *string) *string {
	_, env := ctx()
	requireOwner(env)
	args := state.ParseArgs(*a)
	id := args.Str(0)
	if id == "" {
		sdk.Abort("usage: <tokenContractId>")
	}
	if cur := sdk.StateGetObject(keyTokenContract); cur != nil && *cur != "" {
		sdk.Abort("token already set")
	}
	sdk.StateSetObject(keyTokenContract, id)
	msg := "token ledger set to " + id
	return &msg
}

// migrate_ledger moves a batch of legacy `bal_` rows into the token.
//
// Owner only, idempotent, atomic per batch. Accounts already migrated have no
// row and are skipped, so a resend after a crash is safe — an operator's
// progress file must never be the last line of defence (rehearsal, 2026-08-21).
//
// Not the only path: any account that transacts migrates itself first, so this
// is the sweep for everyone who does not happen to act.
//
//	args: <acct>|<acct>|...
//
//go:wasmexport migrate_ledger
func MigrateLedgerEntry(a *string) *string {
	_, env := ctx()
	requireOwner(env)
	args := state.ParseArgs(*a)
	accounts := []string(args)
	if len(accounts) == 0 {
		sdk.Abort("usage: <acct>|<acct>|...")
	}
	return finish(state.MigrateLedger(st(), accounts))
}
