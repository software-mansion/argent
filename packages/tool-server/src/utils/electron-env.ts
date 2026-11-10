export function isElectronHostedEnv(): boolean {
  return Object.keys(process.env).some((name) => name.toLowerCase() === "electron_run_as_node");
}

/**
 * Environment for a GUI Electron child of the tool-server.
 *
 * Electron-based MCP hosts (VS Code, Cursor, the Codex desktop app) spawn their
 * Node children with `ELECTRON_RUN_AS_NODE=1`. Inherited by a GUI Electron child
 * it boots as bare Node: `require("electron")` yields the executable path string
 * instead of the module, so `app` is undefined and the child dies at its first
 * `app.*` call (e.g. `app.setName()` in the Lens preview main) — silently, so a
 * parked `await_user_selection` just hangs.
 *
 * The strip is case-insensitive because Windows env names are: a host may
 * surface the flag as e.g. `Electron_Run_As_Node`, which the spread preserves
 * and a case-sensitive `delete` would miss.
 */
export function electronGuiChildEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "electron_run_as_node") {
      delete env[key];
    }
  }
  return env;
}
