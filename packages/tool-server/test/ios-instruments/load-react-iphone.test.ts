import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/utils/react-profiler/debug/dump", () => ({
  getDebugDir: vi.fn(async () => "/nonexistent-debug-dir"),
  readCommitTree: vi.fn(),
}));

import { profilerLoadTool } from "../../src/tools/profiler/query/profiler-load";
import { UnsupportedOperationError } from "../../src/utils/capability";

describe("profiler-load load_react on a physical iPhone", () => {
  it("refuses, since no React query tool runs on an iPhone", async () => {
    const error = await profilerLoadTool
      .execute({}, {
        mode: "load_react",
        session_id: "20261120-120000",
        device_id: "00008110-000978540290401E",
      } as never)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsupportedOperationError);
    expect((error as Error).message).toBe(
      "Tool 'profiler-load' is not supported on ios device (load_react mode). Use a simulator, or see the argent-ios-device-interact skill."
    );
  });
});
