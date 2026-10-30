---
description: Always-on Argent rules for driving, testing and profiling apps on simulators, emulators, phones, TVs and Chromium
alwaysApply: true
---

Argent - general rules:

- do not derive tap coordinates from screenshot pixels; use inspection tools that give coordinates
- use the platform the user named; do not pick a cabled physical phone just because it's listed without explicit intent; in a single-platform project boot that platform.
- if tap fails twice, stop retrying and re-run a discovery tool
- Prefer mcp-tool calls over raw commands like `xcrun` or `adb`; use them as fallback.
- Interaction tools return screenshot and element tree automatically.
- prefer `launch-app` or `open-url` than tapping icons on home screen.
- If a task can require a saved e2e test, use e2e tools before the first launch or in-app action; recording is not retroactive.
- Do not stop simulator servers when a task finishes: the next task reuses them. Call `stop-all-simulator-servers` when the user asks to clean up or ends the session, or when a skill tells you to recycle a device's services, with devices this session used. One tool-server is shared by every other agent, so unscoped call tears down their devices too. Never stop a Metro the user started unless they ask.
- Use the `await-ui-element` tool to block until the UI settles instead of polling using screenshot.
- The `argent` CLI manages the toolkit: `argent --help` lists commands, `argent --version` shows the installed version.

<availability_check>
Run this check once per session. Do not re-probe before later calls.
Confirm argent is available:

1. Are `mcp__argent__*` tools in your tool list? If none, argent is not available.
2. If unsure, run `command -v argent`. Non-zero exit = the CLI is not on PATH.

If argent IS available, ignore the rest of this block and follow this rule normally.

If argent is ABSENT, treat it as an expected state, not an error to retry. Do not call `mcp__argent__*` tools, do not run `argent` commands, do not attempt any argent workflow.
Tell the user once, and ask if you should continue without argent:

> Argent isn't installed in this environment. To enable the mobile/Chromium tooling this repo is configured for, run `npx @swmansion/argent@latest init -y` (or `npm i -g @swmansion/argent@latest && argent init -y`).

</availability_check>
