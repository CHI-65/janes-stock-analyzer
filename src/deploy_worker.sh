#!/usr/bin/env bash
# Deploy src/worker.js to Cloudflare — no node, no npm, no wrangler, no browser.
#
# Talks straight to the Cloudflare REST API with curl. One command, repeatable:
#
#     ./src/deploy_worker.sh
#
# It will:
#   1. read the API token from ~/.config/jsa/cloudflare_token
#   2. make sure the USAGE KV namespace exists (creates it once, remembers the id
#      in wrangler.toml so this file stays the single source of truth)
#   3. upload src/worker.js with the KV + pricing bindings, KEEPING the existing
#      secrets (FINNHUB_KEY / MARKETDATA_KEY / PERPLEXITY_KEY) untouched
#   4. verify the two endpoints that this deploy is supposed to light up
#
# First-time setup — create the token once at
#   https://dash.cloudflare.com/profile/api-tokens  ->  "Create Token"
#   -> use template "Edit Cloudflare Workers" (that grants Workers Scripts:Edit
#      and Workers KV Storage:Edit, which is exactly what this needs)
# then save it:
#   mkdir -p ~/.config/jsa && chmod 700 ~/.config/jsa
#   pbpaste > ~/.config/jsa/cloudflare_token && chmod 600 ~/.config/jsa/cloudflare_token
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

ACCOUNT_ID="21c01debc72d4555fd6d5ad41dbfd4d2"
SCRIPT_NAME="two-sides-proxy"
WORKER_URL="https://two-sides-proxy.calharrisinc.workers.dev"
API="https://api.cloudflare.com/client/v4"
TOKEN_FILE="${CLOUDFLARE_TOKEN_FILE:-$HOME/.config/jsa/cloudflare_token}"
KV_BINDING="USAGE"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# --- token ------------------------------------------------------------------
TOKEN="${CLOUDFLARE_API_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f "$TOKEN_FILE" ]; then
  TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"
fi
[ -n "$TOKEN" ] || die "no API token. Set CLOUDFLARE_API_TOKEN or write one to $TOKEN_FILE (see the header of this file)."

# ok() reads a Cloudflare API envelope on stdin and fails loudly if success!=true
ok() {
  python3 -c '
import json,sys
raw = sys.stdin.read()
try: d = json.loads(raw)
except Exception: sys.exit("non-JSON reply from Cloudflare:\n" + raw[:500])
if not d.get("success"):
    msgs = d.get("errors") or d.get("messages") or raw[:500]
    sys.exit("Cloudflare API refused: " + json.dumps(msgs))
print(json.dumps(d.get("result")))
'
}

say "1/4  Checking token…"
curl -sS "$API/user/tokens/verify" -H "Authorization: Bearer $TOKEN" | ok >/dev/null \
  || die "token rejected — recreate it with the 'Edit Cloudflare Workers' template."
echo "     token OK"

# --- KV namespace -----------------------------------------------------------
say "2/4  Ensuring the $KV_BINDING KV namespace exists…"
KV_ID="$(curl -sS "$API/accounts/$ACCOUNT_ID/storage/kv/namespaces?per_page=100" \
          -H "Authorization: Bearer $TOKEN" | ok |
         python3 -c 'import json,sys; print(next((n["id"] for n in json.load(sys.stdin) if n["title"]=="'"$KV_BINDING"'"), ""))')"

if [ -z "$KV_ID" ]; then
  KV_ID="$(curl -sS -X POST "$API/accounts/$ACCOUNT_ID/storage/kv/namespaces" \
            -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
            --data "{\"title\":\"$KV_BINDING\"}" | ok |
           python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
  echo "     created namespace $KV_ID"
else
  echo "     reusing namespace $KV_ID"
fi

# keep wrangler.toml honest, so a future wrangler user gets the same binding
if grep -q "PASTE_KV_NAMESPACE_ID_HERE" wrangler.toml 2>/dev/null; then
  /usr/bin/sed -i '' "s/PASTE_KV_NAMESPACE_ID_HERE/$KV_ID/" wrangler.toml
  echo "     wrote the id into wrangler.toml"
fi

# --- bindings ---------------------------------------------------------------
# Pricing vars come from the [vars] block in wrangler.toml (single source of truth).
read_var() {
  /usr/bin/awk -v k="$1" '
    $0 ~ /^\[/ { invars = ($0 ~ /^\[vars\]/) }
    invars && $1 == k { for (i=1;i<=NF;i++) if ($i ~ /^"/) { gsub(/"/,"",$i); print $i; exit } }
  ' wrangler.toml
}
PPX_IN="$(read_var PPX_INPUT_PER_M)";  PPX_IN="${PPX_IN:-1}"
PPX_OUT="$(read_var PPX_OUTPUT_PER_M)"; PPX_OUT="${PPX_OUT:-1}"
PPX_FEE="$(read_var PPX_REQUEST_FEE)";  PPX_FEE="${PPX_FEE:-0.005}"
COMPAT="$(/usr/bin/awk -F'"' '/^compatibility_date/ {print $2; exit}' wrangler.toml)"
COMPAT="${COMPAT:-2024-11-01}"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/metadata.json" <<JSON
{
  "main_module": "worker.js",
  "compatibility_date": "$COMPAT",
  "keep_bindings": ["secret_text"],
  "bindings": [
    { "type": "kv_namespace", "name": "$KV_BINDING", "namespace_id": "$KV_ID" },
    { "type": "plain_text", "name": "PPX_INPUT_PER_M",  "text": "$PPX_IN" },
    { "type": "plain_text", "name": "PPX_OUTPUT_PER_M", "text": "$PPX_OUT" },
    { "type": "plain_text", "name": "PPX_REQUEST_FEE",  "text": "$PPX_FEE" }
  ]
}
JSON
python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$TMP/metadata.json" \
  || die "generated metadata.json is not valid JSON"

# --- upload -----------------------------------------------------------------
say "3/4  Uploading src/worker.js ($(wc -c < src/worker.js | tr -d ' ') bytes)…"
curl -sS -X PUT "$API/accounts/$ACCOUNT_ID/workers/scripts/$SCRIPT_NAME" \
  -H "Authorization: Bearer $TOKEN" \
  -F "metadata=@$TMP/metadata.json;type=application/json" \
  -F "worker.js=@src/worker.js;type=application/javascript+module" | ok >/dev/null
echo "     deployed"

# --- verify -----------------------------------------------------------------
say "4/4  Verifying…"
sleep 3
WEEKLY="$(curl -sS -m 40 "$WORKER_URL/maxpain?ticker=AAPL&depth=weekly")"
USAGE="$(curl -sS -m 30 "$WORKER_URL/usage")"

echo "$WEEKLY" | grep -q '"weeks"' \
  && echo "     ✅ weekly max pain live  ($(echo "$WEEKLY" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("weeks",[])), "Fridays")' 2>/dev/null))" \
  || { echo "     ⚠️  /maxpain?depth=weekly did not return weeks[]:"; echo "        ${WEEKLY:0:300}"; }

echo "$USAGE" | grep -q '"users"' \
  && echo "     ✅ /usage live (per-user fee tracking on)" \
  || { echo "     ⚠️  /usage did not return a users map:"; echo "        ${USAGE:0:300}"; }

say "Done."
