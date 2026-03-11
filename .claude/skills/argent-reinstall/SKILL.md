---
name: argent-reinstall
description: Rebuild and reinstall the Argent MCP server globally after making changes to the tool-server or any package in argent. Use after adding new tools, adding new blueprints, or any source change that needs to be reflected in the global MCP installation. Use this ONLY when the user explicitly asks to test their changes globally - in a separate test app.
---

# Argent Global Reinstall

## Steps

Run both commands sequentially from the repo root (`/<path-to-argent>/argent`):

1. **Pack**

   ```
   npm run pack:mcp
   ```

   This builds the tool-server (`tsc`), bundles it (`bundle-tools.cjs`), and produces `argent-0.1.0.tgz` in the repo root.

2. **Install globally**

   ```
   npm install -g ./argent-0.1.0.tgz
   ```

   This replaces the global installation at `/$(npm root -g)/argent/`.

## Notes

- The MCP server entry point is `node /$(npm root -g)/argent/dist/index.js`
- The global install is consumed by ClaudeCode via `/Users/<user>/.claude/settings.json` or OpenCode via `/Users/<user>/.config/opencode/opencode.json`
- After reinstalling, the MCP daemon must be restarted for changes to take effect (restart the OpenCode session or reload the MCP server)
- If the build fails, fix TypeScript errors first — `npm run build` inside `packages/tool-server` gives faster feedback than the full pack
