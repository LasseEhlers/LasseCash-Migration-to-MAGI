// Command node runs the LasseCash dev chain.
//
// It exists so the frontend can be built before anything is deployed to MAGI —
// and, crucially, so it is built against THE SAME ENGINE the chain will run.
// Every number this server returns was computed by contract-template/state.
//
// # WHY THIS SPEAKS PLAIN JSON RATHER THAN MIMICKING MAGI's GraphQL
//
// The abstraction boundary belongs in the TypeScript indexer, not here. The
// indexer presents one interface to the frontend and adapts either this
// simulator or a real MAGI node behind it. Hand-rolling a partial GraphQL
// server would be a second, subtly-wrong API to keep in sync — and the day it
// drifted from the real node, the frontend would break on deploy.
//
//	go run . -addr :8080 -genesis 109200000
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"contract-template/state"

	"github.com/lassecash/engine"
	"github.com/lassecash/node/sim"
)

var chain *sim.Chain

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	genesis := flag.Uint64("genesis", 109_200_000, "genesis Hive block height")
	seed := flag.Bool("seed", true, "seed a demo economy on startup")
	snapshot := flag.String("snapshot", "", "seed the REAL migration snapshot (path to migration_set.json) instead of the demo")
	flag.Parse()

	c, err := sim.New(*genesis, time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC))
	if err != nil {
		log.Fatalf("init: %v", err)
	}
	chain = c

	if *snapshot != "" {
		n, total, err := seedSnapshot(c, *snapshot)
		if err != nil {
			log.Fatalf("snapshot seed: %v", err)
		}
		log.Printf("  seeded REAL snapshot: %d accounts, %s LC", n, total)
	} else if *seed {
		seedDemo(c)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/chain", handleChain)
	mux.HandleFunc("/account/", handleAccount)
	mux.HandleFunc("/tx", handleTx)
	mux.HandleFunc("/state", handleState)
	mux.HandleFunc("/posts", handlePosts)
	mux.HandleFunc("/publish", handlePublish)
	mux.HandleFunc("/content/", handleContent)
	mux.HandleFunc("/quote/swap", handleQuoteSwap)
	mux.HandleFunc("/quote/mint", handleQuoteMint)
	mux.HandleFunc("/quote/liquidity", handleQuoteLiquidity)
	mux.HandleFunc("/dev/advance", handleAdvance)
	mux.HandleFunc("/dev/dump", handleDump)
	mux.HandleFunc("/", handleIndex)

	info := c.Info()
	log.Printf("LasseCash dev chain on %s", *addr)
	log.Printf("  genesis height %d, now at %d (%s)", *genesis, info.Height, info.Timestamp)
	log.Printf("  migrated supply %s LC", info.MigratedSupply)
	log.Fatal(http.ListenAndServe(*addr, cors(mux)))
}

// cors lets a SvelteKit dev server on another port talk to this.
func cors(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		h.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

// --- handlers -------------------------------------------------------------

func handleIndex(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"name": "LasseCash dev chain",
		"note": "Every number here is computed by the same Go engine the MAGI contract runs.",
		"endpoints": map[string]string{
			"GET  /chain":           "global position: height, supply, pools, consensus group",
			"GET  /account/{name}":  "balances, mints, tranches, vote power — all precomputed",
			"POST /tx":              `{"sender","entrypoint","args"} — same names as the contract`,
			"GET  /state?keys=a,b":  "raw contract state, mirrors MAGI getStateByKeys",
			"GET  /quote/swap":      "?direction=lc_hbd|hbd_lc&amount= — engine-computed preview",
			"GET  /quote/mint":      "?amount=&days= — L-Shares a mint would grant",
			"GET  /quote/liquidity": "?amount= — HBD required and shares earned",
			"POST /dev/advance":     `{"days"} or {"heights"} — move the clock`,
			"GET  /dev/dump":        "every state key (debug only)",
		},
	})
}

func handleChain(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, chain.Info())
}

func handleAccount(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/account/")
	if name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "account required"})
		return
	}
	writeJSON(w, http.StatusOK, chain.Account(name))
}

// txRequest mirrors a contract call: the entrypoint names and pipe-delimited
// args are IDENTICAL to app/main.go, so frontend code written against the
// simulator works unchanged against the deployed contract.
type txRequest struct {
	Sender     string `json:"sender"`
	Entrypoint string `json:"entrypoint"`
	Args       string `json:"args"`
}

func handleTx(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST only"})
		return
	}
	var req txRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if req.Sender == "" || req.Entrypoint == "" {
		writeJSON(w, http.StatusBadRequest,
			map[string]string{"error": "sender and entrypoint are required"})
		return
	}
	res := chain.Submit(req.Sender, req.Entrypoint, req.Args)
	code := http.StatusOK
	if !res.OK {
		// A rejected transaction is a client error, not a server fault — the
		// frontend should surface the message, not retry.
		code = http.StatusUnprocessableEntity
	}
	writeJSON(w, code, res)
}

func handleState(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("keys")
	if raw == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "keys= required"})
		return
	}
	writeJSON(w, http.StatusOK, chain.StateKeys(strings.Split(raw, ",")))
}

// --- quotes ---------------------------------------------------------------
//
// Previews come from the engine, never from the frontend. On a real node these
// map onto simulateContractCalls.

func amountParam(r *http.Request, name string) (engine.Amount, bool) {
	v := r.URL.Query().Get(name)
	if v == "" {
		return 0, false
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n < 0 {
		return 0, false
	}
	return engine.Amount(n), true
}

func handlePosts(w http.ResponseWriter, r *http.Request) {
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			limit = n
		}
	}
	writeJSON(w, http.StatusOK, chain.Posts(limit))
}

// publishRequest is one article plus its on-chain registration.
type publishRequest struct {
	Sender     string   `json:"sender"`
	Title      string   `json:"title"`
	Body       string   `json:"body"`
	Summary    string   `json:"summary"`
	Tags       []string `json:"tags"`
	Window     int      `json:"window"`      // 0 viral, 1 deep
	PayoutMode int      `json:"payout_mode"` // 0 split, 1 power up, 2 burn
}

func handlePublish(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST only"})
		return
	}
	var req publishRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if req.Sender == "" || req.Title == "" {
		writeJSON(w, http.StatusBadRequest,
			map[string]string{"error": "sender and title are required"})
		return
	}
	win := engine.Viral
	if req.Window == 1 {
		win = engine.Deep
	}
	permlink, res := chain.Publish(req.Sender, req.Title, req.Body, req.Summary,
		req.Tags, win, uint64(req.PayoutMode))

	code := http.StatusOK
	if !res.OK {
		code = http.StatusUnprocessableEntity
	}
	writeJSON(w, code, map[string]any{
		"ok": res.OK, "msg": res.Msg, "height": res.Height, "permlink": permlink,
	})
}

func handleContent(w http.ResponseWriter, r *http.Request) {
	// /content/{author}/{permlink}
	rest := strings.TrimPrefix(r.URL.Path, "/content/")
	slash := strings.Index(rest, "/")
	if slash < 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "need author/permlink"})
		return
	}
	body, ok := chain.Content(rest[:slash], rest[slash+1:])
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	writeJSON(w, http.StatusOK, body)
}

func handleQuoteSwap(w http.ResponseWriter, r *http.Request) {
	amount, ok := amountParam(r, "amount")
	if !ok {
		writeJSON(w, http.StatusBadRequest,
			map[string]string{"error": "amount= required, in base units"})
		return
	}
	dir := r.URL.Query().Get("direction")
	if dir != "lc_hbd" && dir != "hbd_lc" {
		writeJSON(w, http.StatusBadRequest,
			map[string]string{"error": "direction= must be lc_hbd or hbd_lc"})
		return
	}
	writeJSON(w, http.StatusOK, chain.QuoteSwap(dir, amount))
}

func handleQuoteMint(w http.ResponseWriter, r *http.Request) {
	amount, ok := amountParam(r, "amount")
	if !ok {
		writeJSON(w, http.StatusBadRequest,
			map[string]string{"error": "amount= required, in base units"})
		return
	}
	days, err := strconv.ParseInt(r.URL.Query().Get("days"), 10, 64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "days= required"})
		return
	}
	writeJSON(w, http.StatusOK, chain.QuoteMint(amount, days))
}

func handleQuoteLiquidity(w http.ResponseWriter, r *http.Request) {
	amount, ok := amountParam(r, "amount")
	if !ok {
		writeJSON(w, http.StatusBadRequest,
			map[string]string{"error": "amount= required, in base units"})
		return
	}
	writeJSON(w, http.StatusOK, chain.QuoteLiquidity(amount))
}

func handleAdvance(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Days    uint64 `json:"days"`
		Heights uint64 `json:"heights"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	var h uint64
	switch {
	case req.Days > 0:
		h = chain.AdvanceDays(req.Days)
	case req.Heights > 0:
		h = chain.Advance(req.Heights)
	default:
		writeJSON(w, http.StatusBadRequest,
			map[string]string{"error": "specify days or heights"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"height": h,
		"time":   chain.Now().Format(time.RFC3339),
	})
}

func handleDump(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, chain.Dump())
}

// --- demo seed ------------------------------------------------------------

// seedDemo builds a small but complete economy so the frontend has something
// real to render on first load: migrated balances, open mints of different
// ages, a funded pool, posts with votes, and pending Proof-of-Brain rewards.
func seedDemo(c *sim.Chain) {
	type migration struct {
		account string
		amount  string
	}
	// Roughly the real distribution shape from the snapshot: one dominant
	// founder, a few large holders, a long tail.
	for _, m := range []migration{
		{"hive:lasseehlers", "722268855737746"}, // 7,222,688.55 LC
		{"hive:signumpizza", "130502359425576"},
		{"hive:tibfox", "52720116326256"},
		{"hive:zaxan", "38769347685442"},
		{"hive:silvertop", "12000000000000"},
		{"hive:elizabethbit", "8000000000000"},
		{"hive:demo", "5000000000000"},
	} {
		c.Submit("system", "migrate", m.account+"|"+m.amount+"|0")
	}

	// Mints of varying age and duration, so the dashboard shows a real spread.
	c.Submit("hive:lasseehlers", "mint", "200000000000000|1095")
	c.Submit("hive:tibfox", "mint", "20000000000000|365")
	c.Submit("hive:demo", "mint", "100000000000|180")
	// Everyone who will post or vote must first hold L-Shares — the posting
	// threshold and vote weight both read from them.
	c.Submit("hive:silvertop", "mint", "2000000000000|365")
	c.Submit("hive:elizabethbit", "mint", "1500000000000|730")
	c.AdvanceDays(40)
	c.Submit("hive:signumpizza", "mint", "50000000000000|1095")
	c.Submit("hive:zaxan", "mint", "10000000000000|90")

	// Open the pool near the measured market price: 0.00103 HBD per LASSECASH.
	// 1,000,000 LC -> 1,030 HBD.
	c.Submit("hive:lasseehlers", "add_liquidity", "100000000000000|103000000000")
	c.AdvanceDays(20)
	c.Submit("hive:silvertop", "add_liquidity", "1000000000000|1100000000")

	// Content with curation, then payouts.
	c.Publish("hive:silvertop", "My Actifit Report",
		"Don't jump... man! Another day on the tower.",
		"Another day on the tower, and the flag is still flying.",
		[]string{"actifit", "photography"}, engine.Viral, 0)
	c.Publish("hive:lasseehlers", "The Migration Is Happening",
		"![](https://images.hive.blog/DQmRyDszBJHuR5a3xNQ9yJpVRhbp1Xbm5sc8btBjkKUKqJr/image.png)\n\n"+
			"LasseCash is being migrated to MAGI as we speak, powered by what might be "+
			"the world's best blockchain tech as of today. Only a few know about it "+
			"right now, but the absolute best are building toward it.",
		"LasseCash meets MAGI, and world-changing AnCap blockchain tech.",
		[]string{"lassecash", "magi", "ancap"}, engine.Deep, 0)
	for _, voter := range []string{"hive:tibfox", "hive:zaxan", "hive:demo", "hive:elizabethbit"} {
		c.Submit(voter, "vote", "hive:silvertop|my-actifit-report|100")
		c.Submit(voter, "vote", "hive:lasseehlers|the-migration-is-happening|50")
	}
	c.AdvanceDays(31)
	c.Submit("hive:anyone", "payout", "hive:silvertop|my-actifit-report")
	c.Submit("hive:anyone", "payout", "hive:lasseehlers|the-migration-is-happening")
	for _, voter := range []string{"hive:tibfox", "hive:zaxan", "hive:demo", "hive:elizabethbit"} {
		c.Submit(voter, "claim_curation", "hive:silvertop|my-actifit-report")
		c.Submit(voter, "claim_curation", "hive:lasseehlers|the-migration-is-happening")
	}

	// Recent, still-open content so the feed has something to vote on.
	c.Publish("hive:silvertop", "Fair Adventure Part 2",
		"![](https://images.hive.blog/DQmY525aWq8gXTXUqQJLu7F3nSFp4oS1RwKfKZZrXvci5bV/image.png)\n\n"+
			"Day two at the fair. The morning went on the back lots, where the rides "+
			"nobody queues for turn out to be the good ones.\n\n"+
			"## What we found\n\n- A carousel older than the town\n- Free coffee\n- No cameras",
		"Day two at the county fair, and the rides were worth the queue.",
		[]string{"actifit", "life", "photography"}, engine.Viral, 0)
	c.Publish("hive:elizabethbit", "Why AnCap Works In Practice",
		"Voluntary exchange is not a theory, it is what happens whenever the state stops looking...",
		"Voluntary exchange is not a theory — it is the default when nobody interferes.",
		[]string{"ancap", "freedom", "economics"}, engine.Deep, 0)
	c.Publish("hive:lasseehlers", "LasseMint Explained",
		"L-Shares are the immutable time-lock units of LasseCash.\n\n"+
			"**Longer pays better** and **bigger pays better** — and they MULTIPLY, "+
			"so the ceiling is 2.25x, not 2.0x.\n\n"+
			"> The share rate only ever rises. 7% a year, forever.\n\n"+
			"https://www.youtube.com/watch?v=wgfC4ltcOEk",
		"How L-Shares work, and why the multipliers are 1.5x each rather than one big one.",
		[]string{"lassecash", "lassemint", "tokenomics"}, engine.Deep, 1)

	c.Submit("hive:tibfox", "vote", "hive:silvertop|fair-adventure-part-2|60")
	c.Submit("hive:zaxan", "vote", "hive:silvertop|fair-adventure-part-2|30")
	c.Submit("hive:demo", "vote", "hive:elizabethbit|why-ancap-works-in-practice|80")
	c.Submit("hive:tibfox", "vote", "hive:lasseehlers|lassemint-explained|100")
	// Let emission accrue so the open posts show a real pending payout.
	c.AdvanceDays(3)

	// Governance preferences from the seated members. The swap fee is NOT
	// governable — it is hardcoded to zero — so the demo exercises the median
	// on a parameter that actually has a lever.
	for i, m := range []string{"hive:lasseehlers", "hive:signumpizza", "hive:tibfox"} {
		c.Submit(m, "set_param", "post.threshold_viral|"+strconv.Itoa((i+1)*100*int(engine.ShareUnit)))
	}
}

// seedSnapshot credits the real migration set through the SAME migrate_batch
// entrypoint the production migration uses, so the dev chain carries the
// genuine 6,039 balances and the frontend is exercised against real data.
func seedSnapshot(c *sim.Chain, path string) (int, string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, "", err
	}
	var doc struct {
		Migrate map[string]struct {
			Liquid int64 `json:"liquid"`
			Staked int64 `json:"staked"`
		} `json:"migrate"`
		BurnInactive map[string]struct {
			Liquid int64 `json:"liquid"`
			Staked int64 `json:"staked"`
		} `json:"burn_inactive"`
		BurnProtocol map[string]struct {
			Liquid int64 `json:"liquid"`
			Staked int64 `json:"staked"`
		} `json:"burn_protocol"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return 0, "", err
	}
	names := make([]string, 0, len(doc.Migrate))
	for name, rec := range doc.Migrate {
		if rec.Liquid+rec.Staked > 0 {
			names = append(names, name)
		}
	}
	sort.Strings(names)

	// The burn goes to hive:null PER ACCOUNT through burn_batch, leaving a
	// receipt for each — exactly as tools/migrate.py does against the real
	// chain.
	type rec struct{ Liquid, Staked int64 }
	burns := map[string]rec{}
	for n, r := range doc.BurnInactive {
		burns[n] = rec{r.Liquid, r.Staked}
	}
	for n, r := range doc.BurnProtocol {
		burns[n] = rec{r.Liquid, r.Staked}
	}
	burnNames := make([]string, 0, len(burns))
	for n, r := range burns {
		if r.Liquid+r.Staked > 0 {
			burnNames = append(burnNames, n)
		}
	}
	sort.Strings(burnNames)
	for i := 0; i < len(burnNames); i += state.MaxMigrateBatch {
		end := i + state.MaxMigrateBatch
		if end > len(burnNames) {
			end = len(burnNames)
		}
		triples := make([]string, 0, end-i)
		for _, n := range burnNames[i:end] {
			r := burns[n]
			triples = append(triples, "hive:"+n+
				","+strconv.FormatInt(r.Liquid, 10)+
				","+strconv.FormatInt(r.Staked, 10))
		}
		if r := c.Submit("system", "burn_batch", strings.Join(triples, "|")); !r.OK {
			return 0, "", fmt.Errorf("burn batch at %s: %s", burnNames[i], r.Msg)
		}
	}
	var sum int64
	for i := 0; i < len(names); i += state.MaxMigrateBatch {
		end := i + state.MaxMigrateBatch
		if end > len(names) {
			end = len(names)
		}
		triples := make([]string, 0, end-i)
		for _, n := range names[i:end] {
			rec := doc.Migrate[n]
			triples = append(triples, "hive:"+n+
				","+strconv.FormatInt(rec.Liquid, 10)+
				","+strconv.FormatInt(rec.Staked, 10))
			sum += rec.Liquid + rec.Staked
		}
		if r := c.Submit("system", "migrate_batch", strings.Join(triples, "|")); !r.OK {
			return 0, "", fmt.Errorf("batch at %s: %s", names[i], r.Msg)
		}
	}
	// Mirror launch day: Lasse holds 100 HBD on MAGI for the opening pool.
	c.FundHBD("hive:lasseehlers", 100*100_000_000)

	whole, frac := sum/100_000_000, sum%100_000_000
	return len(names), fmt.Sprintf("%d.%08d", whole, frac), nil
}
