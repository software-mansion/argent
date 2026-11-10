import { describe, expect, it, vi } from "vitest";
import { FAILURE_CODES, Registry, getFailureSignal } from "@argent/registry";
import { createAudioInputTool } from "../src/tools/audio/audio-input";
import { createAudioRecordStartTool } from "../src/tools/audio/audio-record-start";
import { createAudioRecordStopTool } from "../src/tools/audio/audio-record-stop";

const TVOS = "0000AAAA-0000-0000-0000-00000000A77E";

vi.mock("../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-devices")>()),
  isTvOsSimulator: async (udid: string) => udid === TVOS,
}));

function registryRig() {
  const registry = new Registry();
  registry.registerTool(createAudioInputTool(registry));
  registry.registerTool(createAudioRecordStartTool(registry));
  registry.registerTool(createAudioRecordStopTool(registry));
  // A refused target must fail before any service (native devtools, the audio session) starts.
  const resolveService = vi
    .spyOn(registry, "resolveService")
    .mockRejectedValue(new Error("Unexpected service resolution"));
  return { registry, resolveService };
}

const calls = [
  ["audio-input", { source: "tone" }],
  ["audio-record-start", { bundleId: "com.example.app" }],
  ["audio-record-stop", { bundleId: "com.example.app" }],
] as const;

const targets = [
  ["an Android emulator", "emulator-5554", FAILURE_CODES.TOOL_CAPABILITY_UNSUPPORTED_OPERATION],
  ["a Chromium app", "chromium-cdp-9222", FAILURE_CODES.TOOL_CAPABILITY_UNSUPPORTED_OPERATION],
  [
    "a physical iPhone",
    "00008110-000978540290401E",
    FAILURE_CODES.TOOL_CAPABILITY_UNSUPPORTED_OPERATION,
  ],
  ["a tvOS simulator", TVOS, FAILURE_CODES.AUDIO_WRONG_PLATFORM],
  [
    "a remote: simulator",
    "remote:0000BBBB-0000-0000-0000-000000000000",
    FAILURE_CODES.AUDIO_WRONG_PLATFORM,
  ],
] as const;

describe("audio tools refuse targets without the hook before resolving any service", () => {
  for (const [toolId, args] of calls) {
    it.each(targets)(`${toolId} on %s`, async (_, udid, code) => {
      const { registry, resolveService } = registryRig();
      const err = await registry.invokeTool(toolId, { udid, ...args }).catch((e: unknown) => e);
      expect(getFailureSignal(err)?.error_code).toBe(code);
      expect(resolveService).not.toHaveBeenCalled();
    });
  }

  it("says why a remote: simulator is refused", async () => {
    const { registry } = registryRig();
    const err = await registry
      .invokeTool("audio-input", {
        udid: "remote:0000BBBB-0000-0000-0000-000000000000",
        source: "tone",
      })
      .catch((e: unknown) => e);
    expect((err as Error).message).toContain("same Mac as the tool-server");
  });
});

describe("audio-input params", () => {
  it("rejects source=file without a path before resolving services", async () => {
    const { registry, resolveService } = registryRig();
    await expect(
      registry.invokeTool("audio-input", {
        udid: "0000CCCC-0000-0000-0000-000000000000",
        source: "file",
      })
    ).rejects.toThrow(/source=file requires `path`/);
    expect(resolveService).not.toHaveBeenCalled();
  });

  it("keeps the rule out of the advertised schema's top level", () => {
    const { registry } = registryRig();
    const schema = registry.getTool("audio-input")!.inputSchema!;
    expect(schema).not.toHaveProperty("anyOf");
    expect(schema).not.toHaveProperty("oneOf");
    expect(schema.required).toEqual(["udid", "source"]);
  });
});
