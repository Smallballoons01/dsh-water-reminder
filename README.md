# dsh-water-reminder

A **hydration reminder** plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

People forget to drink while they are deep in work. While a session is live this plugin reminds every **40–60 minutes, drawn at random**, and delivers each reminder through three independent channels — missing one still leaves two:

| Channel | How it lands | Needs |
| --- | --- | --- |
| 🖥️ OS notification | `osascript` on macOS, a WinRT toast on Windows, `notify-send` on Linux | `ctx.subprocess` (part of dsh-base) |
| 💬 In-conversation nudge | a plugin message injected into every live root session, so the assistant says one line | the `agents` service |
| 🔔 Browser notification | the sidebar panel watches `reminderSeq` and the tab raises its own notification | page open + user permission |

Plus a **sidebar countdown panel**, a **settings page**, and an embedded `hydration-coach` **skill**.

## Why 40–60 at random

The irregularity is the point. A perfectly regular timer is what teaches people to ignore it — which is why "drink water on the hour" apps get switched off. Redrawing the interval from the band on every reminder keeps the rhythm unpredictable, which is what makes it work.

## Install

```sh
# from a local checkout (writes the profile's package.json and dsh.profile.bundles)
dsh plugin --profile web add link:/path/to/water_reminder

# or from a packed tarball
pnpm pack && dsh plugin --profile web add ./dsh-plugin-water-reminder-0.1.0.tgz
```

Then **restart `dsh web`**: the timer and the tools mount at session start. Never keep two `water-reminder` rows in one profile — each would start its own timer and register the `/water/api` prefix route, and the duplicate route makes the whole plugin tree fail to boot.

## Tools

| Tool | Purpose |
| --- | --- |
| `water_status` | Today's intake, remaining, cups, goal streak, current band, quiet hours, next reminder, 7-day series |
| `water_log` | Record a cup (defaults to the configured cup size; accepts `milliliters` and `note`). Append-only, never deduplicated |
| `water_snooze` | Defer the next reminder; defaults to 5 minutes |
| `water_control` | `start` / `stop` / `set-band` / `set-goal` / `remind-now` / `reset` |

`water_control` writes **runtime overrides** into the state file rather than editing the profile config; `reset` drops those overrides and falls back to configuration.

## Configuration

In the profile's `cordis.patch.yml` (defaults ship in the plugin's own `cordis.patch.yml`):

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Whether the loop runs at start-up |
| `intervalMinMinutes` | number | `40` | Lower bound of the random interval, in minutes |
| `intervalMaxMinutes` | number | `60` | Upper bound of the random interval, in minutes |
| `dailyGoalMl` | number | `2000` | Daily intake goal |
| `cupMl` | number | `250` | Milliliters recorded for one "cup" |
| `snoozeMinutes` | number | `5` | Default deferral for `water_snooze` |
| `quietHours.enabled` | boolean | `false` | Hold reminders inside a local-time window |
| `quietHours.from` / `.to` | string | `22:00` / `08:00` | The window (may wrap past midnight); a draw inside it resumes at the window's end |
| `notify.os` | boolean | `true` | OS notification |
| `notify.agent` | boolean | `true` | In-conversation nudge |
| `notify.sound` | boolean | `true` | Play a sound with the OS notification |
| `stateFile` | string | `$DSH_HOME/water-reminder.json` | Persisted state location |
| `promptSection` | boolean | `true` | Inject the reminder briefing into the system prompt |
| `skill` | boolean | `true` | Register the embedded `hydration-coach` skill |

The band is clamped to `[5, 720]` minutes, the goal to `[200, 20000]` ml, and the cup to `[50, 2000]` ml. **A user patch replaces the whole entry config**, so restate every field you want to keep when overriding one.

## Web surfaces

- **Sidebar footer 💧 button** — carries the live countdown to the next reminder (shows "Paused" while off, ✅ once the goal is met). The panel has today's progress bar, cups/streak/band, next reminder, a 7-day bar chart, `+250ml` logging, snooze, remind-now, pause/resume, and a control to grant browser-notification permission.
- **Settings page** — the full rhythm/goal/quiet-hours/channels form. Writes land in `$DSH_HOME/settings.yaml` and hot-reload; changing the band or quiet hours rearms the timer immediately.

The two switches marked "(restart)" (`promptSection`, `skill`) are read at load time and need a Harness reload.

## Skill

The same instructions ship two ways:

1. **Runtime registration** — at mount the plugin calls `ctx.skills.register()`, so the model sees `hydration-coach` in its skill catalog with no filesystem skill root at all.
2. **On disk** — `skills/hydration-coach/SKILL.md`, for deployments that prefer a filesystem skill root (`~/.dsh/skills`, `~/.agents/skills`, a project `.dsh/skills`).

`skill.js` is the single source of truth and `npm test` asserts the checked-in SKILL.md matches the embedded body byte for byte, so the two delivery paths cannot drift. Run `npm run skill` after editing the body.

The skill covers which tool to call when, how to react to a reminder (one short line, no health lecture, never derail the current task), logging rules, how to retune the rhythm, estimating a personal goal from body weight (30 ml × kg), and tone/safety boundaries (no medical claims).

## How the reminder loop behaves

- **The state file owns the state.** Timer, next due time, and intake log live in `$DSH_HOME/water-reminder.json`, written through a temp file plus rename so a crash cannot truncate it.
- **No backlog after a restart.** A stale `nextDueAt` draws a fresh interval instead of firing the missed reminders at once.
- **Quiet hours** push a draw inside the window to the window's end rather than redrawing, so the behaviour stays predictable.
- **A manual reminder leaves the rhythm alone.** `remind-now` delivers once without resetting the pending reminder.
- **Disposal drains.** Unloading the plugin waits for an already-queued state write, so a cup logged at the last moment is not lost.
- **The timer is `unref()`ed**, so the reminder loop never keeps the process alive.

## Known limitations

- **Reminders only exist while Harness is alive.** There is no email, SMS, or push channel. With the process down, only the OS notification path exists — and only while it is up.
- **The Windows toast needs WinRT**, invoked as `powershell -EncodedCommand` (UTF-16LE base64) so quoting and CJK text are safe. If PowerShell is restricted by policy the reminder degrades to a log line, while the other two channels still fire.
- **Browser notifications need a user gesture** to request permission; the 🔔 control in the panel is that gesture.
- **The 7-day series is panel-only.** `water_status` returns a compact one-line text form instead, which keeps the tool's output schema free of nested arrays.

## Development

### Prerequisites

The plugin has **zero runtime dependencies** — `@deepseek-ai/dsh-tools`, `dsh-llm`, `schemastery` and
friends are peer dependencies that the Harness supplies at runtime.

Note, though, that **the versions this plugin is developed against are not published to npm** (npm's
latest `@deepseek-ai/dsh-tools` is `0.0.1-rc.1`; this plugin targets `0.1.2-alpha.3`), so a fresh
clone cannot `npm install` a working test environment. The settings page and config hot reload
require a Harness >= `0.1.2-alpha.3` host; on older hosts the plugin still runs on its boot-time
config. Pick one of three:

```sh
# 1) Run the dependency-free part only — works immediately after cloning
npm test              # 38 pass / 2 skip, and each skip says why

# 2) Reuse the packages from an existing local Harness profile (fastest, offline)
mkdir -p node_modules/@deepseek-ai
for p in cordis cosmokit dsh-llm dsh-tools dsh-settings dsh-skill dsh-system-prompt schemastery; do
  ln -sfn "$HOME/.dsh/profiles/node_modules/@deepseek-ai/$p" "node_modules/@deepseek-ai/$p"
done
npm test              # 63 pass, including the real cordis composition tests

# 3) Build the Harness from source and link this plugin the way it documents
git clone https://github.com/deepseek-ai/deepseek-harness
```

Use 2 or 3 for the full suite; 1 is enough when you are only touching pure logic
(`hydration.js` / `notify.js`).

### Scripts

```sh
npm test              # 60 tests with dependencies; 35 pass + 2 skip without
npm run skill         # regenerate SKILL.md from skill.js
npm run skill:check   # verify SKILL.md is in sync
```

| File | Coverage | Needs Harness |
| --- | --- | --- |
| `test/hydration.test.js` | Pure logic: band normalization, random-draw bounds, quiet hours across midnight, streaks, summary, config completion | no |
| `test/notify.test.js` | Exact per-platform `argv`, AppleScript/XML escaping, PowerShell encode round-trip | no |
| `test/skill.test.js` | Embedded skill identical to the on-disk `SKILL.md` byte for byte, spec-compliant name, tool names complete | no |
| `test/plugin.test.js` | Tool behavior against a minimal fake context, asserting every result matches its own declared `output.schema` | **yes** |
| `test/integration.test.js` | Mounted on a **real** `Context` with the real `tools`/`skills`/`systemPrompt` services: dependency resolution, skill discoverability, clean disposal, and no disk writes during teardown | **yes** |

When the packages are missing, the last two files **skip with a printed reason** instead of turning
the suite red.

## License

MIT — see [LICENSE](./LICENSE).
