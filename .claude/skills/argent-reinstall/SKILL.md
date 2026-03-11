---
name: argent-reinstall
description: Rebuild and reinstall the Argent MCP server globally after making changes to the tool-server or any package in argent. Use after adding new tools, adding new blueprints, or any source change that needs to be reflected in the global MCP installation. Use this ONLY when the user explicitly asks to test their changes globally - in a separate test app.
---

# Argent Global Reinstall

## Script

Run the reinstall script from the repo root:

```
bash scripts/reinstall-argent.sh
```

This script kills any running Argent processes (scoped to the global install path to avoid false positives), then packs and installs globally.

## Notes

- The MCP server entry point is `node /$(npm root -g)/argent/dist/index.js`
- The global install is consumed by ClaudeCode via `/Users/<user>/.claude/settings.json` or OpenCode via `/Users/<user>/.config/opencode/opencode.json`
- After reinstalling, the MCP daemon will be automatically restarted on the next tool call
- If the build fails, fix TypeScript errors first — run `npm run build` inside `packages/tool-server` for faster feedback
