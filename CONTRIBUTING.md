# Contributing

Thanks for helping. A few ground rules so a pull request lands quickly.

## What we are building

Claude Office is an office that tells the truth about Claude Code: every
session, agent, wait, failure and dollar, live. Work that makes the office more
truthful (hook fidelity, session and worker lifecycle, meters, incident
signals, install/uninstall) comes first. New costume skins are not the
priority; the plan is to make skins data (a folder you drop in) before adding
another one, so a skin PR will wait for that. Seasonal variants on the incident
axis are welcome once the art exists.

## Before you open a PR

- Run `npm test`. It runs the Vitest suite against a temp `AGENT_OFFICE_HOME`,
  so it never touches your real `~/.agent-office`. CI runs it, `tsc --noEmit`
  and `vite build` on every pull request; all three must pass.
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
