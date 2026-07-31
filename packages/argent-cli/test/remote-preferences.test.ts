import { afterEach, describe, expect, it, vi } from "vitest";
import { pushRemotePreferences } from "../src/remote-preferences.js";

const SNAPSHOT = {
  version: 1 as const,
  flags: { "video-watermark": false },
  telemetryDisabled: true,
};

describe("pushRemotePreferences", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the snapshot with bearer authentication", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            version: 1,
            telemetryDisabled: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      pushRemotePreferences("https://example.test/argent///", "secret", SNAPSHOT)
    ).resolves.toEqual({
      status: "synced",
      telemetryDisabled: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test/argent/preferences/sync",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({ Authorization: "Bearer secret" }),
        body: JSON.stringify(SNAPSHOT),
      })
    );
  });

  it("treats an older server's 404 as unsupported", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      pushRemotePreferences("http://127.0.0.1:3001", undefined, SNAPSHOT)
    ).resolves.toEqual({ status: "unsupported" });
  });

  it("returns failures without throwing so linking can continue", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await pushRemotePreferences("http://127.0.0.1:3001", undefined, SNAPSHOT);
    expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("500") });
  });

  it("rejects malformed success bodies and unconfirmed telemetry opt-outs", async () => {
    const malformed = vi.fn(async () => Response.json({ version: 1 }));
    vi.stubGlobal("fetch", malformed);
    await expect(
      pushRemotePreferences("http://127.0.0.1:3001", undefined, SNAPSHOT)
    ).resolves.toMatchObject({ status: "failed", error: expect.stringContaining("body") });

    const unconfirmed = vi.fn(async () =>
      Response.json({
        version: 1,
        telemetryDisabled: false,
      })
    );
    vi.stubGlobal("fetch", unconfirmed);
    await expect(
      pushRemotePreferences("http://127.0.0.1:3001", undefined, SNAPSHOT)
    ).resolves.toMatchObject({ status: "failed", error: expect.stringContaining("not confirmed") });
  });
});
