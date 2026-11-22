import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  runAdb: vi.fn(async () => ({ stdout: "", stderr: "" })),
  adbShell: vi.fn(async () => ""),
}));

import { adbShell, runAdb } from "../src/utils/adb";
import {
  clearArgentProxy,
  parseGlobalProxyState,
  setArgentProxy,
} from "../src/utils/android-global-proxy";

const SERIAL = "emulator-5554";
const MARKER = "/data/local/tmp/argent-network-proxy";

const APPLIED_PORT_READ = "settings get global global_http_proxy_port";

function deviceState(host: string, port: string, marker = "", setting = "null"): void {
  vi.mocked(adbShell).mockResolvedValueOnce(
    `${setting}\n${host}\n${port}\n${marker}${marker ? "\n" : ""}`
  );
}

function appliedPortReads(...ports: string[]): void {
  for (const port of ports) vi.mocked(adbShell).mockResolvedValueOnce(`${port}\n`);
}

function writes(): string[] {
  const shell = vi.mocked(adbShell).mock;
  const adb = vi.mocked(runAdb).mock;
  const calls = [
    ...shell.calls.map(([, command], i) => ({ order: shell.invocationCallOrder[i]!, command })),
    ...adb.calls.map(([args], i) => ({
      order: adb.invocationCallOrder[i]!,
      command: (args as string[]).slice(3).join(" "),
    })),
  ];
  return calls
    .sort((a, b) => a.order - b.order)
    .slice(1)
    .map(({ command }) => command);
}

beforeEach(() => {
  vi.mocked(adbShell).mockReset().mockResolvedValue("");
  vi.mocked(runAdb).mockClear();
});

describe("parseGlobalProxyState", () => {
  it.each([
    ["null\nnull\nnull\n", null],
    [":0\n\n0\n", null],
    ["null\n10.0.2.2\n0\n", null],
    ["null\n\n8888\n", null],
    ["null\n10.0.2.2\n8888\n", "10.0.2.2:8888"],
    ["10.0.2.2:8888\nnull\nnull\n", "10.0.2.2:8888"],
    [":0\n10.0.2.2\n8888\n", "10.0.2.2:8888"],
  ])("reads %j as the proxy %s", (output, active) => {
    expect(parseGlobalProxyState(output).active).toBe(active);
  });

  it("reads the marker as the proxy Argent set", () => {
    expect(parseGlobalProxyState("null\nnull\nnull\n10.0.2.2:50000\n").argent).toBe(
      "10.0.2.2:50000"
    );
  });
});

describe("setArgentProxy", () => {
  it("writes the marker before it points the emulator at the proxy", async () => {
    deviceState("null", "null");

    await setArgentProxy(SERIAL, 50000);

    expect(writes()).toEqual([
      `echo 10.0.2.2:50000 > ${MARKER}`,
      "settings put global http_proxy 10.0.2.2:50000",
    ]);
  });

  it("replaces the proxy a crashed tool-server left", async () => {
    deviceState("10.0.2.2", "41000", "10.0.2.2:41000");

    await setArgentProxy(SERIAL, 50000);

    expect(writes()).toContain("settings put global http_proxy 10.0.2.2:50000");
  });

  it("changes nothing when the emulator already uses this proxy", async () => {
    deviceState("10.0.2.2", "50000", "10.0.2.2:50000");

    await setArgentProxy(SERIAL, 50000);

    expect(writes()).toEqual([]);
  });

  it.each([
    ["no marker", ""],
    ["a marker for another proxy", "10.0.2.2:41000"],
  ])("refuses a proxy the user set, with %s", async (_label, marker) => {
    deviceState("10.0.2.2", "8888", marker);

    await expect(setArgentProxy(SERIAL, 50000)).rejects.toThrow(
      /already uses the HTTP proxy 10\.0\.2\.2:8888/
    );
    expect(writes()).toEqual([]);
  });
});

describe("clearArgentProxy", () => {
  it("deletes the settings only after the device has applied the removal", async () => {
    deviceState("10.0.2.2", "41000", "10.0.2.2:41000");
    appliedPortReads("41000", "0");

    await clearArgentProxy(SERIAL);

    expect(writes()).toEqual([
      "settings put global http_proxy :0",
      APPLIED_PORT_READ,
      APPLIED_PORT_READ,
      "settings delete global http_proxy; settings delete global global_http_proxy_host; " +
        "settings delete global global_http_proxy_port; settings delete global global_http_proxy_exclusion_list",
      `rm -f ${MARKER}`,
    ]);
  });

  it("removes a proxy the device has not copied to its host and port yet", async () => {
    deviceState("null", "null", "10.0.2.2:41000", "10.0.2.2:41000");
    appliedPortReads("0");

    await clearArgentProxy(SERIAL);

    expect(writes()).toContain("settings put global http_proxy :0");
  });

  it("fails and keeps the marker when the device does not apply the removal in time", async () => {
    deviceState("10.0.2.2", "41000", "10.0.2.2:41000");
    vi.mocked(adbShell).mockResolvedValue("41000\n");
    vi.useFakeTimers();
    try {
      const cleared = clearArgentProxy(SERIAL).catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(String(await cleared)).toMatch(/did not apply it within 5 s/);
    } finally {
      vi.useRealTimers();
    }

    const commands = writes().filter((command) => command !== APPLIED_PORT_READ);
    expect(commands).toEqual(["settings put global http_proxy :0"]);
  });

  it("keeps a proxy the user set and drops a stale marker", async () => {
    deviceState("10.0.2.2", "8888", "10.0.2.2:41000");

    await clearArgentProxy(SERIAL);

    expect(writes()).toEqual([`rm -f ${MARKER}`]);
  });

  it.each([
    ["a proxy the user set", "10.0.2.2", "8888"],
    ["no proxy", "null", "null"],
  ])("changes nothing with %s and no marker", async (_label, host, port) => {
    deviceState(host, port);

    await clearArgentProxy(SERIAL);

    expect(writes()).toEqual([]);
  });
});
