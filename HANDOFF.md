# Handoff — janes-stock-analyzer

Written 2026-07-27, from a sandboxed container session, for a session picking this up
on a real machine.

## Status: untouched this session

**No work was done in this repo.** The session that wrote this ("CTW app build 1")
spent its entire time in **`CTW-projects`**, on the Beat Relay drum machine's
microphone sampler. This file exists only so you don't go hunting for changes that
were never made.

- Branch `claude/ctw-app-build-1-tzv5tc` is level with `main` at `20adcfa` — zero
  commits ahead, zero uncommitted files.
- Nothing here is mid-flight. Treat the repo as you found it.

## Where the actual work is

`CTW-projects`, on `main` (and the same branch name). See `HANDOFF.md` in that repo.
Short version: a mic fix was made, it broke the mic on iOS, the regression was fixed
in build 3, and **build 3 has never been confirmed on real hardware** — that is the
open task.

## Orientation, if you are new here

Static site, no build step and no dependencies:

| File | Role |
| --- | --- |
| `index.html` | Small redirect page — forwards straight to `app.html` ("Two Sides"). |
| `app.html` | The whole application, ~310 KB, self-contained with React inlined so it loads reliably from any host. |
| `test.html` | Scratch/test page. |

Recent history (v2.2–v2.3) covers a watchlist-first flow, PRE/AFT market badges, a
user-defined Trade button, an Ask AI page, and Bitcoin auto-refreshing every 30s.

Because `app.html` is one large self-contained file, prefer targeted edits over
regenerating it, and open it in a browser after changes — there are no tests and no
lint step to catch a mistake.
