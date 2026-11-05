import { describe, it, expect, afterEach } from "vitest";
import { Registry } from "@argent/registry";
import { jsRuntimeDebuggerBlueprint } from "../../src/blueprints/js-runtime-debugger";
import { debuggerEvaluateTool } from "../../src/tools/debugger/debugger-evaluate";
import { startMockMetroCdp, type MockMetroCdp } from "./metro-cdp-harness";
import { scopeTempHome } from "../helpers/temp-home";

scopeTempHome("argent-debugger-release-support-home-");

let metro: MockMetroCdp | null = null;
let registry: Registry | null = null;

afterEach(async () => {
  await registry?.dispose();
  await metro?.close();
  registry = null;
  metro = null;
});

/**
 * Run `debugger-evaluate` twice through the real blueprint. Returns every CDP
 * method the target received, and those of the second call alone.
 */
async function evaluateTwice(legacy: boolean): Promise<{ all: string[]; second: string[] }> {
  metro = await startMockMetroCdp({ legacy });
  registry = new Registry();
  registry.registerBlueprint(jsRuntimeDebuggerBlueprint);
  registry.registerTool(debuggerEvaluateTool);
  const params = { port: metro.port, device_id: "mock-device", expression: "({a:1})" };
  await registry.invokeTool("debugger-evaluate", params);
  const before = metro.methods.length;
  const result = (await registry.invokeTool("debugger-evaluate", params)) as { result: unknown };
  expect(result.result).toBe("mock");
  return { all: [...metro.methods], second: metro.methods.slice(before) };
}

describe("debugger-evaluate release support by target", () => {
  it("evaluates by value on a legacy target, with no probe and no handles", async () => {
    const { all, second } = await evaluateTwice(true);
    expect(all).not.toContain("Runtime.releaseObjectGroup");
    expect(all).not.toContain("Runtime.callFunctionOn");
    expect(second).toEqual(["Runtime.evaluate"]);
  });

  it("asks a modern target about release support", async () => {
    const { all } = await evaluateTwice(false);
    expect(all).toContain("Runtime.releaseObjectGroup");
  });
});
