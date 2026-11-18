# Translations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The whole office (page, agent chatter, server chat messages, chat bot) follows one office-wide language, read from plain JSON files in `locales/`, shipping English plus 12 agent-drafted "work in progress" languages.

**Architecture:** One pure translator module in `shared/` (no I/O) used by both sides: the Vite page bundles `locales/*.json` with `import.meta.glob`, the Node server reads `locales/` from disk at start. The language is a server setting (`settings.language`), carried in the WebSocket snapshot and a `settings` broadcast; the page caches it in localStorage to avoid an English flash. Checks live in `scripts/i18n-check.mjs`, used by the tests, the coverage script and the translation agents.

**Tech Stack:** React 18 + Vite (page), Node ESM + Express + ws (server), bash + python3 (chat watcher), vitest (node environment only), `Intl.PluralRules` / `Intl.NumberFormat` / `Intl.DateTimeFormat`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-17-translations-design.md`

## Global Constraints

- No new dependencies (approach A).
- Locale files: `locales/<bcp47>.json`, sections `meta` / `ui` / `chatter` / `server`; `meta.name`, `meta.englishName` required; `meta.translators` array; `meta.status` absent or `"wip"`.
- Placeholders are `{name}`; a translation uses exactly its English string's placeholders. Plurals are `<key>_one` / `_other` (+ `_zero` / `_two` / `_few` / `_many`), chosen with `Intl.PluralRules`.
- Strings are plain text, rendered as text, never HTML. No `dangerouslySetInnerHTML`, no `innerHTML` with a translated string.
- English fallback per key; a chatter list falls back as a whole list. The page never shows a raw key or an empty label.
- Behaviour never changes with language: slash commands, `@`-mentions, setting values, anything the server parses stay English.
- Out of scope, stay English: terminal/CLI/doctor/installers/hook output/server log; README and docs; character and cast names; the bot's sender names; `/?helper` (PlacementHelper) and `/?fithelper` (FitHelper) authoring tools; `?sim`, `?video`, demo and promo content (not counted toward completeness); desktop tray/menus; right-to-left.
- Seed languages: `es`, `pt-BR`, `fr`, `de`, `it`, `ja`, `ko`, `zh-CN`, `zh-TW`, `id`, `ru`, `tr`, every one `"status": "wip"`.
- Locale matching: exact (case-insensitive) first; `zh-HK`, `zh-MO`, `zh-Hant*` → `zh-TW`; `zh`, `zh-SG`, `zh-Hans*` → `zh-CN`; `pt-*` → `pt-BR`; otherwise the language part (`es-MX` → `es`); otherwise `en`. `zh-CN` and `zh-TW` never stand in for each other.
- Costs stay USD, formatted with `Intl.NumberFormat(lang, { style: 'currency', currency: 'USD' })`.
- Report link: `https://github.com/W17ant/Claude-Office/issues/new?template=translation.yml&language=<code>`.
- Repo rules: a file header comment on every new file, `// Why:` on decisions, no Co-Authored-By / "Generated with Claude Code" / session links in commits or PRs.

## Review Focus

1. A locale file on disk that is not valid JSON (hand-edited in a checkout): the server starts, skips that file with one `console.warn`, and the office runs in English.
2. `settings.json` holding a `language` whose file no longer exists (`"xx"`): treated as unset, so English; GET /settings reports `language: null`.
3. The page's cached language in localStorage is unknown, or localStorage throws: English, no crash.
4. A plural key in a language whose file lacks the form `Intl.PluralRules` picks (Russian `_few` missing): that language's `_other` is used before falling back to English.
5. A placeholder value containing `$&`, `$1` or `{other}`: inserted literally, never re-expanded.

Each has a test in the task that owns the code (Tasks 1, 3, 4).

---

### Task 1: The translator (`shared/i18n.js`)

**Files:**
- Create: `shared/i18n.js`, `shared/i18n.d.ts`
- Modify: `package.json` (`files` gains `"shared/"` and `"locales/"`)
- Test: `tests/i18n.test.ts`

**Interfaces:**
- Produces (all pure, no I/O):
  - `type Catalog = { meta: { name: string, englishName: string, translators?: string[], status?: 'wip' }, ui?: object, chatter?: object, server?: object }`
  - `flatten(catalog: object): Record<string, string | string[]>`: dotted keys; arrays are leaves (never indexed); `meta` included.
  - `matchLocale(requested: string | null | undefined, available: string[]): string`: the rules in Global Constraints.
  - `createTranslator(catalogs: Record<string, Catalog>, lang: string): { lang: string, t(key: string, vars?: Record<string, string | number>): string, list(key: string): string[] }`. Unknown `lang` → `en`.
  - `completeness(catalog: Catalog, en: Catalog): number`: integer 0–100, the share of en's non-`meta` leaf keys (excluding keys under `ui.demo.`) that the catalog has as a non-empty string / non-empty array. `en` itself → 100.
  - `formatMoney(usd: number, lang: string): string`, `formatNumber(n: number, lang: string): string`, `formatTime(ms: number, lang: string): string` (hour:minute), `formatDate(ms: number, lang: string): string` (day, short month).

- [ ] **Step 1: Write the failing tests** in `tests/i18n.test.ts` with a small inline `en` / `de` / `ru` / `zh-TW` / `zh-CN` / `pt-BR` / `es` fixture (not the real files):
  - `t returns the language's string, else English, else the key`: de has `ui.a`, lacks `ui.b`; `t('ui.a')` = de value, `t('ui.b')` = en value, `t('ui.nope')` = `'ui.nope'`.
  - `t treats an empty string as missing`: de `ui.c: ""` → en value.
  - `t fills placeholders literally`: `t('ui.hi', { name: '$& {x} $1' })` with en `"Hi {name}"` → `'Hi $& {x} $1'`; a missing var leaves `{name}` in place.
  - `t picks plural forms with Intl.PluralRules`: ru `n_one`/`n_many`/`n_other`, en `n_one`/`n_other`; `t('n', {count: 1})` → ru one, `t('n', {count: 5})` → ru many, `t('n', {count: 2})` (ru `few`, absent) → ru `_other`; for de lacking all forms → en form by en rules; `count` also fills `{count}`.
  - `list falls back as a whole list`: de `chatter.x: []` → en list; de `chatter.y: ['a']` → `['a']`; unknown key → `[]`.
  - `matchLocale`: `('zh-HK', av)` → `zh-TW`; `('zh-Hant-TW')` → `zh-TW`; `('zh')` → `zh-CN`; `('zh-SG')` → `zh-CN`; `('zh-CN', ['en','zh-TW'])` → `en`; `('zh-TW', ['en','zh-CN'])` → `en`; `('pt-PT')` → `pt-BR`; `('es-MX')` → `es`; `('DE-de')` → `de`; `(undefined)` / `('')` / `('xx')` → `en`.
  - `completeness`: en → 100; a catalog with 1 of 4 keys → 25; keys under `ui.demo.` not counted.
  - `formatMoney(1234.5, 'de')` contains `1.234,50` and `$`; `formatMoney(3, 'en')` = `'$3.00'`.
  - `createTranslator(catalogs, 'xx').lang` = `'en'`.
- [ ] **Step 2: Run** `npx vitest run tests/i18n.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `shared/i18n.js`** (plain ESM JS with JSDoc) and `shared/i18n.d.ts` (the types above) so `src/` can import it under `tsc`. Placeholder filling uses a replacer function (never a replacement string) so `$&` stays literal. Plural lookup order: `key_<form>` in lang → `key_other` in lang → `key_<enForm>` in en → `key_other` in en → plain `key`.
- [ ] **Step 4: Run** `npx vitest run tests/i18n.test.ts`. Expected: PASS. Then `npx tsc --noEmit`. Expected: no errors.
- [ ] **Step 5: Commit** `git add shared tests/i18n.test.ts package.json && git commit -m "i18n: the translator, shared by the page and the server"`

### Task 2: Locale checks and `locales/en.json`

**Files:**
- Create: `locales/en.json` (meta + the Settings language keys only, for now), `scripts/i18n-check.mjs`
- Test: `tests/locales.test.ts`

**Interfaces:**
- Consumes: `flatten` (Task 1).
- Produces:
  - `scripts/i18n-check.mjs` exports `checkLocale(code: string, catalog: unknown, en: Catalog): string[]` (problems, empty when fine), `loadLocaleFiles(dir: string): { code: string, catalog?: Catalog, error?: string }[]`, `ALLOWED_SCRIPTS: Record<string, string[]>`, `findCodeKeys(rootDir: string): { keys: Set<string>, dynamic: string[] }`.
  - CLI: `node scripts/i18n-check.mjs [code]` prints problems per locale, exits 1 on any.
  - en keys used by later tasks: `meta.*`, `ui.settings.language.title` ("Language"), `ui.settings.language.wip` ("work in progress"), `ui.settings.language.complete` ("{percent}% translated"), `ui.settings.language.report` ("Report a translation error"), `ui.settings.language.readOnly` ("Only the office's own page can change the language").
- Checks in `checkLocale`: file name matches `^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$`; `meta.name` and `meta.englishName` non-empty strings; `meta.translators`, if present, an array of strings; `meta.status` absent or `"wip"`; every non-meta key exists in en and has the same kind (string vs array); every array element is a string; placeholders (`/\{(\w+)\}/g`) are the same set as English's, per string (for arrays: each element's set ⊆ the union over the English list); no string matches `/<\/?[a-zA-Z][^>]*>/`; no string contains a script outside `ALLOWED_SCRIPTS[language]` among Han, Hiragana, Katakana, Hangul, Cyrillic, Greek, Arabic, Hebrew, Thai, Devanagari (Unicode property escapes). `ALLOWED_SCRIPTS`: `ja` → Han, Hiragana, Katakana; `ko` → Hangul, Han; `zh` → Han; `ru` → Cyrillic; every other language → none (Latin only). Latin is always allowed.
- `findCodeKeys` scans `src/**/*.{ts,tsx}`, `server/**/*.js`, `shared/**/*.js` files that import from an i18n module (`shared/i18n`, `src/i18n`, `server/i18n`). It collects `t('…')`, `list('…')`, `useT()`-returned `t('…')` literal first arguments (single, double or backtick quotes without `${`), and returns any `t(`/`list(` call whose first argument is not such a literal in `dynamic` (as `file:line`).

- [ ] **Step 1: Write the failing tests** in `tests/locales.test.ts`:
  - `every locale file parses and passes checkLocale`: loops over `loadLocaleFiles('locales')`; `expect(problems).toEqual([])` per code (named in the test title via `it.each`).
  - `checkLocale catches each kind of problem` with inline bad catalogs, each asserting one problem string mentions the key: unknown key, string-vs-array mismatch, missing `{name}`, extra `{x}`, `<b>` markup, Han in `fr`, Cyrillic in `es`, Han allowed in `ja`, `meta.status: "done"`, missing `meta.englishName`.
  - `en.json covers every key the code uses`: `findCodeKeys('.')` keys all present in `flatten(en)` (singular plural keys count as present when `key_other` exists).
  - `the code passes only literal keys`: `findCodeKeys('.').dynamic` equals `[]`.
  - `completeness is printed, not enforced`: logs `code: N%` per locale, no assertion on N.
- [ ] **Step 2: Run** `npx vitest run tests/locales.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `scripts/i18n-check.mjs` and write `locales/en.json` with `meta: { name: "English", englishName: "English", translators: [] }` and the five `ui.settings.language.*` keys.
- [ ] **Step 4: Run** `npx vitest run tests/locales.test.ts && node scripts/i18n-check.mjs`. Expected: PASS; CLI prints `en: ok`, exit 0.
- [ ] **Step 5: Commit** `git add locales scripts/i18n-check.mjs tests/locales.test.ts && git commit -m "i18n: locale checks and the English source file"`

### Task 3: The server's language setting

**Files:**
- Create: `server/i18n.js`
- Modify: `server/index.js` (Settings block ~1517–1575, `GET/POST /settings` ~2900–2933, `buildSnapshot` ~4141, `broadcast`)
- Test: `tests/language-setting.test.ts`

**Interfaces:**
- Consumes: `createTranslator`, `matchLocale`, `completeness` (Task 1).
- Produces:
  - `server/i18n.js`: `loadLocales(dir?: string): Record<string, Catalog>` (default `new URL('../locales/', import.meta.url)`; an unparsable file is skipped with one `console.warn('[i18n] …')`; a file without `meta.name` is skipped too); `setLanguage(code: string | null): void`; `getLanguage(): string | null`; `t(key, vars?)`; `list(key)`; `languages(): { code, name, englishName, status: 'wip' | null, completeness: number }[]` (en first, then by `englishName`).
  - `settings.language: string | null` (default `null`); POST /settings accepts `language: string | null`; 400 with `language must be one of …` for an unknown code; saved in `settings.json`; on load an unknown code becomes `null`.
  - GET /settings adds `language` and `languages`.
  - Snapshot (every tier, including read-only, phone and LAN) adds `language: string | null`.
  - On a change: `broadcast({ type: 'settings', language })`.
- [ ] **Step 1: Write the failing tests** (use `loadOffice`, `postAuthed` from `tests/helpers.ts`; the `AGENT_OFFICE_HOME` temp dir isolates `settings.json`):
  - `GET /settings reports language null and the language list`: `language === null`, `languages[0].code === 'en'`, `completeness === 100`.
  - `POST /settings sets the language and broadcasts it`: open a WS with `officeProtocols`, POST `{ language: 'en' }` with the UI token → 200, a `{ type: 'settings', language: 'en' }` message arrives, the next snapshot has `language: 'en'`.
  - `POST /settings refuses an unknown language`: `{ language: 'xx' }` → 400, body names `language`.
  - `POST /settings without the UI token refuses a language change`: no token → 401/403 and language unchanged.
  - `an unknown saved language loads as null` (Review Focus 2): write `settings.json` `{ "language": "xx" }` before `loadOffice` → GET reports `null`.
  - `a broken locale file is skipped` (Review Focus 1): `loadLocales(tmpDir)` with `en.json` valid and `de.json` = `"{nope"` → keys `['en']`, one warn.
  - `server t follows the setting`: with a temp catalog dir holding en and de (`server.x`), `setLanguage('de')`, `t('server.x')` → de string.
- [ ] **Step 2: Run** `npx vitest run tests/language-setting.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `server/i18n.js` and the `server/index.js` changes. Update the Settings comment block and the GET/POST JSDoc. Language changes are logged like the other settings.
- [ ] **Step 4: Run** `npx vitest run tests/language-setting.test.ts tests/lan.test.ts tests/permissions.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `git add server tests/language-setting.test.ts && git commit -m "i18n: the office-wide language setting"`

### Task 4: The page's language store

**Files:**
- Create: `src/i18n.ts`
- Modify: `src/hooks/useAgentSocket.ts` (snapshot handler ~316; a `settings` message branch), `src/serverSettings.ts` (`language`, `languages` from GET /settings; `setLanguage(code)` optimistic POST like the others), `src/types.ts` (`SnapshotMessage.language`, `SettingsMessage`)
- Test: `tests/page-i18n.test.ts`

**Interfaces:**
- Consumes: Task 1, Task 3's message shapes.
- Produces:
  - `src/i18n.ts`: `catalogs` (from `import.meta.glob('../locales/*.json', { eager: true, import: 'default' })`), `t(key, vars?)`, `list(key)`, `currentLanguage(): string`, `applyLanguage(code: string | null): void` (sets the store, caches in localStorage key `agent-office.language`, sets `document.documentElement.lang` when `document` exists), `useT(): typeof t` (re-renders on change through `useSyncExternalStore`), `firstRunLanguage(serverLanguage: string | null, canWrite: boolean, browserLanguages: readonly string[], available: string[] = Object.keys(catalogs)): string | null` (returns the code to POST when the server has none and this page holds the UI token, else `null`).
  - Start-up order: cached localStorage value (guarded by try/catch; unknown → ignored) → snapshot `language` → `settings` broadcasts.
  - `useAgentSocket`: on snapshot, `applyLanguage(snap.language ?? null)`; when `snap.language === null` and the snapshot carries `uiToken`, POST the `firstRunLanguage(null, true, navigator.languages)` result via `serverSettings.setLanguage`; on `{type:'settings'}`, `applyLanguage(msg.language)`.
- [ ] **Step 1: Write the failing tests**:
  - `applyLanguage switches t and notifies subscribers` (subscribe through the store's subscribe export).
  - `an unknown cached language is ignored` and `a throwing localStorage leaves English` (Review Focus 3): stub `globalThis.localStorage` with a `getItem` that throws, import fresh with `vi.resetModules()` → `currentLanguage() === 'en'`.
  - `firstRunLanguage`: `(null, true, ['de-AT'], ['en','de'])` → `'de'`; `(null, true, ['xx'], ['en','de'])` → `'en'`; `('fr', true, …)` → `null`; `(null, false, …)` → `null`.
  - `applyLanguage(null) means English`.
- [ ] **Step 2: Run** `npx vitest run tests/page-i18n.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `firstRunLanguage` takes the first browser language that `matchLocale` maps to something other than `en`, else `'en'` (so English is also written once and the question is settled).
- [ ] **Step 4: Run** `npx vitest run tests/page-i18n.test.ts && npx tsc --noEmit`. Expected: PASS, no type errors.
- [ ] **Step 5: Commit** `git add src tests/page-i18n.test.ts && git commit -m "i18n: the page follows the office's language"`

### Task 5: Language picker, report link and the issue form

**Files:**
- Modify: `src/components/SettingsPanel.tsx`, `src/styles/settings.css`
- Create: `.github/ISSUE_TEMPLATE/translation.yml`
- Test: `tests/issue-forms.test.ts` (extend), `tests/static-ui.test.ts` or a new `tests/language-picker.test.ts`

**Interfaces:**
- Consumes: `useServerSettings().language/.languages`, `setLanguage` (Task 4), `useT` (Task 4), `ui.settings.language.*` keys (Task 2).
- Produces: `reportUrl(code: string): string` exported from `src/i18n.ts` (the URL in Global Constraints, `encodeURIComponent` on the code).
- The picker: a `<select>` listing `languages()`; option text `name`, plus ` · {percent}% translated` when under 100, plus ` · work in progress` when `status === 'wip'`. Disabled with the `readOnly` hint when the page has no UI token (same rule the other server settings use). Below it, the report link (`target="_blank" rel="noopener noreferrer"`) for the current language; the same link repeated in the panel's footer. Under `?sim`/`?video` the picker still works locally (`applyLanguage` only, no POST).
- `translation.yml`: name "Translation error", labels `[translation]`, body fields with ids `language` (input, required), `where` (input: "Where in the office?"), `current` (textarea: "What it says"), `suggested` (textarea: "What it should say", required).
- [ ] **Step 1: Write the failing tests:** issue-forms test asserts `translation.yml` parses, has the four ids, `language` and `suggested` required; `reportUrl('zh-TW')` = `https://github.com/W17ant/Claude-Office/issues/new?template=translation.yml&language=zh-TW`; a source test asserts SettingsPanel renders the picker with `data-testid="language-picker"` and a link built with `reportUrl` (follow `static-ui.test.ts`'s existing source-scan style).
- [ ] **Step 2: Run** those tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "i18n: language picker and translation-error reports"`

### Task 6: Extract the page's strings, part 1 (chrome)

**Files:** `src/App.tsx`, `src/components/{SettingsPanel,StatusStrip,SessionStrip,Meters,TodayPanel,RoomSwitcher,TaskBoard,IncidentBadge}.tsx`, `src/{recap,taskBoard,meters,rooms}.ts` where they produce visible text, `locales/en.json`, CSS files touched for wrapping.
**Test:** `tests/hardcoded-strings.test.ts` (new)

**Interfaces:**
- Consumes: `useT` / `t` (Task 4), Intl helpers (Task 1).
- Produces: `ui.<area>.<name>` keys in `en.json`, areas named after the component (`ui.statusStrip.*`, `ui.meters.*` …). Keys stay camelCase.

- The hard-coded-strings test scans an explicit `IN_SCOPE` file list (this task's files, extended by Task 7) for: JSX text nodes with a letter run of 3+ (`/>\s*[^<{}\s][^<{}]*[A-Za-z]{3}[^<{}]*</`), and `title=`, `aria-label=`, `placeholder=`, `alt=` attributes given a quoted literal containing a letter. An `ALLOWED` list in the test holds exceptions with a one-line reason each (brand names such as "Agent Office", "Claude", symbols, character names).
- Dates and times shown use `formatTime` / `formatDate`; costs use `formatMoney`; counts with a noun use plural keys (`_one`/`_other`).
- Labels that can grow (buttons, pills, strip cells, panel titles) get `overflow-wrap: anywhere` or `text-overflow: ellipsis` with a `title` holding the full text. Check by temporarily setting every en value to its text ×1.4 in the browser (`/?sim`) and looking; nothing overflows its box.

- [ ] **Step 1: Write the test** with the part-1 files in `IN_SCOPE`. **Run**: `npx vitest run tests/hardcoded-strings.test.ts`. Expected: FAIL listing the literals found.
- [ ] **Step 2: Move each literal** to `en.json` and call `t()`. Wording unchanged.
- [ ] **Step 3: Run** `npx vitest run tests/hardcoded-strings.test.ts tests/locales.test.ts && npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 4: Look at it.** `npm run dev:all`, open `/?sim`; nothing reads as a raw key; the 1.4× check above passes. Note any fix in the ledger.
- [ ] **Step 5: Commit** `git commit -m "i18n: the office's chrome reads from en.json"`

### Task 7: Extract the page's strings, part 2 (cards, chat, inspector, phone)

**Files:** `src/components/{AgentCard,PermissionCard,SlackChat,PhoneOffice,ViewerStage,IncidentLayer,AdventCalendar,DeskScreens,EffectBubble,SpeechBubble,DoorLinks}.tsx`, `src/{inspector,permissions,events,advent,season}.ts` where they produce visible text, `src/styles/*.css` as needed, `locales/en.json`.
**Test:** add these files to `IN_SCOPE` in `tests/hardcoded-strings.test.ts`.

- `src/inspector.ts` builds DOM directly: translated text goes in with `textContent`, never `innerHTML`.
- `src/events.ts` turns tool events into visible activity text ("Reading a file" …): one key per kind under `ui.activity.*`, chosen through a literal-key map (the dynamic-key check forbids `t(\`…${kind}\`)`).
- Same steps as Task 6: RED scan, move, GREEN scan + `tests/locales.test.ts` + `tsc`, look at `/?sim` and the phone page, commit `"i18n: cards, chat, inspector and the phone page read from en.json"`.

### Task 8: Agent chatter

**Files:** `src/theme.ts` (pools at ~197–270), `src/incident.ts` (`INCIDENT_LINES` ~485), `src/roomLife.ts` / `src/interactions.ts` if they hold spoken lines, `locales/en.json`
**Test:** `tests/theme.test.ts`, `tests/incident.test.ts` (extend)

**Interfaces:**
- Produces: `chatter.default.{spawn,work,done,coffee,water}`, `chatter.office.{spawn,work,done,coffee,water}`, `chatter.incident.<kind>` lists; any other spoken pool under `chatter.<area>.<kind>`.
- `themedSpawn()` etc. pick from `list('chatter.<theme>.<kind>')`; `pickIncidentLine(kind)` from `list('chatter.incident.<kind>')`, both through a literal-key map. `INCIDENT_LINES` stays exported as the English pools only if tests or `?sim` content need it; otherwise removed.
- [ ] **Step 1: Write the failing tests:** with `applyLanguage` set to a stubbed catalog whose `chatter.default.spawn` is `['siap']`, `themedSpawn()` returns `'siap'`; with an empty translated list, it returns a member of the English list; `pickIncidentLine('spawn')` likewise.
- [ ] **Step 2: Run** `npx vitest run tests/theme.test.ts tests/incident.test.ts`. Expected: FAIL.
- [ ] **Step 3: Move the pools** to `en.json` (text unchanged) and read them through `list()`.
- [ ] **Step 4: Run** those tests plus `tests/locales.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "i18n: agent chatter reads from the locale files"`

### Task 9: Server chat messages and notifications

**Files:** `server/index.js` (slash commands ~2255–2335, the 🔒 reply ~2457, other `addMessage({ sender: 'system' … })` text), `server/recap.js` (`recapLine` and recap text), `server/permission-notify.js` (`PERMISSION_NOTIFY_TITLE`, `permissionNotificationText`), `locales/en.json`
**Test:** `tests/chat-prompts.test.ts` or the existing slash-command tests, `tests/recap.test.ts`, `tests/permission-notify.test.ts` (extend)

**Interfaces:**
- Consumes: `server/i18n.js` `t`, `list`, `getLanguage` (Task 3); `formatMoney`, `formatNumber` (Task 1).
- Produces: `server.commands.*`, `server.system.*`, `server.recap.*`, `server.notify.*` keys.
- Command names in replies (`/status`, `/clear`), `@`-mentions, file paths, project and tool names stay as data in placeholders, never inside translated text.
- A message is translated when written and stored as text (no re-translation).
- [ ] **Step 1: Write the failing tests:** with a temp locale dir holding a `de` catalog that translates `server.commands.help` and `server.notify.title`, and `setLanguage('de')`: `/help` posts the German text; `permissionNotificationText(...)` returns the German title with the project and tool unchanged; a recap line formats a cost with `formatMoney(…, 'de')`. With `setLanguage(null)` the existing English assertions still pass unchanged.
- [ ] **Step 2: Run** the three test files. Expected: FAIL.
- [ ] **Step 3: Implement.** `server/i18n.js` gains `useLocaleDir(dir)` (test-only, documented as such) if the tests need a temp catalog dir.
- [ ] **Step 4: Run** the three test files plus `tests/locales.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "i18n: server chat messages, the recap and notifications"`

### Task 10: The chat bot

**Files:** `scripts/chat-ai-watcher.sh` (`route_message` ~136, `do_reply` prompt ~197, the 15-word cut ~221), `locales/en.json` (`server.routing.<role>` lists, English keywords stay in the script)
**Test:** `tests/scripts.test.ts` (extend; it already runs the watcher)

**Interfaces:**
- Consumes: GET /settings `language` and `languages[].englishName` (Task 3).
- The watcher reads `language` from `$SERVER/settings` once per reply. When it is not `null`/`en`, the prompt gains one line: `Reply in <englishName>.` placed after the "Keep it short" line.
- `route_message` takes the language as a second argument and appends that locale's `server.routing.<role>` keywords (from `$SCRIPT_DIR/../locales/<code>.json`, read by the same inline python; a missing or bad file is ignored) to the English keyword lists. The English route table and sender names are unchanged.
- The cut: 15 words; then, when the reply contains Han, Hiragana, Katakana or Hangul, also cap it at 40 characters. // Why: 40 CJK characters is about what 8–12 English words say; the word cut never fires on unspaced text.
- The bot posts nothing on failure (unchanged).
- [ ] **Step 1: Write the failing tests:** routing a German-keyword message ("Absturz") with a temp `de.json` whose `server.routing.debugger` has `"absturz"` → `debugger|Debugger`; an English message still routes as today; the cut on a 120-character Chinese reply returns 40 characters; a stubbed `claude` captures the prompt and it contains `Reply in German.` when the server says `de`, and no such line for `en`.
- [ ] **Step 2: Run** `npx vitest run tests/scripts.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run tests/scripts.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "i18n: the chat bot replies in the office's language"`

### Task 11: Coverage script and contributor docs

**Files:**
- Create: `scripts/i18n-coverage.mjs`
- Modify: `CONTRIBUTING.md` (new *Add or fix a language* section, per spec), `README.md` (one line under features + the language list), `docs/reference.md` (`language` setting, `/settings` fields, `settings` message), `CHANGELOG.md` (`## Unreleased`)
- Test: `tests/locales.test.ts` (extend)

**Interfaces:**
- Consumes: `checkLocale`, `loadLocaleFiles` (Task 2), `completeness`, `flatten` (Task 1).
- `node scripts/i18n-coverage.mjs` prints one row per locale: code, name, `wip`, completeness %, missing count, stale count. `--keys <code>` prints missing then stale keys as `key<TAB>English`. Stale: keys whose en value differs between `git show <last commit touching locales/<code>.json>:locales/en.json` and the current en.json; when git or the history is unavailable, stale is reported as `?` and the script still exits 0.
- Exports `coverageRows(dir: string, gitShow?: (rev: string, path: string) => string | null)` for the test.
- [ ] **Step 1: Write the failing test:** `coverageRows` on a temp dir with en (3 keys) and de (1 key, its en at last commit had a different value for that key) → de row `{ completeness: 33, missing: 2, stale: 1 }`; with `gitShow` returning `null` → `stale: null`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** the script; write the docs.
- [ ] **Step 4: Run** `npx vitest run tests/locales.test.ts && node scripts/i18n-coverage.mjs`. Expected: PASS; table shows `en 100%`.
- [ ] **Step 5: Commit** `git commit -m "i18n: coverage script and how to add a language"`

### Task 12: Twelve draft languages (parallel agents)

**Files:** Create `locales/{es,pt-BR,fr,de,it,ja,ko,zh-CN,zh-TW,id,ru,tr}.json`; modify `CHANGELOG.md` credits.

Runs after Task 11, when `en.json` is final. The controller dispatches **12 agents in parallel** (one message, `effort: "lower"` is not used: translation quality matters), each with this brief, filled per language:

> Translate `locales/en.json` of the Agent Office (a pixel-art office where AI coding agents appear as office workers) into **<englishName> (<code>)**. Write `locales/<code>.json` with the same keys and structure. `meta`: `name` = the language's own name, `englishName` = "<englishName>", `status` = "wip", `translators` = [] (plus a fork author below if you use their wording). Rules: keep every `{placeholder}` exactly; keep slash commands (`/status`), `@`-mentions, product names (Agent Office, Claude, Codex, Gemini, OpenCode, Kimi, Antigravity) and character names (Michael, Dwight, Jim, Pam …) in English; plain text only, no markup; short UI labels stay short (buttons, pills); chatter lines are casual office talk, translated for tone, not word for word, and a list may be shorter or longer; plurals: add the `_few`/`_many`/… forms <englishName> needs, per `Intl.PluralRules('<code>')`; `server.routing.<role>` lists: add common <englishName> words a person would use for that topic (lower case). <If a fork exists:> A community fork already translated an older version: read its strings with `gh api repos/<owner>/Claude-Office/...` (compare with upstream `W17ant/Claude-Office`); reuse its wording where it still fits and add "<owner>" to `meta.translators` only if you did. Run `node scripts/i18n-check.mjs <code>` until it prints `ok`. Do not edit any other file. Report: the check result, completeness from `node scripts/i18n-coverage.mjs`, and a list of strings you could not translate well, each as `key: why`.

Forks: `id` → Generyodai8, `zh-TW` → Yao920127, `es` → waguirre, `pt-BR` → sannmoraes.

- [ ] **Step 1: Dispatch** the 12 agents in one message.
- [ ] **Step 2: For each report:** run `node scripts/i18n-check.mjs <code>`. Expected: `ok`. A failing file goes back to its agent (SendMessage) once; still failing → the controller fixes it by hand and ledgers a ruling.
- [ ] **Step 3: Run** `npx vitest run tests/locales.test.ts && node scripts/i18n-coverage.mjs`. Expected: PASS; 12 rows marked `wip`, each ≥ 95%.
- [ ] **Step 4: Look at it.** `/?sim` in `de` (longest), `ja` and `zh-TW`: no overflow, no English left in the chrome except the allowed names. Fix overflow in CSS (ledger it).
- [ ] **Step 5: Collect** every agent's "could not translate well" list into `.superpowers/sdd/<plan>/translation-notes.md` for the PR description. Add credits for any fork author used to `CHANGELOG.md`.
- [ ] **Step 6: Commit** `git add locales CHANGELOG.md && git commit -m "i18n: twelve draft languages, marked work in progress"`

---

After Task 12: the full suite (`npm test`), `npm run build`, then the final whole-branch review. The PR description lists the 12 languages, the agents' notes, asks native speakers to check them via the report link, and closes nothing (#116 stays open for corrections). A comment on #116 is drafted and posted only on the owner's OK after merge.
