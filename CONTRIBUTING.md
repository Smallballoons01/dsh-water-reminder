# Contributing

Thanks for looking. This is a small project; the fastest way to get a change merged is to keep it
narrow and show the test that proves it.

## Setup

The package has **no runtime dependencies**, so there is nothing to install before running the tests.

The DeepSeek Harness packages are peer dependencies and are **not published to npm**. Tests that need
them skip themselves with a clear message instead of failing, so a plain checkout gives you a green
run with reduced coverage. To exercise the plugin layers, symlink them from a local harness install:

```bash
mkdir -p node_modules/@deepseek-ai
for p in cordis dsh-llm dsh-settings dsh-skill dsh-system-prompt dsh-tools schemastery; do
  ln -sfn "$HOME/.dsh/profiles/node_modules/@deepseek-ai/$p" "node_modules/@deepseek-ai/$p"
done
```

## Checks

```bash
npm test           # unit + plugin behaviour + real cordis composition
npm run skill:check # fails if SKILL.md drifted from skill.js
```

Unlike the sibling `retirement-calc` project there is no browser-side suite here, because the panel
is a thin view over `/water/api` and the interesting logic all lives in `hydration.js` where it is
directly testable.

## Layers

Three layers, each catching something the others cannot:

1. **Pure logic** (`test/hydration.test.js`) — interval drawing, goal tracking, quiet hours, streaks.
2. **Adapters** (`test/notify.test.js`) — the per-platform `argv` builders, as pure data.
3. **Fake then real host** (`test/plugin.test.js`, `test/integration.test.js`) — tool behaviour
   against a minimal fake context (with every result checked against its own `output.schema`), then
   mounting on a real cordis composition to prove dependency resolution, skill discoverability and
   clean disposal.

Plus `test/client-structure.test.js`, which asserts source-level rules for the browser half — see
below.

## The browser half has its own rules

`test/client-structure.test.js` enforces two things that are easy to get wrong and produce no error
when you do:

- **Theme token names must be real.** The design tokens are injected at runtime, so grepping the
  harness source or `node_modules` finds nothing even for tokens that exist, and guessing from the
  pattern yields names that look right and silently fall back. The text tokens are `label-*`; there is
  no `text-primary`. To check a name:
  ```sh
  # boot a throwaway instance, swap ?token= for a cookie, pull the page,
  # extract the /plugins/?… bundle URL, then:
  curl -s -b cookies.txt "http://127.0.0.1:$PORT$BUNDLE" -o bundle.js
  grep -o -- '--dsw-alias-<name>: *[^;}]*' bundle.js   # the COLON means it is defined
  ```
  A name that is only `var(...)`-referenced and never defined is a legacy name — it will fall back.
- **Fills must be hard-coded.** `brand-primary` / `brand-text` sound like brand colours but resolve to
  a *neutral* emphasis colour (near-black in light mode, near-white in dark). Used as a button
  background they give white-on-white. Use a fixed mid-blue that keeps white text at ~5:1, and fall
  back to CSS system colours (`Canvas`, `CanvasText`, `GrayText`) so foreground and background always
  come as a pair.

## Style

- Chinese and English comments are both fine; match the file you are editing.
- Comments explain **why**, not what. A comment restating the next line will be asked to leave.
- No new runtime dependencies. If you think one is needed, open an issue first — the zero-dependency
  property is a feature, not an accident.
- `notify.js` must keep returning `argv` arrays. Never build a command string, never use a shell.
  Reminder text is user data and would otherwise become command syntax.

## Pull requests

- One change per PR.
- Update `README.md` and `README.zh.md` together; they are kept in sync.
- Regenerate `skills/hydration-coach/SKILL.md` with `npm run skill` rather than editing it by hand —
  `npm run skill:check` will reject a hand-edited copy.
- State what you verified and how.

## License

By contributing you agree your work is released under the MIT license in `LICENSE`.
