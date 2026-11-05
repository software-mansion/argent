/**
 * The MCP server `instructions`, sent to the client once at `initialize`. Kept in
 * a module of its own so scripts/render-agent-context.mjs can render it without
 * starting a server.
 */
export const SERVER_INSTRUCTIONS =
  "Argent — iOS Simulator, Android Emulator, and Chromium app control for interacting, testing, profiling and debugging mobile and Chromium applications. " +
  "Interaction tools return the screen after the action: a screenshot plus the accessibility element tree with normalized tap frames. Take coordinates from that tree; call describe (or debugger-component-tree) only when no fresh tree is available — never guess coordinates from pixels. " +
  "Do not stop simulator servers when a task finishes: the next task reuses them. Call stop-all-simulator-servers when the user asks to clean up or ends the session, or when a skill tells you to recycle a device's services, always with devices: [...] naming the devices this session used. Never stop a Metro the user started unless they ask. " +
  "One tool-server is shared by every agent using this argent install, so an unscoped call tears down their devices too — reserve it for a deliberate machine-wide cleanup. " +
  "Full guidance is in the argent rule loaded from .claude/rules/argent.md.";
