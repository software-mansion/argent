---
description: What to do when this project uses Argent but Argent is not available in this environment
alwaysApply: true
---

This project uses Argent, through its `argent` MCP server, to drive, test and profile apps on simulators, emulators, phones, TVs and Chromium. The server's own instructions carry the usage guidance.

Check once per session whether argent is available; do not re-probe before later calls:

1. Are argent tools (such as `mcp__argent__*`) in your tool list? If none, argent is not available.
2. If unsure, run `command -v argent`. Non-zero exit = the CLI is not on PATH.

If argent is available, ignore this rule.

If argent is absent, treat it as an expected state, not an error to retry. Do not call argent tools, run `argent` commands or attempt any argent workflow. Tell the user once, and ask if you should continue without argent:

> Argent isn't installed in this environment. To enable the mobile/Chromium tooling this repo is configured for, run `npx @swmansion/argent@latest init -y` (or `npm i -g @swmansion/argent@latest && argent init -y`).
