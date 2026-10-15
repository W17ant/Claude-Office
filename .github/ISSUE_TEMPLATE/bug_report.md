---
name: Bug report
about: Something in the office is wrong or does not match what Claude Code is doing
title: ''
labels: bug
assignees: ''
---

**What happened**
A clear sentence or two. If the office shows something different from what Claude Code did, say what each one showed.

**Steps to reproduce**
1. ...
2. ...

**Expected**
What you expected the office to show or do.

**Environment**
- Claude Code version (`claude --version`):
- OS (macOS / Linux / Windows via WSL or Git Bash):
- Node version (`node --version`):
- How you run the office: `npm run build && npm run server` / `bash scripts/start-office.sh` / `npm run dev:all` / desktop app (`npm run pack` or `npm run build:electron`)
- Hooks installed with `npm run install-hooks`? (yes / no / edited by hand)

**Logs or screenshots**
`~/.agent-office/chat-ai.log`, the server output, a hook error Claude Code printed, or a screenshot of the office. Strip anything private.
