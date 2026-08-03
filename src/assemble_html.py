#!/usr/bin/env python3
import io, os
HERE = os.path.dirname(os.path.abspath(__file__))
COMPILED = io.open(os.path.join(HERE, "app.compiled.js"), "r", encoding="utf-8").read()
REACT = io.open(os.path.join(HERE, "reactpkg/node_modules/react/umd/react.production.min.js"), "r", encoding="utf-8").read()
REACTDOM = io.open(os.path.join(HERE, "reactpkg/node_modules/react-dom/umd/react-dom.production.min.js"), "r", encoding="utf-8").read()

HTML = '''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<meta name="theme-color" content="#CDEBF5" />
<title>Jane's Stock Analyzer 3.7</title>
<!-- Add-to-Home-Screen: launches full screen (no address bar) with a clean name -->
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="default" />
<meta name="apple-mobile-web-app-title" content="Jane's Stock Analyzer" />
<style>
  html, body { margin: 0; padding: 0; background: #CDEBF5; }
  #root { min-height: 100vh; }
  * { -webkit-tap-highlight-color: transparent; }
</style>
</head>
<body>
<div id="root"></div>

<!-- Last-resort safety net: if any script throws before the app renders,
     show a friendly message with a reload instead of a blank screen. -->
<script>
  window.addEventListener("error", function (ev) {
    var r = document.getElementById("root");
    if (r && !r.getAttribute("data-ready") && r.children.length === 0) {
      r.innerHTML =
        '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:-apple-system,Arial,sans-serif;color:#1F3A44;text-align:center;padding:24px">' +
        '<div><div style="font-size:44px">\\uD83C\\uDFD6\\uFE0F</div>' +
        '<p style="font-size:17px;max-width:320px;line-height:1.5">Two Sides had trouble starting up. Tap to try again.</p>' +
        '<button onclick="location.reload()" style="font-size:16px;font-weight:700;color:#fff;background:#0E7490;border:none;border-radius:999px;padding:12px 26px;cursor:pointer">Reload</button>' +
        '</div></div>';
    }
  });
</script>

<!-- React 18 baked in (no external dependency, so the app always renders) -->
<script>
__REACT__
</script>
<script>
__REACTDOM__
</script>

<!-- Persistent storage shim: the app was built for the artifact runtime's
     window.storage; here we back it with the browser's localStorage so the
     welcome photo, gallery, and watchlist are remembered between visits. -->
<script>
  (function () {
    var mem = {};
    var ok = false;
    try { localStorage.setItem("__t", "1"); localStorage.removeItem("__t"); ok = true; } catch (e) { ok = false; }
    function key(k) { return "twosides:" + k; }
    window.storage = {
      get: function (k) {
        // The app reads saved data as `saved.value`, so wrap the stored string
        // to match the runtime it was originally written for.
        try {
          var v = ok ? localStorage.getItem(key(k)) : (k in mem ? mem[k] : null);
          return Promise.resolve({ value: v });
        } catch (e) {
          return Promise.resolve({ value: (k in mem ? mem[k] : null) });
        }
      },
      set: function (k, v) {
        try { if (ok) localStorage.setItem(key(k), v); else mem[k] = v; }
        catch (e) { mem[k] = v; }
        return Promise.resolve();
      },
      delete: function (k) {
        try { if (ok) localStorage.removeItem(key(k)); else delete mem[k]; }
        catch (e) { delete mem[k]; }
        return Promise.resolve();
      },
    };
  })();
</script>

<!-- The app (pre-transpiled from JSX) -->
<script>
__APP__
</script>
</body>
</html>
'''

out = (HTML
       .replace("__REACT__", REACT)
       .replace("__REACTDOM__", REACTDOM)
       .replace("__APP__", COMPILED))
io.open(os.path.join(HERE, "..", "app.html"), "w", encoding="utf-8").write(out)
print("OK -> app.html written. bytes:", len(out))
