/**
 * The MCP server `instructions`, sent to the client once at `initialize`. Kept in
 * a module of its own so scripts/render-agent-context.mjs can render it without
 * starting a server.
 *
 * This is the only always-on guidance Argent gives an agent: argent init writes
 * no global rule, since Claude Code, Codex, Gemini CLI and Cursor all pass this
 * text to the model. Guidance that matters before the first tool call belongs
 * here, not in packages/skills/rules.
 */
export const SERVER_INSTRUCTIONS =
  "Argent — iOS Simulator, Android Emulator, and Chromium app control for interacting, testing, profiling and debugging mobile and Chromium applications. " +
  "Use the platform the user named; otherwise prefer a device list-devices shows already running, and do not default to iOS. In a single-platform project, boot that platform; for a web app, boot a browser (boot-device with browser), then open-url. " +
  "Prefer these tools over raw xcrun or adb commands, which are a fallback. Prefer launch-app or open-url over tapping home-screen icons. " +
  "If the task may need a saved e2e test, load the argent-create-e2e skill (argent-qa-e2e for acceptance tests) before the first launch or in-app action: recording is not retroactive. Load the matching argent-* skill before React Native build or debug work, profiling, a physical phone, a Mac app or a TV. " +
  "Interaction tools return the screen after the action: a screenshot plus the accessibility element tree with normalized tap frames. Take coordinates from that tree; call describe only when no fresh tree is available — never guess coordinates from pixels. A result names an identical earlier tree by its tree id in place of repeating it. " +
  "If a tap fails twice, stop retrying and call a discovery tool again. Use await-ui-element to wait for the UI instead of polling with screenshots. " +
  "Do not stop simulator servers when a task finishes: the next task reuses them. Call stop-all-simulator-servers when the user asks to clean up or ends the session, or when a skill tells you to recycle a device's services, always with devices: [...] naming the devices this session used. Never stop a Metro the user started unless they ask. " +
  "One tool-server is shared by every agent using this argent install, so an unscoped call tears down their devices too — reserve it for a deliberate machine-wide cleanup. " +
  "The argent CLI manages the toolkit: argent --help lists its commands.";
