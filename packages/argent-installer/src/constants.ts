// Configurable constants for the argent CLI.
// Change these if the npm package name, registry, or MCP key changes.

export const PACKAGE_NAME = "@swmansion/argent";

// Used ONLY for single-package queries (e.g. `npm view`), never for install
// commands. Install relies on the user's scoped registry in ~/.npmrc so that
// third-party dependencies resolve from npmjs.org normally.
export const NPM_REGISTRY = "https://registry.npmjs.org";
export const MCP_SERVER_KEY = "argent";
export const MCP_BINARY_NAME = "argent";
export const PERMISSION_RULE = "mcp__argent";
export const CURSOR_ALLOWLIST_PATTERN = "argent:*";
