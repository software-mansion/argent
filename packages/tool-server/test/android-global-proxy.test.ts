import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  runAdb: vi.fn(async () => ({ stdout: "", stderr: "" })),
  adbShell: vi.fn(async () => ""),
}));

import { adbShell, runAdb } from "../src/utils/adb";
import {
  clearArgentProxy,
  parseAdbReverses,
  parseGlobalProxyState,
  setArgentProxy,
} from "../src/utils/android-global-proxy";

const SERIAL = "emulator-5554";
const MARKER = "/data/local/tmp/argent-network-proxy";

/** What the device answers to the state read: proxy host, proxy port, marker. */
function deviceState(host: string, port: string, marker = ""): void {
  vi.mocked(adbShell).mockResolvedValueOnce(`${host}\n${port}\n${marker}${marker ? "\n" : ""}`);
}

/** Every adb call after the state read, in the order they ran. */
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
    ["null\nnull\n", null],
    ["\n0\n", null],
    ["10.0.2.2\n0\n", null],
    ["\n8888\n", null],
    ["10.0.2.2\n8888\n", "10.0.2.2:8888"],
  ])("reads %j as the proxy %s", (output, active) => {
    expect(parseGlobalProxyState(output).active).toBe(active);
  });

  it("reads the marker as the proxy Argent set", () => {
    expect(parseGlobalProxyState("null\nnull\n10.0.2.2:50000\n").argent).toBe("10.0.2.2:50000");
    expect(parseGlobalProxyState("null\nnull\n").argent).toBeNull();
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
  it("removes Argent's proxy, its settings and the marker", async () => {
    deviceState("10.0.2.2", "41000", "10.0.2.2:41000");

    await clearArgentProxy(SERIAL);

    expect(writes()).toEqual([
      "settings put global http_proxy :0",
      "settings delete global http_proxy; settings delete global global_http_proxy_host; " +
        "settings delete global global_http_proxy_port; settings delete global global_http_proxy_exclusion_list",
      `rm -f ${MARKER}`,
    ]);
  });

  it("keeps a proxy the user set and drops a stale marker", async () => {
    deviceState("10.0.2.2", "8888", "10.0.2.2:41000");

    await clearArgentProxy(SERIAL);

    expect(writes()).toEqual([`rm -f ${MARKER}`]);
  });

  it("keeps a proxy the user set when Argent set none", async () => {
    deviceState("10.0.2.2", "8888");

    await clearArgentProxy(SERIAL);

    expect(writes()).toEqual([]);
  });

  it("changes nothing without a proxy or a marker", async () => {
    deviceState("null", "null");

    await clearArgentProxy(SERIAL);

    expect(writes()).toEqual([]);
  });
});

describe("parseAdbReverses", () => {
  it("maps each device port to its host port", () => {
    const output =
      "host-15 tcp:8081 tcp:8081\nhost-15 tcp:3000 tcp:4000\nhost-15 localabstract:x tcp:5\n";

    expect([...parseAdbReverses(output)]).toEqual([
      [8081, 8081],
      [3000, 4000],
    ]);
  });
});
