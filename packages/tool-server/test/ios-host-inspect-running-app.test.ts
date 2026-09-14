import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `inspectRunningApp` is read as a verdict, not as a best effort: its
 * `{running, process}` pair is what `appConnectionState` turns into a state,
 * and `{running: true, process: null}` becomes `indeterminate` — the one
 * unconnected state whose remedy escalates from restart-app to restarting the
 * whole tool-server. An app that exits between the job-table read and the `ps`
 * read produces exactly that pair while the truth is `not_running`, whose
 * remedy is simply to launch it.
 */
const execFileMock = vi.fn<(cmd: string, args: readonly string[]) => unknown>();

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
      const callback = (typeof opts === "function" ? opts : cb!) as (
        err: Error | null,
        out: { stdout: string; stderr: string }
      ) => void;
      const result = execFileMock(cmd, args);
      if (result instanceof Error) callback(result, { stdout: "", stderr: "" });
      else
        callback(
          null,
          (result as { stdout: string; stderr: string }) ?? { stdout: "", stderr: "" }
        );
    },
  };
});

vi.mock("@argent/configuration-core", async () => {
  const actual = await vi.importActual<typeof import("@argent/configuration-core")>(
    "@argent/configuration-core"
  );
  return { ...actual, getAdditionalIosDeviceSets: () => [] };
});

vi.mock("@argent/native-devtools-ios", () => ({
  bootstrapDylibPath: () => "/fake/dylibs/libArgentInjectionBootstrap.dylib",
  bootstrapDylibPathTcp: () => "/fake/dylibs/tcp/libArgentInjectionBootstrap.dylib",
  bootstrapDylibPathTvos: () => "/fake/dylibs/tvos/libArgentInjectionBootstrap.dylib",
  tcpInjectionDylibs: () => [],
  axServiceBinaryPath: () => "/fake/ax-service",
  axServiceBinaryPathTcp: () => "/fake/ax-service-tcp",
}));

import { localIosHost } from "../src/utils/ios-host";
import { __resetDeviceSetCacheForTesting } from "../src/utils/ios-device-sets";

const UDID = "CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC";
const BUNDLE = "com.example.app";
const PID = 5150;
const JOB_ROW = `${PID}\t0\tUIKitApplication:${BUNDLE}[dffa][rb-legacy]\n`;

/** `launchctl list` stdout for each successive call, oldest first. */
let jobTables: string[] = [];
let listCalls = 0;
let psResult: unknown;

beforeEach(() => {
  __resetDeviceSetCacheForTesting();
  jobTables = [];
  listCalls = 0;
  psResult = { stdout: `01:00 /Devices/${UDID}/App.app/App FOO=bar\n`, stderr: "" };
  execFileMock.mockReset().mockImplementation((cmd, args) => {
    if (/\bps$/.test(cmd)) return psResult;
    const argv = [...args];
    if (argv.includes("list") && argv.includes("--json")) {
      return { stdout: JSON.stringify({ devices: {} }), stderr: "" };
    }
    if (argv.includes("launchctl")) {
      // Past the end, the table keeps answering what it last said — so a test
      // pins the number of reads by what it supplies, not by an index crash.
      const stdout = jobTables[Math.min(listCalls, jobTables.length - 1)] ?? "";
      listCalls++;
      return { stdout, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
});

describe("inspectRunningApp when the process probe comes back empty", () => {
  it("reports an app that exited during the probe as not running", async () => {
    // The job table lists it, `ps` finds no such pid, and by the second read the
    // row is gone: the app exited in between.
    jobTables = [JOB_ROW, ""];
    psResult = new Error("ps: 5150: no such process");

    await expect(localIosHost.inspectRunningApp(UDID, BUNDLE)).resolves.toEqual({
      running: false,
      process: null,
    });
  });

  it("still reports no evidence when the app is there and the probe is what failed", async () => {
    // Same empty `ps`, but the row survives — the probe itself is broken (bad
    // flags, a host without `ps`), which is genuinely "could not inspect".
    jobTables = [JOB_ROW, JOB_ROW];
    psResult = new Error("ps: illegal option -- w");

    await expect(localIosHost.inspectRunningApp(UDID, BUNDLE)).resolves.toEqual({
      running: true,
      process: null,
    });
  });

  it("takes no second job-table read when the probe answered", async () => {
    jobTables = [JOB_ROW];

    const inspection = await localIosHost.inspectRunningApp(UDID, BUNDLE);

    expect(inspection.process?.pid).toBe(PID);
    expect(listCalls).toBe(1);
  });

  it("takes no probe at all for a bundle the job table never listed", async () => {
    jobTables = [""];

    await expect(localIosHost.inspectRunningApp(UDID, BUNDLE)).resolves.toEqual({
      running: false,
      process: null,
    });
    expect(listCalls).toBe(1);
  });
});
