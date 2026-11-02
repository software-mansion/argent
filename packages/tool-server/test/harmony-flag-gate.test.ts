import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { z } from "zod";
import { FAILURE_CODES, Registry, getFailureSignal } from "@argent/registry";

vi.mock("@argent/configuration-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@argent/configuration-core")>()),
  isFlagEnabled: vi.fn(),
}));
vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  listAndroidDevices: vi.fn(async () => []),
  listAvds: vi.fn(async () => []),
}));
vi.mock("../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-devices")>()),
  listIosSimulators: vi.fn(async () => []),
}));
vi.mock("../src/utils/sim-remote", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/sim-remote")>()),
  simctlListDevices: vi.fn(async () => ({ devices: {} })),
}));
vi.mock("../src/utils/chromium-discovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/chromium-discovery")>()),
  discoverChromiumDevices: vi.fn(async () => []),
}));
vi.mock("../src/utils/vega-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/vega-devices")>()),
  listVegaDevices: vi.fn(async () => []),
}));
vi.mock("../src/utils/harmony-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-devices")>()),
  listHarmonyInstances: vi.fn(async () => [
    { name: "Phone_1", running: false, deviceType: "phone", osVersion: "HarmonyOS 6.1.1(24)" },
  ]),
  listHarmonyHdcTargets: vi.fn(async () => [
    { connectKey: "127.0.0.1:5555", state: "Connected", connection: "TCP" },
  ]),
}));
vi.mock("../src/utils/harmony-uitest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-uitest")>()),
  harmonyDisplay: vi.fn(async () => ({ width: 1320, height: 2856, screenOn: true })),
  harmonyDumpLayout: vi.fn(async () => ({ attributes: { bounds: "[0,0][1320,2856]" } })),
}));

import { isFlagEnabled } from "@argent/configuration-core";
import { listHarmonyInstances, listHarmonyHdcTargets } from "../src/utils/harmony-devices";
import { listDevicesTool } from "../src/tools/devices/list-devices";
import { createBootDeviceTool } from "../src/tools/devices/boot-device";
import { gestureTapTool } from "../src/tools/gesture-tap";
import { harmonyDisplay } from "../src/utils/harmony-uitest";
import { createHttpApp } from "../src/http";
import { createRegistry } from "../src/utils/setup-registry";
import { FLAG_META_KEY, renderFlagGated } from "../src/utils/flag-gated-text";
import { __primeDepCacheForTests } from "../src/utils/check-deps";

const flags = new Set<string>();
vi.mocked(isFlagEnabled).mockImplementation((name: string) => flags.has(name));

const HARMONY_ID = "harmony-127.0.0.1:5555";

beforeEach(() => {
  flags.clear();
  vi.mocked(listHarmonyInstances).mockClear();
  vi.mocked(listHarmonyHdcTargets).mockClear();
  vi.mocked(harmonyDisplay).mockClear();
  __primeDepCacheForTests(["hdc", "harmony-emulator"]);
});

describe("the harmonyos flag", () => {
  it("keeps list-devices from probing hdc or DevEco while off, and lists both once on", async () => {
    const off = await listDevicesTool.execute!({}, {});
    expect(off.devices.filter((d) => d.platform === "harmony")).toEqual([]);
    expect(listHarmonyInstances).not.toHaveBeenCalled();
    expect(listHarmonyHdcTargets).not.toHaveBeenCalled();

    flags.add("harmonyos");
    const on = await listDevicesTool.execute!({}, {});
    expect(on.devices.filter((d) => d.platform === "harmony").map((d) => d.udid)).toEqual([
      HARMONY_ID,
      "harmony-emulator-Phone_1",
    ]);
  });

  it("refuses a harmony id at the HTTP capability gate while off, per request", async () => {
    const { app } = createHttpApp(createRegistry());

    const off = await request(app).post("/tools/describe").send({ udid: HARMONY_ID });
    expect(off.status).toBe(400);
    // The capability gate answers before any HarmonyOS dependency check could.
    expect(off.body.error).toMatch(
      /^Tool 'describe' is not supported on harmony device \(HarmonyOS support is off; turn it on with `argent enable harmonyos`\)/
    );

    flags.add("harmonyos");
    const on = await request(app).post("/tools/describe").send({ udid: HARMONY_ID });
    expect(on.status).toBe(200);
    expect(on.body.data.source).toBe("harmony-uitest");
  });

  it("refuses a harmony id off the HTTP path too, before anything reaches hdc", async () => {
    // An e2e step invokes through the registry, past the HTTP gate.
    const err = await gestureTapTool
      .execute({}, { udid: HARMONY_ID, x: 0.5, y: 0.5 })
      .catch((e: unknown) => e);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.HARMONY_DISABLED);
    expect(harmonyDisplay).not.toHaveBeenCalled();
  });

  it("refuses a boot by harmonyInstance, which carries no udid for the HTTP gate", async () => {
    const boot = createBootDeviceTool(new Registry());
    const err = await boot
      .execute({}, { harmonyInstance: "Phone_1" } as never)
      .catch((e: unknown) => e);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.HARMONY_DISABLED);
    expect(listHarmonyInstances).not.toHaveBeenCalled();
  });
});

describe("flag-gated tool text", () => {
  const gatedTool = {
    id: "gated-text",
    description: "Tap on iOS<flag:harmonyos> or HarmonyOS</flag:harmonyos>.",
    zodSchema: z.object({
      udid: z.string().describe("iOS UDID<flag:harmonyos> or HarmonyOS id</flag:harmonyos>"),
      instance: z
        .string()
        .describe("HarmonyOS instance")
        .meta({ [FLAG_META_KEY]: "harmonyos" }),
    }),
    services: () => ({}),
    async execute() {
      return {};
    },
  };

  it("renders spans and drops gated properties per request in GET /tools", async () => {
    const registry = new Registry();
    registry.registerTool(gatedTool);
    const { app } = createHttpApp(registry);
    const listed = async () =>
      (await request(app).get("/tools")).body.tools.find(
        (t: { name: string }) => t.name === "gated-text"
      );

    const off = await listed();
    expect(off.description).toBe("Tap on iOS.");
    expect(off.inputSchema.properties).toEqual({
      udid: { type: "string", description: "iOS UDID" },
    });
    expect(off.inputSchema.required).toEqual(["udid"]);

    flags.add("harmonyos");
    const on = await listed();
    expect(on.description).toBe("Tap on iOS or HarmonyOS.");
    expect(on.inputSchema.properties).toEqual({
      udid: { type: "string", description: "iOS UDID or HarmonyOS id" },
      instance: { type: "string", description: "HarmonyOS instance" },
    });
    expect(on.inputSchema.required).toEqual(["udid", "instance"]);
  });

  it("leaves a span of another flag to that flag", () => {
    const text = "a<flag:harmonyos>b</flag:harmonyos><flag:other>c</flag:other>";
    expect(renderFlagGated(text, (flag) => flag === "other")).toBe("ac");
  });
});
