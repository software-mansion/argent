import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceInfo, Registry } from "@argent/registry";
import { axServiceRef, type AXDescribeElement } from "../../src/blueprints/ax-service";
import { runDirective, type ActionEnv } from "../../src/tools/flows/flow-actions";
import { parseFlow, serializeFlow } from "../../src/tools/flows/flow-utils";
import { cacheSimulatorRuntimeKind } from "../../src/utils/ios-devices";
import {
  __resetTypedSecretsForTesting,
  noteTypedSecrets,
  WITHHELD_INPUT_TEXT,
} from "../../src/utils/typed-secrets";
import { useAutoAdvancingClock } from "../helpers/auto-clock";

useAutoAdvancingClock();
afterEach(__resetTypedSecretsForTesting);

const device: DeviceInfo = {
  id: "00000000-0000-0000-0000-0000000000ab",
  platform: "ios",
  kind: "simulator",
};
const frame = { x: 0.125, y: 0.5, width: 0.25, height: 0.25 };

function setup(elements: AXDescribeElement[]) {
  cacheSimulatorRuntimeKind(device.id, "mobile");
  const resolveService = vi.fn(async (urn: string) => {
    if (urn !== axServiceRef(device).urn) throw new Error("Unexpected app hierarchy read");
    return {
      degraded: false,
      describe: async () => ({ elements, interfaceOrientation: "landscapeRight" }),
    };
  });
  const invokeTool = vi.fn(async () => ({ tapped: true }));
  const registry = {
    resolveService,
    invokeTool,
    getTool: () => ({ inputSchema: { properties: { udid: {} } } }),
  } as unknown as Registry;
  return {
    env: {
      device,
      registry,
      treeTarget: { bundleId: "com.example.app", pinned: true, probeAnswered: false },
    },
    invokeTool,
    resolveService,
  };
}

async function replay(env: ActionEnv, body: string) {
  const flow = parseFlow(`steps:\n  - ${body}\n`);
  const [step] = parseFlow(serializeFlow(flow)).steps;
  if (step.kind !== "tap" && step.kind !== "await" && step.kind !== "assert")
    throw new Error("Expected a selector directive");
  return runDirective(env, step);
}

describe("explicit iOS simulator accessibility selectors", () => {
  it("taps an AX-only button at its upright center even when the app hierarchy is pinned", async () => {
    const { env, invokeTool } = setup([{ label: "Allow", traits: ["button"], frame }]);
    expect(
      await replay(env, "tap: { on: { ax: { text: Allow, role: Button } }, times: 2 }")
    ).toEqual({ ok: true });
    expect(invokeTool).toHaveBeenCalledWith("gesture-tap", {
      udid: device.id,
      x: 0.625,
      y: 0.75,
      clickCount: 2,
    });
  });

  it("checks a field value by AX identifier and withholds its transformed secret in failure reports", async () => {
    const { env } = setup([
      { identifier: "profile-name", traits: ["textEntry"], value: "Ada", frame },
    ]);
    noteTypedSecrets(device.id, [{ name: "NAME", value: "ada" }]);
    expect(
      await replay(env, "assert: { text: { in: { ax: { id: profile-name } }, equals: Ada } }")
    ).toEqual({ ok: true });
    const miss = await replay(
      env,
      "assert: { text: { in: { ax: { id: profile-name } }, equals: Other } }"
    );
    expect(miss.reason).toContain(WITHHELD_INPUT_TEXT);
    expect(miss.reason).not.toContain("Ada");
  });

  it("refuses to confirm hidden on an empty AX read without consulting the app", async () => {
    const { env, resolveService } = setup([]);
    expect(
      await replay(env, "await: { hidden: { ax: { text: Allow } }, timeout: 10 }")
    ).toMatchObject({
      ok: false,
      indeterminate: true,
      reason: expect.stringContaining("accessibility service returned no elements"),
    });
    expect(resolveService.mock.calls.every(([urn]) => urn === axServiceRef(device).urn)).toBe(true);
  });

  it("refuses an AX selector on a physical iPhone before reading its tree", async () => {
    const { env, resolveService } = setup([]);
    const result = await replay(
      { ...env, device: { ...device, kind: "device" } },
      "await: { hidden: { ax: Save } }"
    );
    expect(result).toMatchObject({
      ok: false,
      indeterminate: true,
      reason: expect.stringContaining("iOS simulator"),
    });
    expect(resolveService).not.toHaveBeenCalled();
  });

  it.each([
    "{ ax: { text: Allow }, id: another }",
    "{ ax: { x: 0.5, y: 0.5 } }",
    "{ text: Allow, within: { ax: Prompt } }",
  ])("rejects an ambiguous or misplaced wrapper %s", (selector) => {
    expect(() => parseFlow(`steps:\n  - tap: ${selector}`)).toThrow();
  });
});
