/**
 * Build the environment for spawning a GUI Electron process as a child of the
 * tool-server.
 *
 * The tool-server routinely runs under an Electron-based MCP host — VS Code,
 * Cursor, the Codex desktop app, and friends all spawn their Node children
 * (this tool-server, and the MCP stdio server that starts it) with
 * `ELECTRON_RUN_AS_NODE=1` set in the environment. That flag tells the Electron
 * binary to boot as a bare Node runtime instead of a GUI app.
 *
 * If it leaks into a GUI Electron child we launch, the child boots in Node
 * mode: `require("electron")` returns the executable PATH string (not the
 * Electron module), so `.app` is `undefined` and the process crashes at the
 * first `app.*` call — e.g. `app.setName()` at the top of the Lens preview
 * window's main entry. The failure is silent from the tool-server's side: the
 * window never appears and a parked `await_user_selection` just hangs.
 *
 * Stripping the variable makes a GUI Electron child boot as a real Electron app
 * regardless of what launched the tool-server. Any per-launch additions (the
 * preview URL, logging flags) are layered on top via `overrides`.
 */
export function electronGuiChildEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
