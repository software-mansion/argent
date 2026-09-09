import { afterEach, describe, expect, it, vi } from "vitest";
import { killStaleRunnersForDevice } from "../src/utils/ios-device/runner-sweep";

const STALE_UDID = "00008120-000000000000001E";
const STALE_XCTESTRUN =
  "/Users/dev/.argent/ios-device-runner/derived/cache-aaaa111122223333/Build/Products/" +
  "ArgentRunner_iphoneos18.0-arm64.xctestrun";

/** The sweep's SIGTERM grace window and liveness poll interval. */
const GRACE_MS = 5_000;
const POLL_MS = 100;

/**
 * Fake process table behind `process.kill`, so no real signal is ever sent and
 * no real pid is ever probed. `dyingAfterPolls` maps a pid to the number of
 * liveness polls after which its signal-0 probe starts reporting it gone (time
 * runs on the fake clock, so a test advances it); pids absent from the map are
 * dead from the start, Infinity ignores SIGTERM forever. Every delivered
 * signal is recorded; `refuse` makes matching deliveries throw instead.
 */
function fakeProcessTable(
  dyingAfterPolls: Record<number, number>,
  refuse: (pid: number, signal: string) => boolean = () => false
) {
  const startedAt = Date.now();
  const kills: Array<{ pid: number; signal: string }> = [];

  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (signal === 0) {
      const alive = (dyingAfterPolls[pid] ?? -1) * POLL_MS > Date.now() - startedAt;
      if (!alive) throw Object.assign(new Error("ESRCH: no such process"), { code: "ESRCH" });
      return true;
    }

    const name = String(signal);
    kills.push({ pid, signal: name });
    if (refuse(pid, name)) throw new Error(`EPERM: cannot deliver ${name} to ${pid}`);
    return true;
  });

  return { kills };
}

/**
 * One `ps -ax -o pid=,ppid=,command=` line shaped like a launched runner.
 * The defaults satisfy all three argv filter clauses; each override drops
 * exactly one, so a spared override pins that clause individually.
 */
function runnerPsLine(opts: {
  pid: number;
  ppid: number;
  action?: string;
  udid?: string;
  xctestrun?: string;
}): string {
  return [
    String(opts.pid).padStart(5),
    String(opts.ppid).padStart(5),
    "/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild",
    opts.action ?? "test-without-building",
    "-xctestrun",
    opts.xctestrun ?? STALE_XCTESTRUN,
    "-destination",
    `platform=iOS,id=${opts.udid ?? STALE_UDID}`,
  ].join(" ");
}

function sweep(psLines: string[]): Promise<number> {
  return killStaleRunnersForDevice(STALE_UDID, async () => psLines.join("\n"));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("killStaleRunnersForDevice", () => {
  it("SIGTERMs an orphan re-parented to launchd (ppid 1), ignoring unrelated lines", async () => {
    const table = fakeProcessTable({});

    const killed = await sweep([
      "  400     1 /usr/local/bin/node /opt/argent/dist/server.js",
      runnerPsLine({ pid: 101, ppid: 1 }),
    ]);

    expect(killed).toBe(1);
    expect(table.kills).toEqual([{ pid: -101, signal: "SIGTERM" }]);
  });

  it("SIGTERMs an orphan whose parent pid is no longer alive", async () => {
    // ppid 4242 is absent from the table, so the liveness probe reports it
    // gone: the owning tool-server died without launchd adoption completing.
    const table = fakeProcessTable({});

    const killed = await sweep([runnerPsLine({ pid: 101, ppid: 4242 })]);

    expect(killed).toBe(1);
    expect(table.kills).toEqual([{ pid: -101, signal: "SIGTERM" }]);
  });

  it("spares a matched runner whose parent is a LIVE peer tool-server", async () => {
    const table = fakeProcessTable({ 4242: Infinity });

    const killed = await sweep([runnerPsLine({ pid: 101, ppid: 4242 })]);

    expect(killed).toBe(0); // the peer's session conflict is testmanagerd's to report
    expect(table.kills).toEqual([]);
  });

  it("never signals its own pid, even when it would count as an orphan", async () => {
    const table = fakeProcessTable({});

    expect(await sweep([runnerPsLine({ pid: process.pid, ppid: 1 })])).toBe(0);
    expect(table.kills).toEqual([]);
  });

  // The three clause tests below each present an ORPHAN (ppid 1), so the only
  // thing sparing it is the missing argv clause under test.
  it("spares a line without the test-without-building clause (a build is not a runner)", async () => {
    const table = fakeProcessTable({});

    expect(await sweep([runnerPsLine({ pid: 101, ppid: 1, action: "build-for-testing" })])).toBe(0);
    expect(table.kills).toEqual([]);
  });

  it("spares a runner driving a DIFFERENT device", async () => {
    const table = fakeProcessTable({});

    expect(
      await sweep([runnerPsLine({ pid: 101, ppid: 1, udid: "00008120-FFFFFFFFFFFFFFFF" })])
    ).toBe(0);
    expect(table.kills).toEqual([]);
  });

  it("spares an xcodebuild test run outside our cache root", async () => {
    const table = fakeProcessTable({});

    expect(
      await sweep([
        runnerPsLine({
          pid: 101,
          ppid: 1,
          xctestrun: "/Users/dev/proj/build/MyAppUITests.xctestrun",
        }),
      ])
    ).toBe(0);
    expect(table.kills).toEqual([]);
  });

  it("escalates a SIGTERM-ignoring orphan to a group SIGKILL once the grace window closes", async () => {
    vi.useFakeTimers();
    const table = fakeProcessTable({ 101: Infinity });

    const pending = sweep([runnerPsLine({ pid: 101, ppid: 1 })]);

    // The whole window is polled before the escalation, not a moment less.
    await vi.advanceTimersByTimeAsync(GRACE_MS - POLL_MS);
    expect(table.kills).toEqual([{ pid: -101, signal: "SIGTERM" }]);

    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(await pending).toBe(1);
    expect(table.kills).toEqual([
      { pid: -101, signal: "SIGTERM" },
      { pid: -101, signal: "SIGKILL" },
    ]);
  });

  it("SIGKILLs only the holdout when the other orphan exits mid-window", async () => {
    vi.useFakeTimers();
    const table = fakeProcessTable({ 101: 2, 102: Infinity });

    const pending = sweep([
      runnerPsLine({ pid: 101, ppid: 1 }),
      runnerPsLine({ pid: 102, ppid: 1 }),
    ]);
    await vi.advanceTimersByTimeAsync(GRACE_MS);

    expect(await pending).toBe(2);
    expect(table.kills).toEqual([
      { pid: -101, signal: "SIGTERM" },
      { pid: -102, signal: "SIGTERM" },
      { pid: -102, signal: "SIGKILL" },
    ]);
  });

  it("tolerates a pid exiting between the last poll and the escalation", async () => {
    vi.useFakeTimers();
    // The SIGKILL finds nothing: the pid exited after the last liveness probe.
    fakeProcessTable({ 101: Infinity }, (_pid, signal) => signal === "SIGKILL");

    const pending = sweep([runnerPsLine({ pid: 101, ppid: 1 })]);
    await vi.advanceTimersByTimeAsync(GRACE_MS);

    expect(await pending).toBe(1);
  });

  it("falls back to a bare-pid SIGTERM when the process-group signal fails", async () => {
    const table = fakeProcessTable({}, (pid) => pid < 0);

    expect(await sweep([runnerPsLine({ pid: 101, ppid: 1 })])).toBe(1);
    expect(table.kills).toEqual([
      { pid: -101, signal: "SIGTERM" },
      { pid: 101, signal: "SIGTERM" },
    ]);
  });

  it("treats a failed ps snapshot as nothing to reap", async () => {
    const table = fakeProcessTable({});

    const killed = await killStaleRunnersForDevice(STALE_UDID, async () => {
      throw new Error("ps: command failed");
    });

    expect(killed).toBe(0);
    expect(table.kills).toEqual([]);
  });
});
