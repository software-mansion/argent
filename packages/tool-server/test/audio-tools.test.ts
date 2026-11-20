import { describe, expect, it, vi } from "vitest";
import { FAILURE_CODES, Registry, getFailureSignal } from "@argent/registry";
import { createAudioInputTool } from "../src/tools/audio/audio-input";

const TVOS = "0000AAAA-0000-0000-0000-00000000A77E";
const BOOTED = "0000CCCC-0000-0000-0000-000000000000";
const SHUTDOWN = "0000DDDD-0000-0000-0000-000000000000";
const BOOTING = "0000EEEE-0000-0000-0000-000000000000";
const UNKNOWN = "0000FFFF-0000-0000-0000-000000000000";

// The simctl listing: a shut-down tvOS simulator, and iOS simulators in each state. UNKNOWN is in none.
const SIMULATORS: Record<string, { state: string; runtimeKind: "mobile" | "tv" }> = {
  [TVOS]: { state: "Shutdown", runtimeKind: "tv" },
  [BOOTED]: { state: "Booted", runtimeKind: "mobile" },
  [SHUTDOWN]: { state: "Shutdown", runtimeKind: "mobile" },
  [BOOTING]: { state: "Booting", runtimeKind: "mobile" },
};

vi.mock("../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-devices")>()),
  findIosSimulator: async (udid: string) =>
    SIMULATORS[udid] && { udid, name: "Test Phone", runtime: "test", ...SIMULATORS[udid] },
}));

function registryRig() {
  const registry = new Registry();
  registry.registerTool(createAudioInputTool(registry));
  // A refused target must fail before any service (native devtools, the audio session) starts.
  const resolveService = vi
    .spyOn(registry, "resolveService")
    .mockRejectedValue(new Error("Unexpected service resolution"));
  return { registry, resolveService };
}

const calls = [["audio-input", { source: "tone" }]] as const;

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
  ["a shut-down simulator", SHUTDOWN, FAILURE_CODES.AUDIO_SIMULATOR_NOT_BOOTED],
  ["a simulator that is still booting", BOOTING, FAILURE_CODES.AUDIO_SIMULATOR_NOT_BOOTED],
  ["an unknown UDID", UNKNOWN, FAILURE_CODES.AUDIO_SIMULATOR_NOT_BOOTED],
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

  it("tells a shut-down simulator to be booted first", async () => {
    const { registry } = registryRig();
    const err = await registry
      .invokeTool("audio-input", { udid: SHUTDOWN, source: "tone" })
      .catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/is not booted \(state: Shutdown\).*boot-device/);
    expect(getFailureSignal(err)?.error_kind).toBe("validation");
  });

  it("says an unknown UDID was not found, without telling to boot it", async () => {
    const { registry } = registryRig();
    const err = await registry
      .invokeTool("audio-input", { udid: UNKNOWN, source: "tone" })
      .catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/No iOS simulator with UDID .* was found.*list-devices/);
    expect((err as Error).message).not.toContain("boot-device");
    expect(getFailureSignal(err)?.error_kind).toBe("not_found");
  });

  it("lets a booted simulator through to the native-devtools service", async () => {
    const { registry, resolveService } = registryRig();
    const err = await registry
      .invokeTool("audio-input", { udid: BOOTED, source: "tone" })
      .catch((e: unknown) => e);
    expect((err as Error).message).toContain("Unexpected service resolution");
    expect(resolveService).toHaveBeenCalledTimes(1);
  });
});

describe("audio-input params", () => {
  it("rejects source=file without a path before resolving services", async () => {
    const { registry, resolveService } = registryRig();
    await expect(
      registry.invokeTool("audio-input", {
        udid: BOOTED,
        source: "file",
      })
    ).rejects.toThrow(/source=file requires `path`/);
    expect(resolveService).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5])("rejects plays=%s before resolving services", async (plays) => {
    const { registry, resolveService } = registryRig();
    await expect(
      registry.invokeTool("audio-input", {
        udid: BOOTED,
        source: "file",
        path: "/tmp/clip.wav",
        plays,
      })
    ).rejects.toThrow(/`plays`: (Too small|Must be a whole number)/);
    expect(resolveService).not.toHaveBeenCalled();
  });

  it("accepts any whole plays count, past 2^53 too, and advertises an integer with no ceiling", () => {
    const { registry } = registryRig();
    const tool = registry.getTool("audio-input")!;
    for (const plays of [1, 3, 2 ** 53 + 2, JSON.parse("3291419284712089740912384") as number]) {
      expect(
        tool.zodSchema!.safeParse({ udid: "x", source: "file", path: "/a.wav", plays }).success
      ).toBe(true);
    }
    const plays = (tool.inputSchema!.properties as Record<string, Record<string, unknown>>).plays;
    expect(plays).toMatchObject({ type: "integer", minimum: 1 });
    expect(plays).not.toHaveProperty("maximum");
  });

  it("keeps the rule out of the advertised schema's top level", () => {
    const { registry } = registryRig();
    const schema = registry.getTool("audio-input")!.inputSchema!;
    expect(schema).not.toHaveProperty("anyOf");
    expect(schema).not.toHaveProperty("oneOf");
    expect(schema.required).toEqual(["udid", "source"]);
  });
});
