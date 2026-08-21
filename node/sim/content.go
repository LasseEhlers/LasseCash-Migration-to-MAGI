package sim

import (
	"strings"
	"sync"
)

// Off-chain content storage.
//
// THIS IS NOT CONTRACT STATE, AND THAT IS THE POINT.
//
// The LasseCash contract stores only what it needs for reward accounting:
// author, permlink, window, payout mode, rshares. It has no title and no body,
// exactly like the old Hive tribe — content lives on Hive, and the tribe
// contract tracks the money.
//
// So publishing is genuinely two steps:
//
//  1. write the article somewhere content lives (Hive, via Aioha)
//  2. register it with the LasseCash contract, which starts the payout window
//
// The simulator stands in for step 1 with this in-memory store. Keeping it in a
// separate file, on a separate type, stops it quietly becoming a place where
// consensus-relevant data hides.
type contentStore struct {
	mu    sync.RWMutex
	items map[string]Content
}

// Content is an article body as it would exist on Hive.
type Content struct {
	Title   string   `json:"title"`
	Body    string   `json:"body"`
	Summary string   `json:"summary"`
	Tags    []string `json:"tags"`
}

func newContentStore() *contentStore {
	return &contentStore{items: map[string]Content{}}
}

func contentKey(author, permlink string) string { return author + "/" + permlink }

func (c *contentStore) put(author, permlink string, v Content) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.items[contentKey(author, permlink)] = v
}

func (c *contentStore) get(author, permlink string) (Content, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	v, ok := c.items[contentKey(author, permlink)]
	return v, ok
}

// Permlink derives a URL-safe slug from a title, the way Hive does.
//
// Returned to the caller rather than assumed, because the permlink is the
// contract's KEY for the post — the frontend must register the same string it
// published under, or the rewards attach to nothing.
func Permlink(title string) string {
	var b strings.Builder
	lastDash := true // trims a leading dash
	for _, r := range strings.ToLower(title) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			lastDash = false
		case r == ' ' || r == '-' || r == '_':
			if !lastDash {
				b.WriteByte('-')
				lastDash = true
			}
		}
	}
	out := strings.Trim(b.String(), "-")
	if len(out) > 80 {
		out = strings.Trim(out[:80], "-")
	}
	return out
}
