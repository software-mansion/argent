import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import {
  _resetConsentCacheForTest,
  getConsentState,
  markDisabled,
  markEnabled,
  forget,
  init,
  isEnabled,
  status,
  shutdown,
  track,
} from "../src/index.js";
import { resetClient } from "../src/posthog.js";
import { scopeHome, snapshotEnv } from "./helpers.js";
import { configFilePath } from "../src/paths.js";

const posthogMock = vi.hoisted(() => ({
  instances: [] as Array<{
    capture: ReturnType<typeof vi.fn>;
    flush: ReturnType<typeof vi.fn>;
    shutdown: ReturnType<typeof vi.fn>;
    opts: unknown;
  }>,
  flushImpl: () => Promise.resolve(),
}));

vi.mock("posthog-node", () => {
  return {
    PostHog: vi.fn().mockImplementation(function (_key: string, opts: unknown) {
      const instance = {
        capture: vi.fn(),
        flush: vi.fn(() => posthogMock.flushImpl()),
        shutdown: vi.fn().mockResolvedValue(undefined),
        opts,
      };
      posthogMock.instances.push(instance);
      return instance;
    }),
  };
});

describe("telemetry public surface", () => {
  scopeHome();

  beforeEach(() => {
    posthogMock.instances.length = 0;
    posthogMock.flushImpl = () => Promise.resolve();
    resetClient();
    (globalThis as Record<string, unknown>).__ARGENT_POSTHOG_KEY_TEST = "phc_real";
    init("tool_server");
    markEnabled();
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__ARGENT_POSTHOG_KEY_TEST;
    resetClient();
    vi.restoreAllMocks();
  });

  it("markDisabled queues opt-out, persists disabled state, and drains prior events", async () => {
    track("toolserver:start", {});
    const client = posthogMock.instances[0]!;

    client.shutdown.mockImplementation(async () => {
      expect(isEnabled()).toBe(false);
    });

    await markDisabled();

    expect(posthogMock.instances).toHaveLength(1);
    expect(client.capture).toHaveBeenCalledWith(
      expect.objectContaining({ event: "toolserver:start" })
    );
    expect(client.capture).toHaveBeenCalledWith(
      expect.objectContaining({ event: "telemetry:opt_out" })
    );
    expect(client.flush).not.toHaveBeenCalled();
    expect(client.shutdown).toHaveBeenCalledTimes(1);
    expect(isEnabled()).toBe(false);
  });

  it("does not provision the anon-id file when the PostHog key is unusable", () => {
    // An intentionally-disabled/empty key means nothing can ever transmit, so
    // track() must not write a persistent identifier to the user's disk.
    (globalThis as Record<string, unknown>).__ARGENT_POSTHOG_KEY_TEST = "";
    resetClient();

    track("toolserver:start", {});

    expect(posthogMock.instances).toHaveLength(0);
    expect(status().hasAnonIdOnDisk).toBe(false);
  });

  it("track queues without flushing so command shutdown drains later", async () => {
    track("toolserver:start", {});
    track("toolserver:stop", {
      reason: "signal",
      uptime_ms: 1,
      total_tool_calls: 0,
    });

    const client = posthogMock.instances[0]!;

    expect(posthogMock.instances).toHaveLength(1);
    expect(client.capture).toHaveBeenCalledTimes(2);
    expect(client.capture).toHaveBeenCalledWith(
      expect.objectContaining({ event: "toolserver:stop" })
    );
    expect(client.flush).not.toHaveBeenCalled();
    expect(client.shutdown).not.toHaveBeenCalled();
    expect(client.opts).toEqual(expect.objectContaining({ flushAt: 20, flushInterval: 10_000 }));
  });

  it("captures events in CI and annotates payloads with is_ci", () => {
    const restore = snapshotEnv(["CI"]);
    try {
      process.env.CI = "1";

      track("toolserver:start", {});

      const client = posthogMock.instances[0]!;
      expect(client.capture).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "toolserver:start",
          properties: expect.objectContaining({ is_ci: true }),
        })
      );
    } finally {
      restore();
    }
  });

  it("shutdown drains the constructed client", async () => {
    track("toolserver:start", {});
    track("toolserver:stop", {
      reason: "signal",
      uptime_ms: 1,
      total_tool_calls: 0,
    });

    const client = posthogMock.instances[0]!;

    await shutdown();

    expect(posthogMock.instances).toHaveLength(1);
    expect(client.shutdown).toHaveBeenCalledTimes(1);
  });

  it("forget does not send delete-person and performs local cleanup by default", async () => {
    track("toolserver:start", {});
    expect(status().hasAnonIdOnDisk).toBe(true);

    const result = await forget();
    const client = posthogMock.instances[0]!;

    expect(posthogMock.instances).toHaveLength(1);
    expect(client.capture).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "$delete_person" })
    );
    expect(client.flush).not.toHaveBeenCalled();
    expect(client.shutdown).not.toHaveBeenCalled();
    expect(result.localIdRemoved).toBe(true);
    expect(result.consentDisabled).toBe(true);
    expect(status().hasAnonIdOnDisk).toBe(false);
    expect(isEnabled()).toBe(false);
  });

  it("forget can erase telemetry identity without creating consent config", async () => {
    fs.unlinkSync(configFilePath());
    _resetConsentCacheForTest();
    track("toolserver:start", {});

    const result = await forget({ disableConsent: false });

    const client = posthogMock.instances[0]!;
    expect(client.capture).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "$delete_person" })
    );
    expect(result.localIdRemoved).toBe(true);
    expect(result.consentDisabled).toBe(false);
    expect(status().hasAnonIdOnDisk).toBe(false);
    expect(fs.existsSync(configFilePath())).toBe(false);
    expect(isEnabled()).toBe(true);
  });

  it("forget without consent changes preserves an explicit opt-out", async () => {
    fs.writeFileSync(configFilePath(), JSON.stringify({ telemetry: { enabled: false } }) + "\n");
    _resetConsentCacheForTest();

    const result = await forget({ disableConsent: false });

    expect(result.consentDisabled).toBe(false);
    expect(getConsentState({}).enabled).toBe(false);
    expect(getConsentState({}).source.source).toBe("config_file");
  });

  it("forget without consent changes preserves an explicit opt-in", async () => {
    markEnabled();

    const result = await forget({ disableConsent: false });

    expect(result.consentDisabled).toBe(false);
    expect(getConsentState({}).enabled).toBe(true);
    expect(getConsentState({}).source.source).toBe("config_file");
  });

  it("forget without consent changes still removes the local telemetry id", async () => {
    track("toolserver:start", {});
    expect(status().hasAnonIdOnDisk).toBe(true);

    const result = await forget({ disableConsent: false });

    expect(result.localIdRemoved).toBe(true);
    expect(status().hasAnonIdOnDisk).toBe(false);
  });
});
