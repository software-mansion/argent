import { describe, expect, it, vi } from "vitest";
import type { Registry, ToolContext } from "@argent/registry";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";

const bootBrowserMock = vi.fn();
vi.mock("../src/tools/devices/boot-browser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/devices/boot-browser")>()),
  bootBrowser: (opts: unknown) => bootBrowserMock(opts),
}));
const bootElectronAppMock = vi.fn();
vi.mock("../src/tools/devices/boot-electron", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/devices/boot-electron")>()),
  bootElectronApp: (opts: unknown) => bootElectronAppMock(opts),
}));

import { createBootDeviceTool } from "../src/tools/devices/boot-device";

describe("boot-device browser", () => {
  const tool = createBootDeviceTool({} as Registry);

  it("boots the browser with the shared Chromium port and args", async () => {
    bootBrowserMock.mockResolvedValue({ platform: "chromium", id: "chromium-cdp-9333" });
    const { signal } = new AbortController();
    const res = await tool.execute!(
      {},
      { browser: "edge", electronPort: 9333, electronArgs: ["--headless=new"] },
      { signal } as ToolContext
    );
    expect(bootBrowserMock).toHaveBeenCalledWith({
      browser: "edge",
      port: 9333,
      extraArgs: ["--headless=new"],
      signal,
    });
    expect(res).toEqual({ platform: "chromium", id: "chromium-cdp-9333" });
  });

  it("passes the call's signal to an Electron boot", async () => {
    bootElectronAppMock.mockResolvedValue({ platform: "chromium", id: "chromium-cdp-9334" });
    const { signal } = new AbortController();
    await tool.execute!({}, { electronAppPath: "/x.app", electronPort: 9334 }, {
      signal,
    } as ToolContext);
    expect(bootElectronAppMock).toHaveBeenCalledWith({
      appPath: "/x.app",
      port: 9334,
      signal,
      extraArgs: undefined,
    });
  });

  it("counts browser as a target in the exactly-one check", async () => {
    bootBrowserMock.mockClear();
    const err = await tool.execute!({}, { browser: "chrome", electronAppPath: "/x" }).catch(
      (e: unknown) => e
    );
    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.BOOT_DEVICE_TARGET_SELECTION_INVALID
    );
    expect(bootBrowserMock).not.toHaveBeenCalled();
  });

  it("names the browser in its progress messages", () => {
    expect(tool.interaction!.startedMsg!({ params: { browser: "edge" } } as never)).toBe(
      "Starting edge"
    );
    expect(tool.interaction!.startedMsg!({ params: { udid: "", browser: "edge" } } as never)).toBe(
      "Starting edge"
    );
  });

  it("rejects a browser outside the supported set at the schema", () => {
    expect(tool.zodSchema!.safeParse({ browser: "firefox" }).success).toBe(false);
    expect(tool.zodSchema!.safeParse({ browser: "brave" }).success).toBe(true);
  });
});
