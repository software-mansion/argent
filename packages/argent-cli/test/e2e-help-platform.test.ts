import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedToolsUrl } from "@argent/tools-client";
import { e2e } from "../src/e2e.js";

const flagMock = vi.hoisted(() => vi.fn((_flag: string): boolean => true));
const getResolvedToolsUrlMock = vi.hoisted(() => vi.fn<() => Promise<ResolvedToolsUrl>>());

vi.mock("@argent/configuration-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@argent/configuration-core")>()),
  isFeatureEnabled: flagMock,
}));
vi.mock("@argent/tools-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@argent/tools-client")>()),
  getResolvedToolsUrl: getResolvedToolsUrlMock,
}));

const opts = { paths: {} as never };
const NO_LINK: ResolvedToolsUrl = { url: null, source: "none" };
const LINK: ResolvedToolsUrl = { url: "http://mac.local:4141", source: "link" };
const ENV: ResolvedToolsUrl = { url: "http://mac.local:4141", source: "env" };

describe("the --platform line of argent e2e --help", () => {
  const realPlatform = process.platform;
  let logs: string[];

  /** The `--platform` values that the help lists. */
  async function platforms(): Promise<string> {
    logs = [];
    await e2e(["run", "--help"], opts);
    const line = logs
      .join("\n")
      .split("\n")
      .find((l) => l.includes("--platform <p>"));
    return line!.replace(/^.*<p>\s+/, "").replace(/ — .*$/, "");
  }

  function host(platform: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
  }

  beforeEach(() => {
    flagMock.mockReset().mockReturnValue(true);
    getResolvedToolsUrlMock.mockReset().mockResolvedValue(NO_LINK);
    vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
  });

  afterEach(() => {
    host(realPlatform);
    vi.restoreAllMocks();
  });

  const WITH_MACOS = "ios | android | chromium | vega | macos | ios-remote";
  const WITHOUT_MACOS = "ios | android | chromium | vega | ios-remote";

  it("lists macos on macOS and does not read the link", async () => {
    host("darwin");
    expect(await platforms()).toBe(WITH_MACOS);
    expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
  });

  it.each(["linux", "win32"] as const)("does not list macos on %s without a link", async (p) => {
    host(p);
    expect(await platforms()).toBe(WITHOUT_MACOS);
  });

  it.each([
    ["argent link", LINK],
    ["ARGENT_TOOLS_URL", ENV],
  ])("lists macos off macOS when %s names a tool-server", async (_name, resolved) => {
    host("linux");
    getResolvedToolsUrlMock.mockResolvedValue(resolved);
    expect(await platforms()).toBe(WITH_MACOS);
  });

  it("does not list macos with the flag off, on any host or link, and does not read the link", async () => {
    flagMock.mockReturnValue(false);
    getResolvedToolsUrlMock.mockResolvedValue(LINK);
    for (const p of ["darwin", "linux"] as const) {
      host(p);
      expect(await platforms()).toBe(WITHOUT_MACOS);
    }
    expect(flagMock).toHaveBeenCalledWith("macos-apps");
    expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
  });

  it("prints the help without macos when the link cannot be read", async () => {
    host("linux");
    getResolvedToolsUrlMock.mockRejectedValue(new Error("unreadable"));
    expect(await platforms()).toBe(WITHOUT_MACOS);
  });
});
