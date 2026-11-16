# Community: easier to suggest and contribute — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the community a place to suggest, vote on and upstream features, and make the repo look alive when shared.

**Architecture:** GitHub-native only: Discussions (default categories), YAML issue forms, labelled tracking issues, and docs (CONTRIBUTING, README). One generated PNG for the social preview. No office code changes.

**Tech Stack:** GitHub issue forms (YAML), `gh` CLI (REST + GraphQL), Python 3 + Pillow for the preview image, Vitest for a form-structure test.

**Spec:** `docs/superpowers/specs/2026-11-16-community-design.md`

## Global Constraints

- Exactly one @mention round: the five fork authors (EooL, gilberth, waguirre, lafuan, torintran), in the "other AI tools" issue only.
- Tracking issues invite help and list what forks built; no dates or promises.
- No `Co-Authored-By` lines or tool trailers in commits or PR bodies (CONTRIBUTING rule); credit goes in CHANGELOG and release notes.
- Social preview 1280×640 PNG, built from `docs/images/Day-Mode.png`, no paid generation.
- Every new file has a one-line header comment where the format allows (YAML `#`, Python docstring, TS `/** */`).

## Review Focus

- A form dropdown option list that does not match how the office is really run → options must be exactly: `npx @w17ant/agent-office`, `Desktop app`, `From a checkout (npm run …)`, `Claude Code plugin`. Pinned by the form test (Task 1).
- Blank issues still allowed, so people skip the forms → `config.yml` sets `blank_issues_enabled: false`. Pinned by the form test.
- Badges pointing at the wrong npm name → all badge URLs use `@w17ant/agent-office`; checked by grep in Task 3.
- Preview text unreadable at thumbnail size → title at least 72 px; checked by viewing the PNG at 25 % in Task 4.
- Pinned post or issues created twice on a re-run → each creation step first searches by exact title and skips if found (Task 5).

---

### Task 1: Issue forms

**Files:**
- Delete: `.github/ISSUE_TEMPLATE/bug_report.md`, `.github/ISSUE_TEMPLATE/feature_request.md`
- Create: `.github/ISSUE_TEMPLATE/bug_report.yml`, `.github/ISSUE_TEMPLATE/feature_request.yml`, `.github/ISSUE_TEMPLATE/config.yml`
- Test: `tests/issue-forms.test.ts`

**Interfaces:** Produces nothing later tasks call.

- [ ] **Step 1: Write the failing test** `tests/issue-forms.test.ts` — parse each YAML with the `yaml` package if present in node_modules, else a minimal check via regex on the raw text. Assertions:
  - both forms exist and have `name`, `description`, `labels` (`bug` / `enhancement`) and a `body` array;
  - each form has a `dropdown` with id `how-run` whose options equal the four strings in Review Focus, in that order;
  - each form has a `dropdown` with id `ai-tool` including `Claude Code` and `Other`;
  - `feature_request.yml` has a `checkboxes` item with label `I'd like to build this`;
  - `config.yml` has `blank_issues_enabled: false` and `contact_links` with URLs to `/discussions/categories/ideas` and `/discussions/categories/q-a`.
- [ ] **Step 2: Run** `npx vitest run tests/issue-forms.test.ts` — Expected: FAIL (files missing).
- [ ] **Step 3: Write the three YAML files.** Bug form fields: what happened (required), what you expected, steps, how-run, version (input, placeholder `1.3.0`), OS dropdown (macOS / Linux / Windows (WSL) / Windows (native)), ai-tool, Claude Code version (input). Feature form: what should the office do (required), why, how-run, ai-tool, "Built it in a fork already? Link it" (input), build checkbox. Keep the existing forms' "truth features come first" wording.
- [ ] **Step 4: Run** the test — Expected: PASS.
- [ ] **Step 5: Commit** `Issue forms: how you run it, which AI tool, and "I'd like to build this"`.

### Task 2: CONTRIBUTING

**Files:** Modify `CONTRIBUTING.md`

- [ ] **Step 1:** Replace the "New costume skins are not the priority…" sentences with: skins, translations and teams become data in a later project (link the translations tracking issue once Task 5 exists — leave `#TRANSLATIONS` placeholder and fill it in Task 5).
- [ ] **Step 2:** Add `## Got something in your fork?` after "What we are building": open an issue or a Discussion › Show and tell first, then a PR against `main`; one feature per PR; you are credited by name in `CHANGELOG.md` and the release notes; the no-Co-Authored-By rule stays.
- [ ] **Step 3:** Add `## Ideas and questions`: Discussions › Ideas (vote with 👍), Q&A; bugs are issues.
- [ ] **Step 4: Commit** `CONTRIBUTING: bring your fork's work upstream, credited by name`.

### Task 3: README badges and Community section

**Files:** Modify `README.md` (top, under the title; and a new section before `## Security` or the licence)

- [ ] **Step 1:** Under `# Claude Office` add one line of shields.io badges: npm version (`https://img.shields.io/npm/v/@w17ant/agent-office`), npm downloads per month (`/npm/dm/@w17ant/agent-office`), GitHub stars (`/github/stars/W17ant/Claude-Office?style=social`), latest release (`/github/v/release/W17ant/Claude-Office`), each linking to npm / the repo / releases.
- [ ] **Step 2:** Add `## Community`: three bullets — suggest and vote in Discussions › Ideas; show your office in Show and tell; built something in a fork? see CONTRIBUTING › Got something in your fork?
- [ ] **Step 3: Verify** `grep -n "img.shields.io" README.md` shows 4 lines, none containing `agent-office` without `@w17ant/`.
- [ ] **Step 4: Commit** `README: badges and a Community section`.

### Task 4: Social preview image

**Files:**
- Create: `scripts/social-preview.py` (docstring header), `docs/images/social-preview.png`

- [ ] **Step 1:** Write `scripts/social-preview.py`: input `docs/images/Day-Mode.png`, output 1280×640 PNG. Layout: screenshot scaled with nearest-neighbour (pixel art) to fill the right ~62 %, a dark panel on the left with "Claude Office" (≥ 72 px, bold system font, fallback to PIL default scaled), a one-line tagline "Watch your AI agents work in a pixel-art office", and `npx @w17ant/agent-office` in monospace.
- [ ] **Step 2: Run** `python3 scripts/social-preview.py` — Expected: writes the PNG; `file docs/images/social-preview.png` reports `1280 x 640`.
- [ ] **Step 3: Verify** by viewing the PNG, and a 320×160 downscale: title still legible.
- [ ] **Step 4: Commit** `Social preview image for link shares`.

### Task 5: Discussions, tracking issues, pinned post (GitHub, not files)

Runs after the PR with Tasks 1–4 is merged, so links in issues point at real files.

- [ ] **Step 1:** `gh repo edit --enable-discussions`; verify `gh repo view --json hasDiscussionsEnabled` is `true`, and list categories via GraphQL `repository.discussionCategories` (expect Ideas, Q&A, Show and tell, Announcements).
- [ ] **Step 2:** Create three issues, labels `help wanted` + `enhancement`, each skipped if an open issue with the same title exists:
  - "Other AI tools in the office: Codex, Gemini CLI, OpenCode, Antigravity, Kimi" — lists the five forks with links and one line on what each built; @mentions EooL, gilberth, waguirre, lafuan, torintran once with an invitation to help shape it upstream.
  - "Translations: the office in your language" — lists the Indonesian, Spanish, Portuguese, zh-TW forks (Generyodai8, waguirre, sannmoraes, Yao920127) **without** @mentions; says translations become files in a coming change.
  - "Windows support without WSL" — lists garyjdn, Generyodai8, EooL forks **without** @mentions.
- [ ] **Step 3:** Fill the `#TRANSLATIONS` placeholder in CONTRIBUTING with the real issue number (small follow-up commit/PR).
- [ ] **Step 4:** Create the Discussion "What should the office do next?" in Announcements (GraphQL `createDiscussion`), linking the three issues and Ideas; pin it (`pinDiscussion` if available, else note it for the owner).
- [ ] **Step 5:** Tell the owner to upload `docs/images/social-preview.png` in Settings › General › Social preview.
