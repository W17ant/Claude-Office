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
3. *Add or fix a tool* (Codex, Gemini CLI, OpenCode, Antigravity, Kimi, or a
   new one): one file in `server/tools/`, one fixture in
   `tests/fixtures/tools/<tool>/` (a real capture is best:
   `AGENT_OFFICE_CAPTURE_DIR` records one, see
   [reference › Other AI tools](docs/reference.md#other-ai-tools)), one test.
4. *Add or fix a language*: see the section below.
5. You are credited by name in `CHANGELOG.md` and the release notes for the
   version it ships in. (The no-`Co-Authored-By` rule below still applies to
   commits; the credit lives in the changelog.)

## Add or fix a language

The office speaks whatever language its `locales/<code>.json` file says, and
adding one needs no code:

1. Copy `locales/en.json` to `locales/<code>.json` (a language code such as
   `de`, `pt-BR` or `zh-TW`). Fill in `meta`: `name` in the language itself
   ("Deutsch"), `englishName` ("German"), and your GitHub name in
   `translators`.
2. Translate what you can. Anything you leave out shows in English, so a half
   done file is fine. Keep every `{placeholder}` exactly as it is, and leave
   slash commands (`/status`), `@`-mentions, product names and character
   names in English. The Dunder Mifflin theme's lines stay English and are
   not in your file (the check says so if one slips in). Chatter lists
   (`chatter.*`) can be longer or shorter
   than the English ones; translate them for tone, not word for word.
   Plurals: add the forms your language needs (`_one`, `_few`, `_many`,
   `_other` …, see `Intl.PluralRules`). `server.routing.*` lists are words
   that send a chat message to a persona: add your language's own.
3. `node scripts/i18n-check.mjs <code>` until it prints `ok`, then
   `npm test`. `node scripts/i18n-coverage.mjs` shows how complete each
   language is; `--keys <code>` lists what is missing or out of date.
4. Open a PR. Most languages started as drafts written by Claude and are
   marked `"status": "wip"` ("work in progress" in the picker): fixing one
   is the same PR — correct what reads wrong, add your name, and remove
   `"status": "wip"` once you have checked the whole file. Found a mistake
   but no time for a PR? Settings › Language › *Report a translation error*.

A new language in a non-Latin script also needs a line in `ALLOWED_SCRIPTS`
in `scripts/i18n-check.mjs`, in the same PR.

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
