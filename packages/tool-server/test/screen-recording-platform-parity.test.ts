import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/tools/screen-recording/capture", () => ({
  startCapture: vi.fn(async () => ({
    status: "recording",
    timeLimitSeconds: 180,
    outputFile: "/tmp/argent-screen-recording-test.mp4",
  })),
}));

vi.mock("../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-devices")>()),
  isTvOsSimulator: vi.fn(async () => false),
}));

import type { Registry } from "@argent/registry";
import { createScreenRecordingStartTool } from "../src/tools/screen-recording/screen-recording-start";
import { startCapture } from "../src/tools/screen-recording/capture";

const STREAM_URL = "http://127.0.0.1:65000/stream.mjpeg";

function makeTool(simulator: object = {}) {
  const registry = {
    resolveService: vi.fn(async () => ({ streamUrl: STREAM_URL, ...simulator })),
  } as unknown as Registry;
  return createScreenRecordingStartTool(registry);
}

const services = { session: {} } as never;

const RECORDABLE = [
  { what: "an iOS simulator", udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA" },
  { what: "an Android emulator", udid: "emulator-5554" },
  { what: "a physical Android device", udid: "39121FDJH003AB" },
];

describe("screen-recording start — platform parity", () => {
  beforeEach(() => {
    vi.mocked(startCapture).mockClear();
  });

  it.each(RECORDABLE)("offers $what simulator-server's own recorder", async ({ udid }) => {
    await makeTool().execute(services, { udid });

    expect(startCapture).toHaveBeenCalledTimes(1);
    const params = vi.mocked(startCapture).mock.calls[0][1];
    expect(params.server).toBeDefined();
    expect(typeof params.server?.start).toBe("function");
  });

  it("gives every platform the same stream url and touch control", async () => {
    const seen = [];
    for (const { udid } of RECORDABLE) {
      vi.mocked(startCapture).mockClear();
      await makeTool().execute(services, { udid });
      const params = vi.mocked(startCapture).mock.calls[0][1];
      seen.push({ streamUrl: params.streamUrl, pointer: typeof params.pointer });
    }
    expect(seen).toEqual(RECORDABLE.map(() => ({ streamUrl: STREAM_URL, pointer: "object" })));
  });

  it("records a provider's device host-side", async () => {
    await makeTool({ external: true, apiUrl: "http://127.0.0.1:65001" }).execute(services, {
      udid: RECORDABLE[0].udid,
    });

    expect(vi.mocked(startCapture).mock.calls[0][1].server).toBeUndefined();
  });
});
