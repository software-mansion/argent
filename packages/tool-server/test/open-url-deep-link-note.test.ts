import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DeviceInfo } from "@argent/registry";

// iosImpl shells out via execFileAsync(promisify(execFile)). Stub the round-trip
// so the handler resolves without a real `xcrun simctl openurl`, letting us
// assert the returned result shape (the note) rather than the subprocess.
const execFileMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: readonly string[],
      opts: unknown,
      cb?: (err: Error | null, out: { stdout: string; stderr: string }) => void
    ) => {
      const callback = typeof opts === "function" ? opts : cb!;
      const result = execFileMock(cmd, args);
      if (result instanceof Error) callback(result, { stdout: "", stderr: "" });
      else callback(null, result ?? { stdout: "", stderr: "" });
    },
  };
});

import { httpDeepLinkNote } from "../src/tools/open-url/deep-link-note";
import { iosImpl } from "../src/tools/open-url/platforms/ios";

const device = { platform: "ios", udid: "SIM" } as unknown as DeviceInfo;

beforeEach(() => {
  execFileMock.mockReset();
  execFileMock.mockReturnValue({ stdout: "", stderr: "" });
});

describe("httpDeepLinkNote", () => {
  it("returns the deep-linking caveat for http/https web URLs", () => {
    for (const url of [
      "https://bsky.app/profile/tvpworld.bsky.social",
      "http://example.com",
      "HTTPS://EXAMPLE.COM", // scheme match is case-insensitive
    ]) {
      const note = httpDeepLinkNote(url);
      expect(note, url).toBeTypeOf("string");
      expect(note).toMatch(/custom scheme|Universal Links|launch-app/);
    }
  });

  it("returns undefined for custom schemes and non-web schemes", () => {
    for (const url of [
      "bluesky://profile/tvpworld", // app custom scheme — routes reliably
      "messages://",
      "settings://",
      "tel:5551234",
      "mailto:a@b.com",
      "geo:37.0,-122.0",
    ]) {
      expect(httpDeepLinkNote(url), url).toBeUndefined();
    }
  });
});

describe("open-url iOS handler surfaces the caveat only for web URLs", () => {
  it("attaches note for an https Universal Link (the bsky.app repro)", async () => {
    const res = await iosImpl.handler(
      {},
      { udid: "SIM", url: "https://bsky.app/profile/tvpworld.bsky.social" },
      device
    );
    expect(res.opened).toBe(true);
    expect(res.url).toBe("https://bsky.app/profile/tvpworld.bsky.social");
    expect(res.note).toBeTypeOf("string");
    // The exact URL is still handed to simctl unchanged (no rewriting).
    expect(execFileMock).toHaveBeenCalledWith("xcrun", [
      "simctl",
      "openurl",
      "SIM",
      "https://bsky.app/profile/tvpworld.bsky.social",
    ]);
  });

  it("omits note for a custom-scheme deep link", async () => {
    const res = await iosImpl.handler({}, { udid: "SIM", url: "bluesky://profile/x" }, device);
    expect(res.opened).toBe(true);
    expect(res.note).toBeUndefined();
  });
});
