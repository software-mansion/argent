// Configurable constants for the argent CLI.
// Change these if the npm package name, registry, or MCP key changes.

export const PACKAGE_NAME = "@swmansion/argent";

// Used ONLY for single-package queries (e.g. `npm view`), never for install
// commands. Install relies on the user's scoped registry in ~/.npmrc so that
// third-party dependencies resolve from npmjs.org normally.
export const NPM_REGISTRY = "https://registry.npmjs.org";
export const MCP_SERVER_KEY = "argent";
export const MCP_BINARY_NAME = "argent";
export const CLAUDE_PERMISSION_RULE = "mcp__argent";
export const CURSOR_ALLOWLIST_PATTERN = "argent:*";
export const CODEX_APPROVAL_MODE = "approve";

// Keep this list in sync with the tool ids registered in
// packages/tool-server/src/utils/setup-registry.ts.
export const ARGENT_TOOL_NAMES = [
  "boot-simulator",
  "button",
  "debugger-component-tree",
  "debugger-connect",
  "debugger-evaluate",
  "debugger-inspect-element",
  "debugger-log-registry",
  "debugger-reload-metro",
  "debugger-status",
  "describe",
  "dismiss-update",
  "flow-add-echo",
  "flow-add-step",
  "flow-execute",
  "flow-finish-recording",
  "flow-read-prerequisite",
  "flow-start-recording",
  "gather-workspace-data",
  "gesture-custom",
  "gesture-pinch",
  "gesture-rotate",
  "gesture-swipe",
  "gesture-tap",
  "ios-profiler-analyze",
  "ios-profiler-start",
  "ios-profiler-stop",
  "keyboard",
  "launch-app",
  "list-simulators",
  "native-describe-screen",
  "native-devtools-status",
  "native-find-views",
  "native-full-hierarchy",
  "native-network-logs",
  "native-user-interactable-view-at-point",
  "native-view-at-point",
  "open-url",
  "paste",
  "profiler-combined-report",
  "profiler-commit-query",
  "profiler-cpu-query",
  "profiler-load",
  "profiler-stack-query",
  "react-profiler-analyze",
  "react-profiler-component-source",
  "react-profiler-cpu-summary",
  "react-profiler-fiber-tree",
  "react-profiler-renders",
  "react-profiler-start",
  "react-profiler-stop",
  "reinstall-app",
  "restart-app",
  "rotate",
  "run-sequence",
  "screenshot",
  "simulator-server",
  "stop-all-simulator-servers",
  "stop-metro",
  "stop-simulator-server",
  "update-argent",
  "view-network-logs",
  "view-network-request-details",
] as const;
