import { describe, expect, it, vi } from "vitest";
import { pushRemotePreferences } from "../src/remote-preferences.js";

const SNAPSHOT = {
  version: 1 as const,
  flags: { "video-watermark": false },
  telemetry: { enabled: false as const },
};

describe("pushRemotePreferences", () => {
  it("sends the snapshot with bearer authentication", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            appliedFlags: ["video-watermark"],
            ignoredFlags: [],
            telemetryDisabled: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    );

    await expect(
      pushRemotePreferences("https://example.test/argent/", "secret", SNAPSHOT, fetchImpl)
    ).resolves.toEqual({
      status: "synced",
      appliedFlags: ["video-watermark"],
      ignoredFlags: [],
      telemetryDisabled: true,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://example.test/argent/preferences/sync",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({ Authorization: "Bearer secret" }),
        body: JSON.stringify(SNAPSHOT),
      })
    );
  });

  it("treats an older server's 404 as unsupported", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    await expect(
      pushRemotePreferences("http://127.0.0.1:3001", undefined, SNAPSHOT, fetchImpl)
    ).resolves.toEqual({ status: "unsupported" });
  });

  it("returns failures without throwing so linking can continue", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const result = await pushRemotePreferences(
      "http://127.0.0.1:3001",
      undefined,
      SNAPSHOT,
      fetchImpl
    );
    expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("500") });
  });
});
