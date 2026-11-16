# Community: easier to suggest and contribute — design

Short design (a small change). Approved 2026-11-16.

## Why

Claude Office is a bit of fun, and the goal is more community engagement:
stars, downloads, and features that come from other GitHub users. 93 forks
exist; 14 carry work that never came back upstream, and the same themes repeat
(other AI tools in 5 forks, translations in 4, Windows in 3, custom teams and
rooms in 4). There is nowhere for those people to land: Discussions is off,
the issue templates are free text, and there is no social preview image.

This is project 1 of 3. Project 2 (other AI tools) and project 3 (translations
and team packs as data) get their own designs after this ships.

## Goals

- Somewhere to suggest and vote on ideas (Discussions › Ideas).
- Issue forms that capture what triage needs (how it is run, version, OS, AI
  tool) and who wants to build it.
- A visible route for fork work to come upstream, with credit.
- The repo looks alive when shared (badges, preview image).

## Non-goals

- Building any of the forks' features (projects 2 and 3).
- Changing the code of the office.

## Anti-goals

- Spam: one @mention of the five multi-tool fork authors, in one issue, and no
  other unsolicited pings.
- Promising features: tracking issues say what forks built and invite help;
  they do not commit to dates.

## Approaches

Only one sensible way for a change this size: GitHub's own features (Discussions
with default categories, issue forms, labels) plus docs. A bot or external
community (Discord) was not considered worth it for a fun project at this scale.

## Decisions

- **Discussions** on, default categories (Announcements, General, Ideas, Polls,
  Q&A, Show and tell). A pinned post, "What should the office do next?",
  lists the three fork themes and asks for votes.
- **Issue forms** (`.github/ISSUE_TEMPLATE/*.yml`) replace the Markdown
  templates: bug report and feature request, each with "how you run it"
  (npx / desktop app / checkout / plugin), version, OS and AI tool dropdowns
  and an "I'd like to build this" checkbox. `config.yml` points open-ended
  ideas and questions at Discussions.
- **Three tracking issues**, labelled `help wanted`: other AI tools (tags the
  five fork authors: EooL, gilberth, waguirre, lafuan, torintran — approved),
  translations, Windows. Each lists the forks that built it.
- **CONTRIBUTING**: a "Got something in your fork?" section; credit by name in
  the changelog and release notes (the no-Co-Authored-By rule stays). The
  "skins wait" line now points at project 3.
- **README**: npm version, npm downloads and stars badges; a short Community
  section.
- **Social preview**: 1280×640 PNG composed from `docs/images/Day-Mode.png`
  (no paid generation). GitHub has no API for it; the owner uploads it in
  Settings.

## Left to the builder

Exact wording of forms, issues and the pinned post; badge style; preview layout.
