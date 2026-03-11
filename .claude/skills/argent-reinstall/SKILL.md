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

3. **Restart the daemon**

   Find and kill the running argent processes:

   ```
   ps aux | grep -E 'argent' | grep -v grep
   ```

   Only kill daemon processes — ignore anything from VSCode, local dev builds, simulators, or other user executables. The target processes look like:
   - `node /.../argent/dist/index.js`
   - `node /.../argent/dist/tool-server.cjs`

   There can be many more processes with similar `/.../argent/` path.
   Note that `...` is the output of `npm root -g`.

   Kill them by PID:

   ```
   kill <pid1> <pid2> ...
   ```

   The MCP client will automatically restart the daemon on the next tool call using the newly installed version.

## Notes

- The MCP server entry point is `node /$(npm root -g)/argent/dist/index.js`
- The global install is consumed by ClaudeCode via `/Users/<user>/.claude/settings.json` or OpenCode via `/Users/<user>/.config/opencode/opencode.json`
- After reinstalling, the MCP daemon must be restarted for changes to take effect (restart the OpenCode session or reload the MCP server)
- If the build fails, fix TypeScript errors first — `npm run build` inside `packages/tool-server` gives faster feedback than the full pack
