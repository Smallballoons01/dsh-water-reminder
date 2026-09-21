# Security Policy

## Reporting a vulnerability

Open a [private security advisory](../../security/advisories/new) on the repository, or email the
maintainer listed in `package.json`. Please do not open a public issue for anything exploitable.

Expect an acknowledgement within a few days. This is a small, single-maintainer project with no
funding behind it — a fix may take a while, but you will hear back.

## What this project touches

| Surface | Detail |
| --- | --- |
| Files read/written | Exactly one: `$DSH_HOME/water-reminder.json` (override with `stateFile`). Written atomically via a temp file + rename. |
| Network egress | **None.** Nothing in this package opens an outbound connection. The web half only calls `/water/api/…` on the same origin. |
| Telemetry | **None.** No analytics, no phone-home, no crash reporting. |
| Runtime dependencies | **Zero.** `dependencies` is empty; `@deepseek-ai/*` are host-provided peers. |
| Subprocesses | Yes — see below. |
| HTTP routes | `POST /water/api/{status,drink,snooze,control,remind-now}` on the harness's own web server. |
| Code execution | No `eval`, no `new Function`, no template engine, no shell. |

### The subprocess, specifically

Delivering a native OS notification means running the platform's notifier
(`osascript` on macOS, PowerShell's WinRT toast on Windows, `notify-send` on Linux). This is the
one place the plugin does something with real blast radius, so it is worth stating exactly how:

- **Nothing goes through a shell.** `notify.js` returns an `argv` array that is handed straight to
  `ctx.subprocess.spawn`. There is no string concatenation into a command line, so a reminder
  sentence containing quotes, semicolons, backticks or `$(…)` is inert data rather than syntax.
- On Windows the payload is passed base64-encoded (UTF-16LE) for the same reason — it sidesteps both
  shell quoting and the encoding traps that would otherwise mangle non-ASCII text.
- The argv builders are pure functions returning data, which is also why the platform quirks are
  testable without spawning anything.

## Threat model

**What is worth protecting.** The state file records the user's drinking log and reminder settings.
It is personal but not secret in the credential sense — the real risk is that a page the user merely
*visits* could read it or rewrite it.

**The concrete attack.** The `/water/api` routes are registered directly on the harness's web server,
which means they are **not** behind the harness's own `/api` browser-trust fence. A handler that
accepts a `text/plain` body which happens to parse as JSON can be reached by a *simple* cross-origin
`POST` — no preflight, no CORS block. Without a guard, any page open in any tab could log drinks,
pause the reminder loop, or read back the log.

**The mitigation.** Every route rejects a request whose `Origin` host differs from its `Host` header,
and treats an unparseable or `null` origin as cross-site. Requests with no `Origin` at all are
allowed, because that is what a CLI client sends and it is not something a browser can forge. See
`crossSiteRequest()` in `index.js`.

**What is explicitly out of scope.** The plugin runs inside the user's own harness process with that
process's privileges and reads a file in their home directory. An attacker who can already write to
`$DSH_HOME` or execute code in that process does not need a vulnerability here.

## Hardening already in place

- **Cross-site guard** on every mutating route, covered by tests in `test/plugin.test.js`.
- **No shell anywhere** (above) — the only subprocess use is argv-based.
- **Request bodies are capped** (`MAX_BODY_BYTES`) before parsing.
- **State is clamped on read.** `normalizeState()` bounds every field, so a hand-edited or corrupt
  state file produces a wrong-but-finite schedule rather than a crash or a hot loop.
- **Start-up work is bound to the plugin's lifetime.** A pending `load()` checks a `disposed` flag
  and the disposer awaits both the start-up promise and the write queue, so unloading cannot leave a
  timer armed or a write in flight.
- **`innerHTML` only ever receives self-generated content** in the panel; user-facing text goes
  through `textContent`.
- **No runtime dependencies**, so there is no third-party code to review.

## Supported versions

Only the latest `0.1.x` line receives fixes.
