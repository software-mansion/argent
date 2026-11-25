import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { materializeArtifacts } from "@argent/tools-client";
import { run } from "../src/run.js";
import { applyDeviceFromEnv } from "../src/run-device-env.js";

const toolsClientMock = vi.hoisted(() => ({
  fetchTool: vi.fn(),
  callTool: vi.fn(),
  baseUrl: vi.fn(async () => ({ url: "http://127.0.0.1:3001", token: "t" })),
}));

vi.mock("@argent/tools-client", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createToolsClient: vi.fn(() => toolsClientMock),
    materializeArtifacts: vi.fn(async (result: unknown) => ({ result, images: [] })),
  };
});

vi.mock("@argent/telemetry", () => ({
  init: vi.fn(),
  shutdown: vi.fn(async () => undefined),
  track: vi.fn(),
}));

const gestureTap = {
  name: "gesture-tap",
  inputSchema: {
    type: "object",
    properties: {
      udid: { type: "string" },
      x: { type: "number" },
      y: { type: "number" },
    },
    required: ["udid", "x", "y"],
  },
};

const debuggerStatus = {
  name: "debugger-status",
  inputSchema: {
    type: "object",
    properties: { port: { type: "number" }, device_id: { type: "string" } },
    required: ["device_id"],
  },
};

const bootDevice = {
  name: "boot-device",
  inputSchema: {
    type: "object",
    properties: { udid: { type: "string" }, avdName: { type: "string" } },
  },
};

const listDevices = {
  name: "list-devices",
  inputSchema: { type: "object", properties: {} },
};

const invoke = (argv: string[]) => run(argv, { paths: {} as never });

function stderr(): string {
  return (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map((c) => String(c[0]))
    .join("\n");
}

describe("ARGENT_UDID in argent run", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("ARGENT_UDID", "ENV-DEVICE");
    toolsClientMock.callTool.mockResolvedValue({ data: { ok: true } });
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("fills --udid when the call leaves it out", async () => {
    toolsClientMock.fetchTool.mockResolvedValue(gestureTap);
    await invoke(["gesture-tap", "--x", "0.5", "--y", "0.5"]);
    expect(toolsClientMock.callTool).toHaveBeenCalledWith("gesture-tap", {
      udid: "ENV-DEVICE",
      x: 0.5,
      y: 0.5,
    });
    expect(materializeArtifacts).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ deviceId: "ENV-DEVICE" })
    );
  });

  it("fills --device_id for tools that name the device that way", async () => {
    toolsClientMock.fetchTool.mockResolvedValue(debuggerStatus);
    await invoke(["debugger-status"]);
    expect(toolsClientMock.callTool).toHaveBeenCalledWith("debugger-status", {
      device_id: "ENV-DEVICE",
    });
  });

  it("lets an explicit --udid win", async () => {
    toolsClientMock.fetchTool.mockResolvedValue(gestureTap);
    await invoke(["gesture-tap", "--udid", "FLAG-DEVICE", "--x", "0.5", "--y", "0.5"]);
    expect(toolsClientMock.callTool).toHaveBeenCalledWith(
      "gesture-tap",
      expect.objectContaining({ udid: "FLAG-DEVICE" })
    );
  });

  it("lets an explicit --udid-json win", async () => {
    toolsClientMock.fetchTool.mockResolvedValue(gestureTap);
    await invoke(["gesture-tap", "--udid-json", '"JSON-DEVICE"', "--x", "0.5", "--y", "0.5"]);
    expect(toolsClientMock.callTool).toHaveBeenCalledWith(
      "gesture-tap",
      expect.objectContaining({ udid: "JSON-DEVICE" })
    );
  });

  it("lets a udid inside --args win", async () => {
    toolsClientMock.fetchTool.mockResolvedValue(gestureTap);
    await invoke(["gesture-tap", "--args", '{"udid":"ARGS-DEVICE","x":0.5,"y":0.5}']);
    expect(toolsClientMock.callTool).toHaveBeenCalledWith(
      "gesture-tap",
      expect.objectContaining({ udid: "ARGS-DEVICE" })
    );
  });

  it("leaves tools without a device field alone", async () => {
    toolsClientMock.fetchTool.mockResolvedValue(listDevices);
    await invoke(["list-devices"]);
    expect(toolsClientMock.callTool).toHaveBeenCalledWith("list-devices", {});
  });

  it("leaves an optional device field alone", async () => {
    toolsClientMock.fetchTool.mockResolvedValue(bootDevice);
    await invoke(["boot-device", "--avdName", "Pixel"]);
    expect(toolsClientMock.callTool).toHaveBeenCalledWith("boot-device", { avdName: "Pixel" });
  });

  it("keeps the missing-flag error when the variable is empty", async () => {
    vi.stubEnv("ARGENT_UDID", "  ");
    toolsClientMock.fetchTool.mockResolvedValue(gestureTap);
    await expect(invoke(["gesture-tap", "--x", "0.5", "--y", "0.5"])).rejects.toThrow(
      "process.exit:2"
    );
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    expect(stderr()).toContain("Error: missing required flag --udid");
  });
});

describe("applyDeviceFromEnv", () => {
  it("does nothing when the variable is unset", () => {
    const payload = {};
    applyDeviceFromEnv(payload, gestureTap.inputSchema, {});
    expect(payload).toEqual({});
  });

  it("trims the value", () => {
    const payload: Record<string, unknown> = {};
    applyDeviceFromEnv(payload, gestureTap.inputSchema, { ARGENT_UDID: " emulator-5554\n" });
    expect(payload).toEqual({ udid: "emulator-5554" });
  });

  it("skips a retired device field", () => {
    const payload: Record<string, unknown> = {};
    const schema = {
      type: "object",
      properties: { udid: { not: {}, description: "Retired: use --device" } },
      required: ["udid"],
    };
    applyDeviceFromEnv(payload, schema, { ARGENT_UDID: "X" });
    expect(payload).toEqual({});
  });
});
