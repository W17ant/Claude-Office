# OpenCode plugin events

What hooks/opencode-plugin.js forwards: OpenCode's bus event ({ type,
properties }) plus the plugin's `directory`, and tool.execute.before/after
rebuilt as events of the same shape (tool, sessionID, callID, a few args).
Field names from OpenCode's plugin docs and SDK types via EooL's fork — not
yet seen live. A real capture is the most useful contribution: see
CONTRIBUTING › Add or fix a tool.
