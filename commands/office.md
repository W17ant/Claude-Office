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

Then open http://127.0.0.1:3334/ in a browser. Agents spawned in this session appear there through this plugin's hooks; nothing else needs installing. The payroll / electricity / memory meters are the one part a plugin cannot register (Claude Code lets a plugin set `subagentStatusLine` but not `statusLine`), so for those run `npm run install-hooks` from the clone as well.
