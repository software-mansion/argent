import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nativeProfilerSessionBlueprint,
  type NativeProfilerSessionApi,
} from "../../src/blueprints/native-profiler-session";

vi.mock("../../src/utils/react-profiler/debug/dump", () => ({
  getDebugDir: vi.fn(),
  readCommitTree: vi.fn(),
}));

import { getDebugDir } from "../../src/utils/react-profiler/debug/dump";
import { profilerLoadTool } from "../../src/tools/profiler/query/profiler-load";

const mockedGetDebugDir = vi.mocked(getDebugDir);
const SESSION_ID = "20260101-000000";

async function buildAndroidSession(): Promise<NativeProfilerSessionApi> {
  const device = { id: "emulator-5554", platform: "android" as const, kind: "emulator" as const };
  const instance = await nativeProfilerSessionBlueprint.factory({}, device, { device });
  return instance.api;
}

describe("profiler-load Android load_native restore", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "argent-profiler-load-"));
    mockedGetDebugDir.mockResolvedValue(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function writeTrace(): Promise<string> {
    const pftrace = join(tempDir, `native-profiler-${SESSION_ID}.pftrace`);
    await writeFile(pftrace, "", "utf8");
    return pftrace;
  }

  it("restores appProcess from the Android metadata sidecar", async () => {
    const api = await buildAndroidSession();
    const pftrace = await writeTrace();
    await writeFile(
      `${pftrace}.metadata.json`,
      JSON.stringify({
        platform: "android",
        appProcess: "com.example.app",
        wallClockStartMs: 1710000000000,
      }),
      "utf8"
    );

    const result = await profilerLoadTool.execute({ session: api } as never, {
      mode: "load_native",
      session_id: SESSION_ID,
      port: 8081,
      device_id: "emulator-5554",
    });

    expect(result).toContain("com.example.app");
    expect(api.traceFile).toBe(pftrace);
    expect(api.exportedFiles).toEqual({ pftrace });
    expect(api.appProcess).toBe("com.example.app");
    expect(api.wallClockStartMs).toBe(1710000000000);
    expect(api.parsedData).toBeNull();
  });

  it("loads an old Android trace when app_process is supplied", async () => {
    const api = await buildAndroidSession();
    const pftrace = await writeTrace();

    await profilerLoadTool.execute({ session: api } as never, {
      mode: "load_native",
      session_id: SESSION_ID,
      port: 8081,
      device_id: "emulator-5554",
      app_process: "com.legacy.app",
    });

    expect(api.traceFile).toBe(pftrace);
    expect(api.exportedFiles).toEqual({ pftrace });
    expect(api.appProcess).toBe("com.legacy.app");
    expect(api.wallClockStartMs).toBeNull();
  });

  it("fails with an actionable error for old Android traces without app_process", async () => {
    const api = await buildAndroidSession();
    await writeTrace();

    await expect(
      profilerLoadTool.execute({ session: api } as never, {
        mode: "load_native",
        session_id: SESSION_ID,
        port: 8081,
        device_id: "emulator-5554",
      })
    ).rejects.toThrow(/Retry profiler-load with app_process set to the Android package name/);
  });
});
