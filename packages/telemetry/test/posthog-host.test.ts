import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POSTHOG_HOST, resetClient, resolveConfig, getClient } from "../src/posthog.js";

vi.mock("posthog-node", () => {
  return {
    PostHog: vi.fn().mockImplementation(function (
      this: { opts: unknown },
      _key: string,
      opts: unknown
    ) {
      this.opts = opts;
    }),
  };
});

describe("posthog host invariance", () => {
  beforeEach(() => {
    resetClient();
    (globalThis as Record<string, unknown>).__ARGENT_POSTHOG_KEY_TEST = "phc_real";
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__ARGENT_POSTHOG_KEY_TEST;
    resetClient();
  });

  it("POSTHOG_HOST is the hard-coded EU URL", () => {
    expect(POSTHOG_HOST).toBe("https://eu.i.posthog.com");
  });

  it.each([
    ["POSTHOG_HOST", "https://attacker.example/collect"],
    ["POSTHOG_API_HOST", "https://us.i.posthog.com"],
    ["POSTHOG_INGESTION_HOST", "https://attacker.example"],
    ["POSTHOG_PERSONAL_API_KEY", "phx_steal_me"],
  ])("ignores env var %s=%s", async (envName, value) => {
    const old = process.env[envName];
    process.env[envName] = value;
    try {
      const client = getClient() as unknown as { opts: { host: string } } | null;
      expect(client).not.toBeNull();
      expect(client!.opts.host).toBe("https://eu.i.posthog.com");
    } finally {
      if (old === undefined) delete process.env[envName];
      else process.env[envName] = old;
    }
  });

  it("does not construct a client when key is sentinel-disabled", () => {
    (globalThis as Record<string, unknown>).__ARGENT_POSTHOG_KEY_TEST = "";
    resetClient();
    expect(getClient()).toBeNull();

    (globalThis as Record<string, unknown>).__ARGENT_POSTHOG_KEY_TEST = "phc_disabled";
    resetClient();
    expect(getClient()).toBeNull();
  });

  it("does construct a client when a real key is configured", () => {
    (globalThis as Record<string, unknown>).__ARGENT_POSTHOG_KEY_TEST = "phc_real";
    resetClient();
    expect(getClient()).not.toBeNull();
  });

  it("resolveConfig uses the single public project token", () => {
    (globalThis as Record<string, unknown>).__ARGENT_POSTHOG_KEY_TEST = "phc_single";
    expect(resolveConfig().key).toBe("phc_single");
  });

  it("uses the queued batching config for the singleton client", () => {
    const client = getClient() as unknown as {
      opts: { flushAt: number; flushInterval: number };
    } | null;

    expect(client).not.toBeNull();
    expect(client!.opts).toEqual(expect.objectContaining({ flushAt: 20, flushInterval: 10_000 }));
  });
});
