// Two Sides data proxy - Cloudflare Worker
// Endpoints: /quote  and  /maxpain?depth=quick|deep

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const ticker = (url.searchParams.get("ticker") || "").toUpperCase().replace(/[^A-Z.\-]/g, "");
    if (url.pathname === "/") {
      return json({ ok: true, service: "two-sides-proxy", endpoints: ["/quote?ticker=", "/maxpain?ticker=&depth=quick|deep"] }, 200, cors);
    }
    if (url.pathname === "/ai" && request.method === "POST") {
      try {
        const body = await request.json();
        const out = await askPerplexity(body, env);
        // Per-user fee tracking: log this call's REAL token usage under the caller
        // (body.u). One append-only KV key per call, so the ~5 parallel calls in a
        // single analysis never clobber each other (no read-modify-write race).
        if (env.USAGE) {
          const u = String((body && body.u) || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24) || "unknown";
          const usage = out.usage || {};
          const pt = Number(usage.prompt_tokens) || 0;
          const ct = Number(usage.completion_tokens) || 0;
          const month = new Date().toISOString().slice(0, 7).replace("-", "");
          const key = "ev:" + month + ":" + u + ":" + pt + ":" + ct + ":" + crypto.randomUUID();
          ctx.waitUntil(env.USAGE.put(key, "1", { expirationTtl: 60 * 60 * 24 * 400 }));
        }
        return json(out, 200, cors);
      } catch (e) {
        return json({ error: String(e && e.message || e) }, 502, cors);
      }
    }
    // Per-user usage + estimated fees, aggregated from the append-only event log.
    if (url.pathname === "/usage") {
      if (!env.USAGE) return json({ error: "usage store not configured", users: {} }, 200, cors);
      const month = (url.searchParams.get("month") || new Date().toISOString().slice(0, 7).replace("-", "")).replace(/[^0-9]/g, "");
      const users = {};
      let cursor;
      try {
        do {
          const page = await env.USAGE.list({ prefix: "ev:" + month + ":", cursor, limit: 1000 });
          for (const k of page.keys) {
            // key shape: ev:<month>:<user>:<promptTokens>:<completionTokens>:<uuid>
            const p = k.name.split(":");
            const u = p[2] || "unknown";
            const pt = parseInt(p[3] || "0", 10) || 0;
            const ct = parseInt(p[4] || "0", 10) || 0;
            if (!users[u]) users[u] = { calls: 0, promptTokens: 0, completionTokens: 0 };
            users[u].calls += 1;
            users[u].promptTokens += pt;
            users[u].completionTokens += ct;
          }
          cursor = page.list_complete ? null : page.cursor;
        } while (cursor);
      } catch (e) {
        return json({ error: String(e && e.message || e), users }, 200, cors);
      }
      // Rates are env vars so you can match Perplexity's current Sonar pricing
      // without a code change. Defaults are placeholders — set the real numbers.
      const inRate = parseFloat(env.PPX_INPUT_PER_M || "1");     // $ per 1M input tokens
      const outRate = parseFloat(env.PPX_OUTPUT_PER_M || "1");   // $ per 1M output tokens
      const reqFee = parseFloat(env.PPX_REQUEST_FEE || "0.005"); // $ per request (Sonar search fee)
      for (const u in users) {
        const x = users[u];
        x.estCost = +(x.promptTokens / 1e6 * inRate + x.completionTokens / 1e6 * outRate + x.calls * reqFee).toFixed(4);
      }
      return json({ month, users, rates: { inRate, outRate, reqFee } }, 200, cors);
    }
    if (url.pathname === "/btc") {
      try {
        return json(await getBtc(), 200, cors);
      } catch (e) {
        return json({ error: String(e && e.message || e) }, 502, cors);
      }
    }
    if (url.pathname === "/indexes") {
      try {
        return json(await getIndexes(env), 200, cors);
      } catch (e) {
        return json({ error: String(e && e.message || e) }, 502, cors);
      }
    }
    if (url.pathname === "/cards") {
      const syms = (url.searchParams.get("tickers") || "")
        .toUpperCase().split(",").map((s) => s.replace(/[^A-Z.\-]/g, "")).filter(Boolean).slice(0, 12);
      try {
        // Prices come from ONE batched Yahoo call (real pre-market / after-hours,
        // no per-ticker rate limiting). Logos/names still come from Finnhub, one
        // at a time with a small gap. Any ticker Yahoo misses falls back to a
        // Finnhub regular-session quote so the row still gets a number.
        const quotes = await getYahooQuotesBatch(syms);
        const cards = [];
        for (const s of syms) {
          let q = quotes[s] || null;
          let p = null;
          try { p = await getProfile(s, env); } catch (e) {}
          if (!q || typeof q.price !== "number") {
            try { q = await getQuote(s, env); } catch (e) { q = null; }
          }
          cards.push({
            ticker: s,
            name: (p && p.name) || s,
            logo: (p && p.logo) || null,
            price: q ? q.price : null,
            change: q ? (q.change == null ? null : q.change) : null,
            changePct: q ? q.changePct : null,
            session: q ? (q.session || "regular") : null,
            asOf: q ? q.asOf : null,
            // Both legs, when Yahoo has them, for the MC/AFT toggle. The Finnhub
            // fallback has neither, and the toggle falls back to the single price.
            regular: (q && q.regular) || null,
            post: (q && q.post) || null,
          });
          await sleep(120);
        }
        return json({ cards }, 200, cors);
      } catch (e) {
        return json({ error: String(e && e.message || e) }, 502, cors);
      }
    }
    if (url.pathname === "/ydebug") {
      const tk = (ticker || "AAPL");
      const out = { ticker: tk };
      const cc = await yahooCrumb();
      out.gotCrumb = !!cc;
      if (cc) {
        try {
          const r = await fetch(
            "https://query2.finance.yahoo.com/v7/finance/quote?crumb=" +
              encodeURIComponent(cc.crumb) + "&symbols=" + tk,
            { headers: { Cookie: cc.cookie, "User-Agent": YUA, Accept: "application/json" } }
          );
          out.v7status = r.status;
          const d = await r.json();
          const q = d && d.quoteResponse && d.quoteResponse.result && d.quoteResponse.result[0];
          if (q) {
            out.v7 = {
              marketState: q.marketState,
              regular: q.regularMarketPrice, regularPct: q.regularMarketChangePercent,
              pre: q.preMarketPrice, prePct: q.preMarketChangePercent,
              post: q.postMarketPrice, postPct: q.postMarketChangePercent,
            };
          } else {
            out.v7raw = JSON.stringify(d).slice(0, 300);
          }
        } catch (e) { out.v7err = String(e && e.message || e); }
      }
      try {
        const r = await fetch(
          "https://query1.finance.yahoo.com/v8/finance/chart/" + tk +
            "?interval=2m&range=1d&includePrePost=true",
          { headers: { "User-Agent": YUA, Accept: "application/json" } }
        );
        out.v8status = r.status;
        const d = await r.json();
        const m = d && d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta;
        out.v8meta = m ? { regularMarketPrice: m.regularMarketPrice, prevClose: m.chartPreviousClose, ctp: m.currentTradingPeriod } : null;
      } catch (e) { out.v8err = String(e && e.message || e); }
      return json(out, 200, cors);
    }
    if (!ticker) return json({ error: "missing ticker" }, 400, cors);

    try {
      if (url.pathname === "/quote") {
        return json(await getQuote(ticker, env), 200, cors);
      }
      if (url.pathname === "/profile") {
        return json(await getProfile(ticker, env), 200, cors);
      }
      if (url.pathname === "/card") {
        return json(await getCard(ticker, env), 200, cors);
      }
      if (url.pathname === "/maxpain") {
        const depthParam = url.searchParams.get("depth");
        if (depthParam === "weekly") {
          return json(await getWeeklyMaxPain(ticker, env), 200, cors);
        }
        const depth = depthParam === "deep" ? "deep" : "quick";
        return json(await getMaxPain(ticker, depth, env), 200, cors);
      }
      return json({ error: "not found" }, 404, cors);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 502, cors);
    }
  },
};

// ---- Quote: Yahoo first (includes pre-market / after-hours), Finnhub fallback ----
const YUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Single-ticker quote: reuse the batched Yahoo path (explicit pre/post price),
// then fall back to Finnhub's regular-session quote if Yahoo misses.
async function getQuote(ticker, env) {
  try {
    const b = await getYahooQuotesBatch([ticker]);
    if (b[ticker] && typeof b[ticker].price === "number") return b[ticker];
  } catch (e) {}
  return await getFinnhubQuote(ticker, env);
}

// Yahoo's v7 quote endpoint carries an explicit pre-market and after-hours price
// plus a marketState flag, and takes many symbols in ONE request. It needs a
// cookie + crumb handshake, which we do once per batch.
async function yahooCrumb() {
  try {
    const r1 = await fetch("https://fc.yahoo.com/", { headers: { "User-Agent": YUA } });
    let cookie = "";
    try {
      const sc = typeof r1.headers.getSetCookie === "function" ? r1.headers.getSetCookie() : null;
      if (sc && sc.length) cookie = sc.map((c) => c.split(";")[0]).join("; ");
    } catch (e) {}
    if (!cookie) {
      const one = r1.headers.get("set-cookie");
      if (one) cookie = one.split(";")[0];
    }
    if (!cookie) return null;
    const r2 = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
      headers: { Cookie: cookie, "User-Agent": YUA, Accept: "text/plain" },
    });
    const crumb = (await r2.text()).trim();
    if (!crumb || crumb.length > 40 || /[<\s]/.test(crumb)) return null;
    return { cookie, crumb };
  } catch (e) {
    return null;
  }
}

// Returns { SYM: {ticker, price, change, changePct, session, asOf, source} } for
// whatever symbols Yahoo answers. Picks pre/post/regular price by marketState.
async function getYahooQuotesBatch(tickers) {
  const out = {};
  const list = (tickers || []).filter(Boolean);
  if (!list.length) return out;
  const cc = await yahooCrumb();
  if (!cc) return out;
  try {
    const url =
      "https://query2.finance.yahoo.com/v7/finance/quote?crumb=" +
      encodeURIComponent(cc.crumb) +
      "&symbols=" + encodeURIComponent(list.join(","));
    const r = await fetch(url, {
      headers: { Cookie: cc.cookie, "User-Agent": YUA, Accept: "application/json" },
    });
    const d = await r.json();
    const arr = (d && d.quoteResponse && d.quoteResponse.result) || [];
    for (const q of arr) {
      const sym = (q.symbol || "").toUpperCase();
      const state = q.marketState || "REGULAR";
      let price = null, changePct = null, session = "regular", t = q.regularMarketTime;
      if (state === "PRE" && typeof q.preMarketPrice === "number") {
        price = q.preMarketPrice; changePct = q.preMarketChangePercent; session = "pre"; t = q.preMarketTime;
      } else if ((state === "POST" || state === "POSTPOST") && typeof q.postMarketPrice === "number") {
        price = q.postMarketPrice; changePct = q.postMarketChangePercent; session = "post"; t = q.postMarketTime;
      } else if (typeof q.regularMarketPrice === "number") {
        price = q.regularMarketPrice; changePct = q.regularMarketChangePercent; session = "regular"; t = q.regularMarketTime;
      }
      // Also hand back the regular-close and after-hours figures side by side, so
      // the watchlist's MC/AFT toggle can switch between them without refetching.
      const leg = (p, pct, ts) =>
        typeof p === "number"
          ? { price: p, changePct: typeof pct === "number" ? pct : null, asOf: ts ? new Date(ts * 1000).toISOString() : null }
          : null;
      if (typeof price === "number") {
        out[sym] = {
          ticker: sym,
          price,
          change: typeof q.regularMarketChange === "number" ? q.regularMarketChange : null,
          changePct: typeof changePct === "number" ? changePct : null,
          session,
          asOf: t ? new Date(t * 1000).toISOString() : null,
          source: "yahoo-q",
          regular: leg(q.regularMarketPrice, q.regularMarketChangePercent, q.regularMarketTime),
          post: leg(q.postMarketPrice, q.postMarketChangePercent, q.postMarketTime),
        };
      }
    }
  } catch (e) {}
  return out;
}

// ---- Finnhub quote (free, regular session only) ----
// Retry once on a miss: a rate-limited call comes back empty, and a short pause
// usually clears it.
async function getFinnhubQuote(ticker, env) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${env.FINNHUB_KEY}`);
    let q = null;
    try { q = await r.json(); } catch (e) { q = null; }
    if (q && typeof q.c === "number" && q.c !== 0) {
      return {
        ticker,
        price: q.c,
        change: q.d,
        changePct: q.dp,
        session: "regular",
        asOf: q.t ? new Date(q.t * 1000).toISOString() : null,
        source: "finnhub",
      };
    }
    if (attempt === 0) await sleep(300);
  }
  throw new Error("no quote for " + ticker);
}

// ---- Finnhub company profile (free): name + logo ----
async function getProfile(ticker, env) {
  const r = await fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${ticker}&token=${env.FINNHUB_KEY}`);
  const p = await r.json();
  return {
    ticker,
    name: (p && p.name) || ticker,
    logo: (p && p.logo) || null,
    exchange: (p && p.exchange) || null,
    currency: (p && p.currency) || null,
  };
}

// ---- One call for a watchlist row: name + logo + live price + change ----
async function getCard(ticker, env) {
  const [q, p] = await Promise.all([
    getQuote(ticker, env).catch(() => null),
    getProfile(ticker, env).catch(() => null),
  ]);
  if (!q && !p) throw new Error("no data for " + ticker);
  return {
    ticker,
    name: (p && p.name) || ticker,
    logo: (p && p.logo) || null,
    price: q ? q.price : null,
    change: q ? q.change : null,
    changePct: q ? q.changePct : null,
    session: q ? (q.session || "regular") : null,
    asOf: q ? q.asOf : null,
  };
}

// ---- Perplexity AI proxy (writes the bull/bear research) ----
async function askPerplexity(body, env) {
  const prompt = (body && body.prompt) || "";
  const model = (body && body.model) || "sonar";
  const r = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.PERPLEXITY_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const raw = await r.text();
  let d;
  try { d = JSON.parse(raw); } catch (e) { d = null; }
  if (!d || !d.choices || !d.choices[0]) {
    const msg = d && d.error ? (d.error.message || d.error) : raw.slice(0, 300);
    throw new Error("Perplexity http=" + r.status + " :: " + msg);
  }
  let text = (d.choices[0].message && d.choices[0].message.content) || "";
  text = text.replace(/\[\d+\]/g, ""); // strip [1][2] citation markers Sonar can add
  // Include Perplexity's token usage so the /ai route can record real per-user
  // cost. The app ignores this field; it only reads `text`.
  return { text, usage: d.usage || null };
}

// ---- Bitcoin price (free, no key, server-friendly) ----
// Try Kraken first (gives price + 24h change), fall back to Coinbase (price only).
// CoinGecko is avoided: it rate-limits/blocks Cloudflare Worker IPs.
async function getBtc() {
  // 1) Kraken — has the day's open, so we can compute a change %.
  try {
    const r = await fetch("https://api.kraken.com/0/public/Ticker?pair=XBTUSD");
    const d = await r.json();
    const res = d && d.result;
    const key = res && Object.keys(res)[0];
    const t = key && res[key];
    if (t && t.c && t.c[0]) {
      const price = parseFloat(t.c[0]);
      const open = t.o ? parseFloat(t.o) : null;
      const changePct = open && open > 0 ? ((price - open) / open) * 100 : null;
      if (price > 0) return { price, changePct, source: "kraken" };
    }
  } catch (e) {}

  // 2) Coinbase spot — very permissive, but price only (no change).
  try {
    const r = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot");
    const d = await r.json();
    const price = d && d.data && d.data.amount ? parseFloat(d.data.amount) : null;
    if (price && price > 0) return { price, changePct: null, source: "coinbase" };
  } catch (e) {}

  throw new Error("no btc price");
}

// ---- Stock index levels (Dow + Nasdaq), free, no key ----
// Yahoo Finance is the primary source (gives level + prior close); stooq is a
// fallback. Both are fetched server-side, so no browser CORS issues.
async function getIndexes(env) {
  async function yahoo(sym) {
    try {
      const r = await fetch(
        "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(sym) + "?interval=1d&range=1d",
        { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } }
      );
      const d = await r.json();
      const m = d && d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta;
      if (m && typeof m.regularMarketPrice === "number") {
        const price = m.regularMarketPrice;
        const prev = m.chartPreviousClose || m.previousClose;
        const changePct = prev && prev > 0 ? ((price - prev) / prev) * 100 : null;
        return { price, changePct };
      }
    } catch (e) {}
    return null;
  }
  async function stooq(sym) {
    try {
      const r = await fetch("https://stooq.com/q/l/?s=" + sym + "&f=sd2t2ohlc&h&e=csv");
      const t = await r.text();
      const lines = t.trim().split("\n");
      if (lines.length >= 2) {
        const c = lines[1].split(",");
        // symbol,date,time,open,high,low,close
        const close = parseFloat(c[6]);
        const open = parseFloat(c[3]);
        if (close > 0) return { price: close, changePct: open > 0 ? ((close - open) / open) * 100 : null };
      }
    } catch (e) {}
    return null;
  }
  let dow = await yahoo("^DJI");
  let nasdaq = await yahoo("^IXIC");
  if (!dow) dow = await stooq("^dji");
  if (!nasdaq) nasdaq = await stooq("^ndq");

  // Backstop: if the free feeds are blocked, ask Perplexity (costs a little,
  // so only used when the free sources come back empty).
  if ((!dow || !nasdaq) && env && env.PERPLEXITY_KEY) {
    try {
      const ai = await askPerplexity(
        {
          prompt:
            'Give the current index level and today\'s percent change for the Dow Jones Industrial Average and the Nasdaq Composite. Respond with ONLY minified JSON and nothing else: {"dow":{"price":NUMBER,"changePct":NUMBER},"nasdaq":{"price":NUMBER,"changePct":NUMBER}}. Use plain numbers with no commas, $, or % signs.',
          model: "sonar",
        },
        env
      );
      const txt = (ai.text || "").replace(/```json|```/g, "").trim();
      const a = txt.indexOf("{"), b = txt.lastIndexOf("}");
      if (a !== -1 && b !== -1) {
        const p = JSON.parse(txt.slice(a, b + 1));
        if (!dow && p.dow && typeof p.dow.price === "number") dow = p.dow;
        if (!nasdaq && p.nasdaq && typeof p.nasdaq.price === "number") nasdaq = p.nasdaq;
      }
    } catch (e) {}
  }
  return { dow, nasdaq };
}

// ---- MarketData options -> max pain ----
// Fetch one live expiration (nearest to `dte` days out). Pinning to a dte target
// keeps MarketData from returning already-expired contracts (which error the full chain).
async function fetchChainByDte(ticker, dte, strikeLimit, env) {
  const base = `https://api.marketdata.app/v1/options/chain/${ticker}/`;
  const params = new URLSearchParams();
  params.set("dte", String(dte));
  if (strikeLimit) params.set("strikeLimit", String(strikeLimit));
  const r = await fetch(base + "?" + params.toString(), {
    headers: { Authorization: `Bearer ${env.MARKETDATA_KEY}` },
  });
  const raw = await r.text();
  let c;
  try { c = JSON.parse(raw); } catch (e) { c = null; }
  if (!c || (c.s !== "ok" && !Array.isArray(c.optionSymbol))) {
    const msg = c && (c.errmsg || c.error) ? (c.errmsg || c.error) : raw.slice(0, 300);
    throw new Error("MarketData " + ticker + " http=" + r.status + " s=" + (c && c.s) + " :: " + msg);
  }
  const n = c.optionSymbol.length;
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      exp: c.expiration[i],
      strike: c.strike[i],
      side: c.side[i],
      oi: c.openInterest[i] || 0,
    });
  }
  return rows;
}

function computeMaxPain(rows) {
  const strikeSet = {};
  const calls = {};
  const puts = {};
  for (const x of rows) {
    strikeSet[x.strike] = true;
    if (x.side === "call") calls[x.strike] = (calls[x.strike] || 0) + x.oi;
    else if (x.side === "put") puts[x.strike] = (puts[x.strike] || 0) + x.oi;
  }
  const strikes = Object.keys(strikeSet).map(Number).sort((a, b) => a - b);
  let best = null;
  let bestPain = Infinity;
  for (const S of strikes) {
    let pain = 0;
    for (const K of strikes) {
      if (K < S) pain += (S - K) * (calls[K] || 0);
      if (K > S) pain += (K - S) * (puts[K] || 0);
    }
    if (pain < bestPain) { bestPain = pain; best = S; }
  }
  return { maxPain: best, strikesConsidered: strikes.length };
}

// Max pain for the next several WEEKLY expirations (the app's "Expand" view).
// Pull option chains around weekly dte offsets, dedup by actual expiration, then
// compute one max pain per expiration. dte=1 (not 0) reliably captures the
// nearest Friday without tripping MarketData's already-expired guard.
async function getWeeklyMaxPain(ticker, env) {
  const targets = [1, 8, 15, 22, 29];
  const byExp = {};
  for (const t of targets) {
    let batch;
    try { batch = await fetchChainByDte(ticker, t, 40, env); }
    catch (e) { batch = []; }
    for (const x of batch) {
      if (!byExp[x.exp]) byExp[x.exp] = [];
      byExp[x.exp].push(x);
    }
  }
  const exps = Object.keys(byExp).map(Number).sort((a, b) => a - b).slice(0, 4);
  if (!exps.length) throw new Error("no live weekly expirations for " + ticker);
  let spot = null;
  try { spot = (await getQuote(ticker, env)).price; } catch (e) {}
  const weeks = exps.map((e) => {
    const mp = computeMaxPain(byExp[e]);
    return {
      expiration: new Date(e * 1000).toISOString().slice(0, 10),
      maxPain: mp.maxPain,
      strikesConsidered: mp.strikesConsidered,
    };
  });
  return { ticker, spot, weeks };
}

async function getMaxPain(ticker, depth, env) {
  let rows;
  let expLabel;
  let expirationsUsed;

  if (depth === "deep") {
    // Aggregate the next several monthly cycles (each pinned to a live expiration).
    const targets = [25, 55, 85, 115];
    const byExp = {};
    for (const t of targets) {
      let batch;
      try { batch = await fetchChainByDte(ticker, t, 80, env); }
      catch (e) { batch = []; }
      for (const x of batch) {
        if (!byExp[x.exp]) byExp[x.exp] = [];
        byExp[x.exp].push(x);
      }
    }
    const exps = Object.keys(byExp).map(Number).sort((a, b) => a - b);
    if (!exps.length) throw new Error("no live expirations for " + ticker);
    rows = [];
    for (const e of exps) rows = rows.concat(byExp[e]);
    expirationsUsed = exps.length;
    expLabel = exps.length + " expirations through " +
      new Date(Math.max.apply(null, exps) * 1000).toISOString().slice(0, 10);
  } else {
    // quick: single nearest-to-30-day expiration, near-the-money strikes.
    rows = await fetchChainByDte(ticker, 30, 40, env);
    const nearest = Math.min.apply(null, rows.map((x) => x.exp));
    rows = rows.filter((x) => x.exp === nearest);
    expirationsUsed = 1;
    expLabel = new Date(nearest * 1000).toISOString().slice(0, 10);
  }

  const mp = computeMaxPain(rows);

  let spot = null;
  try { spot = (await getQuote(ticker, env)).price; } catch (e) {}

  return {
    ticker,
    maxPain: mp.maxPain,
    spot,
    expiration: expLabel,
    expirationsUsed,
    strikesConsidered: mp.strikesConsidered,
    depth,
  };
}

// ---- helpers ----
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function corsHeaders(origin, env) {
  const allow = (env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim());
  const ok = allow.indexOf("*") !== -1 ? "*" : (allow.indexOf(origin) !== -1 ? origin : allow[0]);
  return {
    "Access-Control-Allow-Origin": ok,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}
