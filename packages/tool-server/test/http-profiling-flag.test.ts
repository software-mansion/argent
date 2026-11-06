import { describe, it, expect, vi } from "vitest";
import supertest from "supertest";
import { createHttpApp } from "../src/http";
import type { Registry } from "@argent/registry";
import { trackProfilingRun } from "../src/utils/profiling-devices";

vi.mock("../src/utils/update-checker", () => ({
  getUpdateState: vi.fn(() => ({ updateAvailable: false, currentVersion: "1.0.0" })),
  isUpdateNoteSuppressed: vi.fn(() => false),
  suppressUpdateNote: vi.fn(),
}));

describe("HTTP profiling flag", () => {
  it("is set on calls to the device a profiler records on, and only there", async () => {
    const def = {
      id: "test-tool",
      description: "A stub tool",
      inputSchema: { type: "object", properties: {} },
      services: () => ({}),
      execute: async () => ({ tapped: true }),
    };
    const registry = {
      getSnapshot: vi.fn(() => ({ services: new Map(), namespaces: [], tools: ["test-tool"] })),
      getTool: vi.fn((name: string) => (name === "test-tool" ? def : undefined)),
      invokeTool: vi.fn(async () => ({ tapped: true })),
    } as unknown as Registry;
    const handle = createHttpApp(registry);
    const call = (udid: string) => supertest(handle.app).post("/tools/test-tool").send({ udid });

    trackProfilingRun("emulator-5554", { profilingActive: true });
    expect((await call("emulator-5554")).body).toEqual({ data: { tapped: true }, profiling: true });
    expect((await call("emulator-5556")).body).toEqual({ data: { tapped: true } });
    handle.dispose();
  });
});
