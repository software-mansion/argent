import * as path from "node:path";
import type { ToolsServerPaths } from "@argent/tools-client";

// __dirname in ESM (compiled from TS) will be dist/.
// Bundle artifacts ship next to the compiled launcher.
export const BUNDLED_RUNTIME_PATHS: ToolsServerPaths = {
  bundlePath: path.join(import.meta.dirname, "tool-server.cjs"),
  simulatorServerDir: path.join(import.meta.dirname, "..", "bin"),
  nativeDevtoolsDir: path.join(import.meta.dirname, "..", "dylibs"),
};
