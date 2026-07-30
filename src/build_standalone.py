#!/usr/bin/env python3
# Convert the artifact app (v40) -> standalone React module (v41.jsx).
# - callClaude routes through the Cloudflare /ai proxy (Perplexity Sonar)
# - hard data (btc, cards, max pain) comes straight from the real feeds via the proxy
# - React becomes a global (loaded from CDN in the HTML wrapper)
import io, sys, os
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "two-sides-for-jane-v40.jsx")
DST = os.path.join(HERE, "two-sides-standalone-v41.jsx")
s = io.open(SRC, "r", encoding="utf-8").read()

def repl(old, new, label):
    n = s.count(old)
    if n != 1:
        print("!! ANCHOR '%s' matched %d times (need 1) -- ABORT" % (label, n)); sys.exit(1)
    return s.replace(old, new)

# 1) React import -> global destructure
s = repl(
    'import React, { useState, useRef, useEffect } from "react";',
    'const { useState, useRef, useEffect } = React;',
    "react import")

# 2) export default -> plain function (we render it ourselves at the end)
s = repl("export default function App() {", "function App() {", "App export")

# 3) callClaude -> POST to the /ai proxy (Perplexity). Keep the (prompt, useSearch)
#    signature so every existing call site keeps working; useSearch is ignored
#    because Sonar always searches the web.
OLD_CC = '''  const callClaude = async (prompt, useSearch) => {
    const body = {
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    };
    if (useSearch) {
      body.tools = [{ type: "web_search_20250305", name: "web_search" }];
    }
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (data && data.error) {
      throw new Error(`API error: ${data.error.message || data.error.type}`);
    }
    // Join WITHOUT separators: web-search answers arrive as many small
    // text fragments, and inserting newlines between them breaks the JSON
    const text = data.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    const clean = text.replace(/```json|```/g, "").trim();
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("No JSON in reply");
    return JSON.parse(clean.slice(start, end + 1));
  };'''
NEW_CC = '''  // The narrative research runs through our Cloudflare proxy, which calls
  // Perplexity Sonar (web-search native) with the key kept server-side.
  // useSearch is accepted for call-site compatibility but ignored (Sonar
  // always searches). We ask for JSON and pull the first {...} block out.
  const callClaude = async (prompt, useSearch) => {
    const response = await fetch(`${PROXY}/ai`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, model: "sonar" }),
    });
    const data = await response.json();
    if (!data || data.error) {
      throw new Error("AI error: " + ((data && data.error) || "no response"));
    }
    const text = (data.text || "").replace(/```json|```/g, "").trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("No JSON in reply");
    return JSON.parse(text.slice(start, end + 1));
  };'''
s = repl(OLD_CC, NEW_CC, "callClaude")

# 4) Data helpers -> straight to the real feeds via the proxy (no AI for hard numbers)
OLD_DATA = '''  // The published-artifact sandbox only permits network calls to Anthropic's own
  // servers, so the data proxy can't be fetched directly. Instead we ask Claude
  // (which reaches the web through its search tool) to open the proxy URL and hand
  // back the JSON verbatim.
  const relayViaAI = async (path) => {
    const prompt = `Use the web_search tool to open this exact URL and read the JSON body it returns, then reply with ONLY that raw JSON \\u2014 no commentary, no code fences, no citations, no extra words. If you cannot open it, reply with {"error":"unreachable"}.\\nURL: ${PROXY}${path}`;
    return await callClaude(prompt, true);
  };

  const btcPrompt = `Search the web for the current price of Bitcoin (BTC) in US dollars and its percent change over the last 24 hours. Respond with ONLY minified JSON and nothing else: {"price": PRICE_AS_NUMBER, "changePct": TWENTY_FOUR_HOUR_PERCENT_CHANGE_AS_NUMBER}`;
  const getBtc = async () => await callClaude(btcPrompt, true);

  const getCards = async (syms) => {
    const list = (syms || []).join(", ");
    const prompt = `Search the web for the latest available stock price (use the last closing price if markets are closed) and that day's percent change for EACH of these ticker symbols: ${list}. Respond with ONLY minified JSON and nothing else, one object per ticker, in the same order: {"cards":[{"ticker":"SYMBOL","name":"Company Name","price":PRICE_NUMBER,"changePct":PERCENT_CHANGE_NUMBER}]}. Use plain numbers with no $ or % signs. If unsure of a value, use null.`;
    return await callClaude(prompt, true);
  };
  const getMaxPain = async (sym) => {
    const prompt = `Search the web for the options "max pain" price (the max pain strike) for the stock ${sym} for the nearest monthly options expiration, plus its current share price. Max pain is the strike price at which the greatest dollar value of options would expire worthless. Respond with ONLY minified JSON and nothing else: {"maxPain":STRIKE_PRICE_NUMBER,"spot":CURRENT_PRICE_NUMBER_OR_NULL,"expiration":"the expiration date or a short label like 'Aug 2026'"}. Use plain numbers with no $ signs. If you cannot find a max pain figure, respond {"maxPain":null}.`;
    return await callClaude(prompt, true);
  };'''
NEW_DATA = '''  // Hard numbers come straight from the real feeds (Finnhub / MarketData / Kraken)
  // through the proxy \\u2014 never the AI. This is the whole point of the data server.
  const getBtc = async () => {
    const r = await fetch(`${PROXY}/btc`);
    const d = await r.json();
    if (!d || typeof d.price !== "number") throw new Error("no btc price");
    return d;
  };
  const getCards = async (syms) => {
    const list = (syms || []).join(",");
    const r = await fetch(`${PROXY}/cards?tickers=${encodeURIComponent(list)}`);
    const d = await r.json();
    if (!d || !Array.isArray(d.cards)) throw new Error("no cards");
    return d;
  };
  const getMaxPain = async (sym) => {
    const r = await fetch(`${PROXY}/maxpain?ticker=${encodeURIComponent(sym)}`);
    const d = await r.json();
    if (!d || typeof d.maxPain !== "number") throw new Error("no max pain");
    return d;
  };
  const getIndexes = async () => {
    const r = await fetch(`${PROXY}/indexes`);
    return await r.json();
  };
  // Free-form AI question (returns raw text, not JSON) via the Perplexity proxy.
  const askAI = async (question) => {
    const r = await fetch(`${PROXY}/ai`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: question, model: "sonar" }),
    });
    const d = await r.json();
    if (!d || d.error) throw new Error((d && d.error) || "AI error");
    return d.text || "";
  };'''
s = repl(OLD_DATA, NEW_DATA, "data helpers")

# 5) footer version
s = repl(">v40</span>", ">v50</span>", "footer version")

# 6) render the app ourselves (artifact runtime used to do this), with a
#    safety net so a failure shows a message + reload instead of a blank page.
s = s.rstrip() + '''

try {
  const __root = ReactDOM.createRoot(document.getElementById("root"));
  __root.render(React.createElement(App));
} catch (__e) {
  if (typeof console !== "undefined") console.error(__e);
  var __r = document.getElementById("root");
  if (__r) {
    __r.innerHTML =
      '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:-apple-system,Arial,sans-serif;color:#1F3A44;text-align:center;padding:24px">' +
      '<div><div style="font-size:44px">\\uD83C\\uDFD6\\uFE0F</div>' +
      '<p style="font-size:17px;max-width:320px;line-height:1.5">Two Sides had trouble starting up. Tap to try again.</p>' +
      '<button onclick="location.reload()" style="font-size:16px;font-weight:700;color:#fff;background:#0E7490;border:none;border-radius:999px;padding:12px 26px;cursor:pointer">Reload</button>' +
      '</div></div>';
  }
}
'''

io.open(DST, "w", encoding="utf-8").write(s)
print("OK -> v41 standalone written. len:", len(s))
