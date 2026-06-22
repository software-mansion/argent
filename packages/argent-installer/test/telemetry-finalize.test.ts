import { describe, expect, it, vi, beforeEach } from "vitest";
import { finalizeTelemetry } from "../src/telemetry-finalize.js";

const telemetryMock = vi.hoisted(() => ({
  shutdown: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@argent/telemetry", () => telemetryMock);

describe("finalizeTelemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("captures the final event and drains telemetry", async () => {
    const capture = vi.fn();

    await finalizeTelemetry(capture);

    expect(capture).toHaveBeenCalledOnce();
    expect(telemetryMock.shutdown).toHaveBeenCalledOnce();
  });

  it("still drains when final capture throws", async () => {
    const capture = vi.fn(() => {
      throw new Error("capture failed");
    });

    await expect(finalizeTelemetry(capture)).resolves.toBeUndefined();

    expect(telemetryMock.shutdown).toHaveBeenCalledOnce();
  });

  it("swallows shutdown failures", async () => {
    telemetryMock.shutdown.mockRejectedValueOnce(new Error("network timeout"));

    await expect(finalizeTelemetry(vi.fn())).resolves.toBeUndefined();
  });
});
