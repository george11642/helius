# src/agent

The agent loop lands here: parses hiker intent, plans a tool-call chain against `src/tools/`, and streams the trace + result back to the shell's tool-trace overlay.
