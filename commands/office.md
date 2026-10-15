---
description: Check whether the Agent Office server is up and show how to start it
allowed-tools: Bash(curl -s -m 2 http://127.0.0.1:3334/health:*)
disable-model-invocation: true
---

# Agent Office

Health of the office server (`GET http://127.0.0.1:3334/health`; empty when nothing is listening):

```
!`curl -s -m 2 http://127.0.0.1:3334/health`
```

Tell the user whether the office is up, in one or two lines.

If the health check above is empty, the server is not running. Do not start it yourself (it is a long-running process); show these commands instead, and say that the installed plugin is a full checkout of the repository, so either directory works:

```bash
# from the installed plugin
cd "${CLAUDE_PLUGIN_ROOT}" && npm install && npm run build && npm run server

# or from your own clone
git clone https://github.com/W17ant/Claude-Office && cd Claude-Office && npm install && npm run build && npm run server
```

Then open the office with `npm run open` from the same directory: it opens http://127.0.0.1:3334/ with the office token, which the page needs to show prompts and replies and to answer permission dialogs (the server also prints that link when it starts; a bare address shows the office read-only). Agents spawned in this session appear there through this plugin's hooks; nothing else needs installing. The payroll / electricity meters are the one part a plugin cannot register (Claude Code lets a plugin set `subagentStatusLine` but not `statusLine`; MEMORY is estimated from the session transcript without it), so for those run `npm run install-status-line` from the same directory: it registers the status line and nothing else. Do not suggest `npm run install-hooks` to a plugin user: it registers every hook a second time, next to the plugin's, and every event then reaches the office twice.
