# Contributing

Thanks for helping. A few ground rules so a pull request lands quickly.

## What we are building

Claude Office is an office that tells the truth about Claude Code: every
session, agent, wait, failure and dollar, live. Work that makes the office more
truthful (hook fidelity, session and worker lifecycle, meters, incident
signals, install/uninstall) comes first. Skins, translations and your own
team of characters are becoming data — a file or a folder you drop in — so
they can be shared without keeping a fork (see [#116](https://github.com/W17ant/Claude-Office/issues/116)); a skin PR fits
best once that lands. Seasonal variants on the incident axis are welcome once
the art exists.

## Got something in your fork?

Plenty of forks have built things the office should have — other AI tools,
translations, Windows, rooms and teams. Bring it back:

1. Open an issue (the feature form has a box for your fork's link) or post it
   in [Discussions › Show and tell](https://github.com/W17ant/Claude-Office/discussions/categories/show-and-tell),
   so we can agree on the shape before you rebase.
2. Open a pull request against `main`, one feature per PR, following
   *Before you open a PR* below.
3. You are credited by name in `CHANGELOG.md` and the release notes for the
   version it ships in. (The no-`Co-Authored-By` rule below still applies to
   commits; the credit lives in the changelog.)

## Ideas and questions

- An idea or a wish: [Discussions › Ideas](https://github.com/W17ant/Claude-Office/discussions/categories/ideas) —
  vote with 👍 on the ones you want.
- A question about setup or how something works: [Discussions › Q&A](https://github.com/W17ant/Claude-Office/discussions/categories/q-a).
- Something broken: an issue (Bug report).

## Before you open a PR

- Run `npm test`. It runs the Vitest suite against a temp `AGENT_OFFICE_HOME`,
  so it never touches your real `~/.agent-office`. CI
  (`.github/workflows/ci.yml`) runs, on every pull request and in this order:
  `tsc --noEmit` (after copying `office.config.example.json` to
  `office.config.json`), `claude plugin validate . --strict`, `npm test`,
  `vite build` and `npm run check-assets`; all five must pass.
- Add or update a test for behaviour you change (`tests/`); the server, the
  hook script and the installer all have harnesses to extend.
- Keep the README true: if you change a command, a port, a hook event or a
  default, change the line that documents it in the same PR.
- One change per PR; describe what you saw before and after, and name the
  Claude Code version and OS you tested on.

## Style

- Match the surrounding code; no reformatting-only diffs.
- No attribution footers, `Co-Authored-By` lines or tool-generated trailers in
  commits or PR descriptions.
- Office-themed assets are fan art (see [NOTICE.md](NOTICE.md)); do not add more
  third-party likenesses, logos or quoted lines.
