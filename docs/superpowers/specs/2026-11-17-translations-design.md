# Translations: the office in your language

Project 3a of the community work (#116). Team packs as data are project 3b
and get their own design after this ships.

## Why

The owner wants more people using and contributing to the office (stars,
downloads, features from other GitHub users). Four forks translated the
office by editing the code (Indonesian, Traditional Chinese, Spanish,
Portuguese), so every upstream update conflicts with their work and none of
it came back. A translation should be one file someone adds in a small PR,
credited by name in the changelog, never a fork to maintain.

## Goals

- One JSON file per language (`locales/<code>.json`); English
  (`locales/en.json`) is the source every other file is checked against.
- The whole office follows the chosen language (the owner chose scope C):
  - the page's labels, buttons, tooltips, badges, the status strip, Settings,
    the inspector, cards and banners;
  - what the agents say: spawn / work / done / coffee / water lines and the
    incident lines, for both the default office and Dunder Mifflin mode;
  - the server's messages in the chat: slash-command replies (`/status`,
    `/agents`, `/help`, `/recap` …), system messages, the end-of-day recap
    text;
  - the chat bot: `scripts/chat-ai-watcher.sh` tells `claude -p` to reply in
    the office's language.
- Pick the language in Settings, listed by its own name ("Bahasa
  Indonesia", "繁體中文"), with how complete it is. On first run the office
  takes the browser's language when a file exists for it.
- A missing or half-done translation never breaks anything: any key a file
  lacks falls back to English, key by key (a chatter list falls back as a
  whole list).
- Dates, times and money use the language's own formatting (`Intl`).
- Adding a language needs no code: copy `en.json`, translate, open a PR. CI
  tells the translator what is missing or wrong.
- Ship with about 12 languages on day one (the owner's call), drafted by
  agents the way the owner's card genie project was translated, each
  marked **work in progress** in the picker, with a **Report a
  translation error** link so native speakers can fix them.

## Non-goals

- The terminal: CLI, `doctor`, installers, hook output and the server log
  stay English (developer-facing, and read in bug reports).
- README and docs translations.
- Character and cast names (Michael, Dwight, …): proper nouns, unchanged.
- Right-to-left layouts.
- The desktop app's tray and menus (a small follow-up if asked for).
- Re-translating chat history: a message is written in the language set
  when it was written.
- A hosted translation site (Weblate / Crowdin). It can sit on top of these
  files later without changing them.

## Anti-goals (a failure even if it works)

- The page shows a raw key (`ui.settings.title`) or an empty label.
- A translation file can run code or inject markup: strings are plain text,
  rendered as text, never as HTML.
- A long translation breaks the layout (German is about 30 % longer than
  English): labels that can grow must wrap or truncate, not overflow.
- Translating changes behaviour: slash commands, `@`-mentions, setting
  values and anything the server parses stay English.
- A contributor has to touch TypeScript to add a language.

## Approaches

- **A. Plain JSON per language and a small translate helper of our own
  (chosen).** One helper used by the page and the server: look up a key,
  fill `{placeholders}`, fall back to English. No new dependencies; matches
  what #116 promised.
- B. The same files read by i18next / react-i18next. Plurals and tooling
  ready-made, but two dependencies and their conventions for a UI with few
  plural sentences.
- C. A or B plus a hosted translation site. More translators without git,
  but an outside account to run; can be added later on top of A.

The owner picked A.

## How it works

**Files.** `locales/<code>.json`, `<code>` a BCP 47 tag (`en`, `id`,
`zh-TW`, `es`, `pt-BR`). Shape:

```json
{
  "meta": { "name": "Bahasa Indonesia", "englishName": "Indonesian", "translators": ["Generyodai8"] },
  "ui": { "settings": { "title": "Pengaturan", "language": "Bahasa" } },
  "chatter": { "default": { "spawn": ["siap bertugas!", "…"] }, "office": { "spawn": ["…"] } },
  "server": { "help": "Perintah: {commands}" }
}
```

- Nested objects group keys by area (`ui`, `chatter`, `server`); a key is
  its dotted path.
- Placeholders are `{name}`. A translation must use exactly the placeholders
  its English string has.
- Plurals: a key with `_one` / `_other` (and whatever forms the language
  needs: `_few`, `_many` …) variants, chosen with `Intl.PluralRules`.
- Chatter keys are arrays; a translated list may be longer or shorter than
  the English one.
- Strings only: no HTML, no markdown that the page renders as markup.

**The helper** (one module the page and the server both import): `t(key,
vars?)` in the current language, with English as the fallback per key, and
the key itself only if English lacks it too (which a test forbids).
`list(key)` returns a chatter list. The page re-renders when the language
changes.

**Loading.** The page bundles every locale file at build time; the server
reads them from `locales/` at start. A new language therefore ships in a
release, like any PR.

**Choosing the language.** One office-wide setting, `language`, kept by the
server with the other settings (`GET /settings`, `POST /settings` with the
UI token). Unset on a fresh install: the office's own page (the one holding
the UI token) sets it once to the browser's language if a file exists for
it, else English. Read-only and phone pages follow the setting. Settings
shows a picker: each language's own name, and its completeness as a
percentage of English keys.

**Server messages** are translated with the setting at the moment they are
written and stored as text, as today.

**The chat bot.** The watcher reads the language from the server and, when
it is not English, adds one line to its prompt: reply in
`<meta.englishName>`. It posts nothing on failure, so it has no fallback
lines to translate.

**Seed languages (owner's call).** English plus 12 languages, all drafts:
Spanish (`es`), Brazilian Portuguese (`pt-BR`), French (`fr`), German
(`de`), Italian (`it`), Japanese (`ja`), Korean (`ko`), Simplified Chinese
(`zh-CN`), Traditional Chinese (`zh-TW`), Indonesian (`id`), Russian
(`ru`), Turkish (`tr`). No right-to-left languages (a non-goal).

- Drafted by parallel agents, one per language, from the finished
  `en.json`. Each agent writes the whole file, keeps every `{placeholder}`,
  keeps commands, `@`-mentions and character names in English, and reports
  anything it could not translate well. Where a fork's translation exists
  (#116), the agent uses its wording and the fork's author goes in
  `meta.translators`.
- `meta.status: "wip"` marks a draft. The picker shows "work in progress"
  beside it. A native speaker who checks the file removes the flag in their
  PR.
- **Report a translation error.** A link beside the picker and in the
  Settings footer opens a new GitHub issue form, `translation.yml`
  ("Translation error": language, where it appears, what it says, what it
  should say), with the language filled in. It is a plain link, so the
  office sends nothing itself.
- The PR description and #116 list the 12 languages and ask native speakers
  to correct them.

**Tools for translators and agents** (modelled on card genie's scripts):

- `scripts/i18n-coverage.mjs` prints each language's completeness and,
  with `--keys <code>`, the missing keys as `key<TAB>English`, ready to hand
  to a translator. It also lists *stale* keys, where the English text
  changed after the translation was last committed (found with git).
- The checks below also catch characters from the wrong writing system
  (Han in French, Cyrillic in Spanish). Card genie added that check after a
  stray Chinese character slipped into a French file.

**Checks** (tests, so CI runs them on every PR):

- every locale is valid JSON with `meta.name` and `meta.englishName`;
- every key in a translation exists in `en.json` (no typos, no stale keys);
- placeholders match English exactly, string by string;
- no string contains markup (`<`, `>` tags);
- no string contains a writing system its language does not use (each
  locale lists its allowed scripts; Latin is always allowed for brand
  names, commands and placeholders);
- a `meta.status`, if present, is `"wip"`;
- `en.json` covers every key the code uses: the code calls `t()` with
  literal keys, and a test scans the source for them.

A translation may be incomplete; the check prints how complete each
language is but does not fail on missing keys.

## Contributing

CONTRIBUTING gains *Add or fix a language*: copy `locales/en.json` to
`locales/<code>.json`, fill in `meta` (your name in `translators`), translate
what you can, run `npm test`, open a PR. Fixing a draft is the same: edit
the file, add your name, and remove `"status": "wip"` once you've checked
all of it. Credit by name in the CHANGELOG.
#116 gets a comment when it ships.

## Calls made after the builder's check (Claude's, not the owner's)

- The bot's sender names ("Debugger", "Reviewer" …) stay English, like
  character names.
- The bot's routing still recognises the English keywords. A locale may add
  its own (`server.routing.<agent>` lists) so a message in that language
  reaches the right agent.
- The 15-word cut on bot replies also gets a character cap, so it works for
  Chinese, Japanese and Korean, which have no spaces.
- Desktop permission notifications (`server/permission-notify.js`) are
  translated.
- Sim, video, demo and promo content stays English and does not count
  toward completeness.
- Locale matching is exact first, then by language: `zh-HK` gets `zh-TW`,
  but `zh-CN` never falls back to `zh-TW` or the other way round. `pt-PT`
  gets `pt-BR`. Anything else gets English.
- Costs stay in US dollars (that is what the tools bill in), formatted with
  `Intl` for the chosen language.
- Read-only and phone pages hear a language change live, like other
  settings.
- `locales/` is added to the npm package's `files`.

## What is left to the builder

- Finding every user-visible string in `src/` and `server/` and choosing key
  names, area by area.
- Where the shared helper lives so both the Vite page and the Node server
  import it.
- How the page learns the language before the WebSocket snapshot (to avoid
  an English flash).
- Which labels need wrapping or truncation to survive longer languages.
