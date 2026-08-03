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
        // Overnight is a page scrape, one load per ticker, so only pay for it
        // inside the 8pm-4am ET window when Blue Ocean is actually trading.
        const ovn = inOvernightWindow() ? await getYahooOvernight(syms, env) : {};
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
            // Every leg Yahoo has, plus the market state, for the price toggle.
            // The Finnhub fallback has none of it, and the toggle then falls
            // back to the single regular-session price it does return.
            marketState: (q && q.marketState) || null,
            pre: (q && q.pre) || null,
            regular: (q && q.regular) || null,
            post: (q && q.post) || null,
            overnight: ovn[s] || null,
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
            // EVERY key Yahoo sends, unfiltered — the only way to be sure a new
            // session (e.g. overnight) isn't hiding under a name we didn't guess.
            out.v7keys = Object.keys(q).sort();
            out.v7night = {};
            Object.keys(q).forEach((k) => { if (/night|extend|blue|ocean|24/i.test(k)) out.v7night[k] = q[k]; });
          } else {
            out.v7raw = JSON.stringify(d).slice(0, 300);
          }
        } catch (e) { out.v7err = String(e && e.message || e); }
      }
      try {
        const r = await fetch(
          "https://query1.finance.yahoo.com/v8/finance/chart/" + tk +
            "?interval=1m&range=5d&includePrePost=true",
          { headers: { "User-Agent": YUA, Accept: "application/json" } }
        );
        out.v8status = r.status;
        const d = await r.json();
        const res = d && d.chart && d.chart.result && d.chart.result[0];
        const m = res && res.meta;
        out.v8meta = m ? { regularMarketPrice: m.regularMarketPrice, prevClose: m.chartPreviousClose, ctp: m.currentTradingPeriod } : null;
        // How far either side of the regular session do real prints actually go?
        // If an overnight session (20:00-04:00 ET) were in this feed, some day
        // would show a first/last outside the 04:00-20:00 extended window.
        if (res && res.timestamp) {
          const closes = (res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close) || [];
          const days = {};
          res.timestamp.forEach((t, i) => {
            if (closes[i] == null) return;
            const et = new Date((t - 4 * 3600) * 1000); // ET = UTC-4 in summer
            const day = et.toISOString().slice(0, 10);
            const hhmm = et.toISOString().slice(11, 16);
            if (!days[day]) days[day] = { first: hhmm, last: hhmm, n: 0 };
            if (hhmm < days[day].first) days[day].first = hhmm;
            if (hhmm > days[day].last) days[day].last = hhmm;
            days[day].n++;
          });
          out.v8span = days;
        }
      } catch (e) { out.v8err = String(e && e.message || e); }
      // The overnight (Blue Ocean) print only exists on the quote PAGE.
      try {
        const o = await getYahooOvernight([tk], env);
        out.overnight = o[tk] || null;
        out.overnightWindow = inOvernightWindow();
      } catch (e) { out.overnightErr = String(e && e.message || e); }
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
      // Which expirations are actually listed right now (MarketData's own list,
      // so "is there one expiring today?" is answered by the venue, not by us
      // guessing from a day count).
      if (url.pathname === "/expirations") {
        const r = await fetch(`https://api.marketdata.app/v1/options/expirations/${ticker}/`, {
          headers: { Authorization: `Bearer ${env.MARKETDATA_KEY}` },
        });
        const raw = await r.text();
        let d = null;
        try { d = JSON.parse(raw); } catch (e) {}
        return json({ ticker, http: r.status, expirations: (d && d.expirations) || [], status: d && d.s, raw: d ? undefined : raw.slice(0, 300) }, 200, cors);
      }
      if (url.pathname === "/maxpain") {
        // Exact expiration wins when given: /maxpain?ticker=AAPL&exp=2026-08-03
        const expParam = (url.searchParams.get("exp") || "").replace(/[^0-9-]/g, "");
        if (expParam) {
          // strikeLimit trims the chain around the money; too tight a window
          // biases max pain toward whichever side survived the trim.
          const lim = parseInt(url.searchParams.get("strikes") || "0", 10) || 0;
          const rows = await fetchChainByDte(ticker, null, lim || null, env, expParam);
          const mp = computeMaxPain(rows);
          let spot = null;
          try { spot = (await getQuote(ticker, env)).price; } catch (e) {}
          const out = { ticker, expiration: expParam, maxPain: mp.maxPain, strikesConsidered: mp.strikesConsidered, spot, contracts: rows.length };
          if (url.searchParams.get("detail")) {
            const by = {};
            for (const x of rows) {
              if (!by[x.strike]) by[x.strike] = { strike: x.strike, call: 0, put: 0 };
              by[x.strike][x.side === "call" ? "call" : "put"] += x.oi;
            }
            out.topOi = Object.values(by)
              .sort((a, b) => (b.call + b.put) - (a.call + a.put))
              .slice(0, 10);
            out.totalCallOi = rows.filter((x) => x.side === "call").reduce((n, x) => n + x.oi, 0);
            out.totalPutOi = rows.filter((x) => x.side === "put").reduce((n, x) => n + x.oi, 0);
          }
          return json(out, 200, cors);
        }
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
      // Also hand back all three legs side by side plus the raw market state, so
      // the watchlist's toggle can offer whichever extended session is current
      // (PRE before the open, AFT after it) without refetching.
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
          marketState: state,
          pre: leg(q.preMarketPrice, q.preMarketChangePercent, q.preMarketTime),
          regular: leg(q.regularMarketPrice, q.regularMarketChangePercent, q.regularMarketTime),
          post: leg(q.postMarketPrice, q.postMarketChangePercent, q.postMarketTime),
        };
      }
    }
  } catch (e) {}
  return out;
}

// ---- Overnight session (Blue Ocean ATS, 8pm-4am ET) ----
// Yahoo's JSON quote API has no overnight field — only pre/regular/post. The
// quote PAGE does server-render it, as "<price> <change> (<pct>%) Overnight:
// <time>", so that's where this reads from. Scraping is more brittle than an
// API, so every failure here is silent: no overnight leg, and the app just
// doesn't offer the OVN choice.

// Blue Ocean runs Sunday 8pm through Friday 4am ET. Outside that there is
// nothing to fetch, so we skip the page loads entirely rather than pay for
// twelve 2 MB downloads on every daytime refresh.
function etParts() {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "numeric", hour12: false,
  });
  const p = {};
  f.formatToParts(new Date()).forEach((x) => { p[x.type] = x.value; });
  const days = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { hour: parseInt(p.hour, 10) % 24, dow: days[p.weekday] };
}
function inOvernightWindow() {
  const { hour, dow } = etParts();
  if (hour >= 20) return dow >= 0 && dow <= 4;  // Sun-Thu evening
  if (hour < 4) return dow >= 1 && dow <= 5;    // Mon-Fri small hours
  return false;
}

// Pull the overnight quote for each ticker. Pages are fetched in parallel and
// cached briefly in KV, because this is one full page load per ticker.
async function getYahooOvernight(tickers, env) {
  const out = {};
  const list = (tickers || []).filter(Boolean);
  if (!list.length) return out;
  await Promise.all(list.map(async (t) => {
    try {
      const kvKey = "ovn:" + t;
      if (env && env.USAGE) {
        const hit = await env.USAGE.get(kvKey);
        if (hit) { out[t] = JSON.parse(hit); return; }
      }
      const r = await fetch("https://finance.yahoo.com/quote/" + encodeURIComponent(t) + "/", {
        headers: { "User-Agent": YUA, Accept: "text/html" },
      });
      if (!r.ok) return;
      const html = await r.text();
      const q = parseOvernight(html);
      if (!q) return;
      out[t] = q;
      if (env && env.USAGE) await env.USAGE.put(kvKey, JSON.stringify(q), { expirationTtl: 60 });
    } catch (e) {}
  }));
  return out;
}

// The markup around the label is "…308.95 +0.04 (+0.01%) Overnight: 2:29 AM EDT".
// Take the text just before the label, strip tags, and read the last
// price/change/percent triple out of it. indexOf + a short slice on purpose:
// a regex across the whole 2 MB page blows the worker's CPU budget.
function parseOvernight(html) {
  // "Overnight:" appears several times (nav labels, disclaimers). Only one of
  // them has a price triple in front of it, so try each until one parses.
  let at = html.indexOf("Overnight:");
  while (at !== -1) {
    // 6 KB of RAW html — the visible numbers are only ~120 characters of text,
    // but the markup between them is bulky, so a small raw window misses them.
    const text = html.slice(Math.max(0, at - 6000), at).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    // The sign is OPTIONAL: when a stock is exactly flat overnight Yahoo prints
    // "308.91 0.00 (0.00%)" with no +/-. Requiring a sign made the parser skip it
    // and silently fall back to the "At close" triple further up the page.
    const re = /([\d,]+\.\d+)\s+([+-]?[\d,]*\.?\d+)\s+\(([+-]?[\d.]+)%\)/g;
    let m, last = null;
    while ((m = re.exec(text))) last = m;
    // The overnight triple sits immediately before the label. Anything further
    // back is a different quote block ("At close: …"), so reject it rather than
    // report the wrong number.
    if (last && text.length - (last.index + last[0].length) > 30) last = null;
    if (last) {
      const price = parseFloat(last[1].replace(/,/g, ""));
      const changePct = parseFloat(last[3]);
      if (isFinite(price) && isFinite(changePct)) {
        // The timestamp Yahoo prints here is "as of now" during the session.
        const tail = html.slice(at + 10, at + 60);
        const cut = tail.indexOf("<");
        const asOf = (cut === -1 ? tail : tail.slice(0, cut)).trim();
        return { price, changePct, asOf: asOf || null, source: "yahoo-page" };
      }
    }
    at = html.indexOf("Overnight:", at + 1);
  }
  return null;
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
async function fetchChainByDte(ticker, dte, strikeLimit, env, exp) {
  const base = `https://api.marketdata.app/v1/options/chain/${ticker}/`;
  const params = new URLSearchParams();
  // An explicit expiration beats a day-count target: dte picks the NEAREST
  // expiration, which can silently land on a past Friday.
  if (exp) params.set("expiration", exp);
  else params.set("dte", String(dte));
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
  // dte matching can hand back an expiration that has ALREADY passed (a dte=1
  // request on a Monday returned the previous Friday), so drop anything before
  // today before taking the next four.
  const todayET = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const exps = Object.keys(byExp).map(Number)
    .filter((e) => new Date(e * 1000).toISOString().slice(0, 10) >= todayET)
    .sort((a, b) => a - b).slice(0, 4);
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
