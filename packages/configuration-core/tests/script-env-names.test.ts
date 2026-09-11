import { describe, it, expect, afterEach, vi } from "vitest";
import {
  BASH_OUTPUT_ENV,
  RESERVED_SCRIPT_ENV_NAMES,
  reservedScriptEnvName,
  reservedScriptEnvNamesForMessage,
  reservedScriptEnvReason,
  SCRIPT_ENV_NAME_PATTERN,
} from "../src/index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reserved script env names", () => {
  it("claims npm's own spelling, which the name pattern does not accept", () => {
    expect(SCRIPT_ENV_NAME_PATTERN.test("npm_config_node-options")).toBe(false);
    for (const spelling of [
      "npm_config_node-options",
      "npm_config_node_options",
      "NPM_CONFIG_NODE_OPTIONS",
      "npm_config_NODE-OPTIONS",
    ]) {
      expect(reservedScriptEnvName(spelling), spelling).toBe("npm_config_node-options");
    }
    expect(reservedScriptEnvName("npm_config_registry")).toBeUndefined();
    expect(reservedScriptEnvName("npm_config_user-config")).toBeUndefined();
  });

  it("folds case only where the platform does", () => {
    expect(reservedScriptEnvName("Node_Options", false)).toBeUndefined();
    expect(reservedScriptEnvName("Node_Options", true)).toBe("NODE_OPTIONS");
    const platform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      expect(reservedScriptEnvName("Electron_Run_As_Node")).toBe("ELECTRON_RUN_AS_NODE");
    } finally {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
    }
    expect(reservedScriptEnvName("Electron_Run_As_Node", false)).toBeUndefined();
  });

  it("gives the exchange pair a reason of its own", () => {
    expect(reservedScriptEnvReason(BASH_OUTPUT_ENV)).toContain(
      "names the file a `.sh` step exchanges"
    );
    expect(reservedScriptEnvReason("NODE_OPTIONS")).toBe("steers the runner's own process");
  });

  it("names every reserved spelling in one sentence", () => {
    const message = reservedScriptEnvNamesForMessage();
    for (const name of RESERVED_SCRIPT_ENV_NAMES) expect(message, name).toContain(name);
    expect(message).toContain("npm_config_node-options");
    expect(message).toContain("npm_config_userconfig");
    expect(message).toContain("npm_config_globalconfig");
  });
});
