import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DeviceInfo, Registry } from "@argent/registry";

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

// androidImpl goes through the adbShell util; ios-remote through simctlOpenUrl.
// Stub both at the module boundary to assert their returned result shapes.
const adbShellMock = vi.fn();
vi.mock("../src/utils/adb", async () => {
  const actual = await vi.importActual<object>("../src/utils/adb");
  return { ...actual, adbShell: (...args: unknown[]) => adbShellMock(...args) };
});
const simctlOpenUrlMock = vi.fn();
vi.mock("../src/utils/sim-remote", async () => {
  const actual = await vi.importActual<object>("../src/utils/sim-remote");
  return { ...actual, simctlOpenUrl: (...args: unknown[]) => simctlOpenUrlMock(...args) };
});

import { httpDeepLinkNote } from "../src/tools/open-url/deep-link-note";
import { makeIosImpl } from "../src/tools/open-url/platforms/ios";
import { androidImpl } from "../src/tools/open-url/platforms/android";
import { iosRemoteImpl } from "../src/tools/open-url/platforms/ios-remote";

const device = { id: "SIM", platform: "ios", kind: "simulator" } as DeviceInfo;
const ensureEnvReadyMock = vi.fn();
const resolveServiceMock = vi.fn();
const iosImpl = makeIosImpl({ resolveService: resolveServiceMock } as unknown as Registry);
const androidDevice = { platform: "android", udid: "emulator-5554" } as unknown as DeviceInfo;

beforeEach(() => {
  execFileMock.mockReset();
  execFileMock.mockReturnValue({ stdout: "", stderr: "" });
  adbShellMock.mockReset();
  adbShellMock.mockResolvedValue("Starting: Intent { act=android.intent.action.VIEW }");
  simctlOpenUrlMock.mockReset();
  simctlOpenUrlMock.mockResolvedValue(undefined);
  ensureEnvReadyMock.mockReset().mockResolvedValue(undefined);
  resolveServiceMock.mockReset().mockResolvedValue({ ensureEnvReady: ensureEnvReadyMock });
});

describe("httpDeepLinkNote", () => {
  it("returns the deep-linking caveat for http/https web URLs", () => {
    for (const url of [
      "https://bsky.app/profile/tvpworld.bsky.social",
      "http://example.com",
      "HTTPS://EXAMPLE.COM", // scheme match is case-insensitive
      "http:example.com", // slashless form — browsers normalize it to http://
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

describe("open-url iOS handler arms native-devtools injection", () => {
  it("applies the launchd env before simctl openurl, which can cold-launch the app", async () => {
    await iosImpl.handler({}, { udid: "SIM", url: "bluesky://profile/x" }, device);

    expect(resolveServiceMock).toHaveBeenCalledWith(
      "NativeDevtools:SIM",
      expect.objectContaining({ device })
    );
    expect(ensureEnvReadyMock).toHaveBeenCalledTimes(1);
    expect(ensureEnvReadyMock.mock.invocationCallOrder[0]).toBeLessThan(
      execFileMock.mock.invocationCallOrder[0]
    );
  });

  it.each([
    [
      "the service cannot be resolved",
      () => resolveServiceMock.mockRejectedValueOnce(new Error("x")),
    ],
    ["the env cannot be applied", () => ensureEnvReadyMock.mockRejectedValueOnce(new Error("x"))],
  ])("still opens the URL when %s", async (_label, fail) => {
    fail();

    const res = await iosImpl.handler({}, { udid: "SIM", url: "bluesky://profile/x" }, device);

    expect(res.opened).toBe(true);
    expect(execFileMock).toHaveBeenCalledWith("xcrun", [
      "simctl",
      "openurl",
      "SIM",
      "bluesky://profile/x",
    ]);
  });
});

describe("open-url Android handler surfaces the caveat only for web URLs", () => {
  it("attaches note for an https App Link", async () => {
    const res = await androidImpl.handler(
      {},
      { udid: "emulator-5554", url: "https://bsky.app/profile/x" },
      androidDevice
    );
    expect(res.opened).toBe(true);
    expect(res.note).toBeTypeOf("string");
  });

  it("omits note for a custom-scheme deep link", async () => {
    const res = await androidImpl.handler(
      {},
      { udid: "emulator-5554", url: "geo:37.0,-122.0" },
      androidDevice
    );
    expect(res.opened).toBe(true);
    expect(res.note).toBeUndefined();
  });
});

describe("open-url iOS remote handler surfaces the caveat only for web URLs", () => {
  it("attaches note for an https Universal Link", async () => {
    const res = await iosRemoteImpl.handler(
      {},
      { udid: "SIM", url: "https://example.com" },
      device
    );
    expect(res.opened).toBe(true);
    expect(res.note).toBeTypeOf("string");
    expect(simctlOpenUrlMock).toHaveBeenCalledWith("SIM", "https://example.com");
  });

  it("omits note for a custom-scheme deep link", async () => {
    const res = await iosRemoteImpl.handler({}, { udid: "SIM", url: "maps://" }, device);
    expect(res.opened).toBe(true);
    expect(res.note).toBeUndefined();
  });
});
