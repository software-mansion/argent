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

/**
 * The reserved table lives here, beside {@link SCRIPT_ENV_NAME_PATTERN}, for the
 * reason the pattern does: `argent flow run --env` is one of the channels held
 * to it and cannot import from the tool server. Held together because the two
 * rules are asked TOGETHER, and one reserved name fails the pattern.
 */
describe("reserved script env names", () => {
  it("claims npm's own spelling, which the name pattern does not accept", () => {
    // The whole reason the two rules must be read off one place. Asked in the
    // wrong order, an author writing the documented name is told it is not an
    // environment variable name at all.
    expect(SCRIPT_ENV_NAME_PATTERN.test("npm_config_node-options")).toBe(false);
    for (const spelling of [
      "npm_config_node-options",
      "npm_config_node_options",
      "NPM_CONFIG_NODE_OPTIONS",
      "npm_config_NODE-OPTIONS",
    ]) {
      expect(reservedScriptEnvName(spelling), spelling).toBe("npm_config_node-options");
    }
    // A key npm does not hand to NODE_OPTIONS is free.
    expect(reservedScriptEnvName("npm_config_registry")).toBeUndefined();
    expect(reservedScriptEnvName("npm_config_user-config")).toBeUndefined();
  });

  it("folds case only where the platform does", () => {
    expect(reservedScriptEnvName("Node_Options", false)).toBeUndefined();
    expect(reservedScriptEnvName("Node_Options", true)).toBe("NODE_OPTIONS");
    // Read at CALL time, so a test can fake the platform around it.
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
