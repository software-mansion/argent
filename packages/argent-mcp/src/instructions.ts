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
  "Argent controls iOS, Android, Chromium, Mac, TV, and HarmonyOS apps. " +
  "Use the platform named by the user; otherwise prefer an already-running device from `list-devices` (do not default to iOS). In a single-platform project, boot that platform. " +
  "Prefer Argent tools over raw `xcrun`/`adb`; use `launch-app`/`open-url` instead of tapping home-screen icons. " +
  "Load `argent-create-e2e` (`argent-qa-e2e` for acceptance tests) before the first action if an e2e test may be needed (recording is not retroactive), and load the matching `argent-*` skill before React Native build/debug, profiling, physical phone, Mac app, or TV work. " +
  "Interaction tools return a screenshot + accessibility tree with normalized [0,1] tap frames (or an unchanged note / `-`+`+` diff referencing an earlier screenshot/tree id). Take tap coordinates from that tree — never guess from pixels — and call `describe` only without a fresh tree. " +
  "After two failed taps, re-discover. Use `await-ui-element` instead of polling. " +
  "Do not stop simulator servers when finishing; call `stop-all-simulator-servers` when asked to clean up or when a skill tells you to recycle a device's services, scoped with `devices: [...]` (the tool-server is shared across agents), and never stop a user-started Metro. CLI: `argent --help`.";
