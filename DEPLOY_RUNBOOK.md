# Deploy runbook — worker update for per-user API-fee tracking

The app side already ships (tap the footer version 5× → **Usage & fees**). This
one-time worker deploy adds **token-exact** cost and a **combined Cal + Jane**
view (the app's admin panel lights up automatically once this is live).

You need: Node/npm on your machine, and access to the Cloudflare account that
owns `two-sides-proxy` (account id `21c01debc72d4555fd6d5ad41dbfd4d2`).

Run these from the repo root (`janes-stock-analyzer/`):

```bash
# 1. Wrangler (Cloudflare's CLI) + sign in (opens a browser)
npm install -g wrangler
wrangler login

# 2. Create the KV store that holds usage, then copy the printed id
wrangler kv namespace create USAGE
#   -> prints something like:  id = "abc123..."
#   Paste that id into wrangler.toml, replacing PASTE_KV_NAMESPACE_ID_HERE

# 3. (optional) set real Perplexity Sonar pricing so dollars are accurate.
#    Either edit the [vars] block in wrangler.toml, or:
#    wrangler secret put PPX_INPUT_PER_M     (then PPX_OUTPUT_PER_M, PPX_REQUEST_FEE)

# 4. Deploy
wrangler deploy
```

**Verify:**

```bash
curl "https://two-sides-proxy.calharrisinc.workers.dev/usage"
# -> {"month":"YYYYMM","users":{...},"rates":{...}}
```

Then run an analysis in the app, reopen the admin panel — the **Combined ·
token-exact** rows appear.

## How it works
- Every `/ai` call already carries `u=cal|jane` (from the app). The worker logs
  each call's real Perplexity token usage as one append-only KV key
  (`ev:<month>:<user>:<in>:<out>:<uuid>`) — one key per call, so the ~5 parallel
  calls in an analysis never overwrite each other.
- `/usage` sums the current month's keys per user and multiplies tokens by the
  rate vars to produce `estCost`. Keys auto-expire after ~13 months.

## Also included in this deploy
`src/worker.js` also adds **`/maxpain?depth=weekly`** — max pain for the next ~4
weekly (Friday) option expirations, powering the **Expand** button on the deep
dive's Max pain card. Until deployed, that button shows a friendly "not live
yet" note. Verify after deploy:

```bash
curl "https://two-sides-proxy.calharrisinc.workers.dev/maxpain?ticker=AAPL&depth=weekly"
# -> {"ticker":"AAPL","spot":...,"weeks":[{"expiration":"YYYY-MM-DD","maxPain":...}, ...]}
```

## Safe to deploy
Until the `USAGE` binding exists the worker behaves exactly as today, and
`/usage` simply returns `"usage store not configured"`. The API-key secrets
(`FINNHUB_KEY`, `MARKETDATA_KEY`, `PERPLEXITY_KEY`) persist across deploys —
don't re-enter them.
