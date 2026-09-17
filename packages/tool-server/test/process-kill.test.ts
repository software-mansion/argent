import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  pidIsAlive,
  pollPidsUntilGone,
  scheduleGroupSigkill,
  signalGroup,
  signalGroupThenPid,
} from "../src/utils/process-kill";

const PID = 4242;

function errnoError(code: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`kill ${code}`);
  err.code = code;
  return err;
}

function installKillSpy() {
  return vi.spyOn(process, "kill").mockImplementation(() => true);
}

let killSpy: ReturnType<typeof installKillSpy>;

beforeEach(() => {
  killSpy = installKillSpy();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("signalGroup", () => {
  it("signals the group (negative pid) and reports it present on success", () => {
    expect(signalGroup(PID, "SIGTERM")).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(-PID, "SIGTERM");
  });

  it("reports an empty group on ESRCH", () => {
    killSpy.mockImplementation(() => {
      throw errnoError("ESRCH");
    });
    expect(signalGroup(PID, 0)).toBe(false);
  });

  it("treats a refused signal (EPERM) as a live group", () => {
    killSpy.mockImplementation(() => {
      throw errnoError("EPERM");
    });
    expect(signalGroup(PID, "SIGKILL")).toBe(true);
  });
});

describe("pidIsAlive", () => {
  it("probes the bare pid with signal 0", () => {
    expect(pidIsAlive(PID)).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(PID, 0);
  });

  it("reads ANY probe failure as dead, unlike signalGroup's EPERM handling", () => {
    // runner-build's historical contract: when liveness cannot be confirmed,
    // the sweep treats the owner as gone and the exit wait as satisfied.
    killSpy.mockImplementation(() => {
      throw errnoError("EPERM");
    });
    expect(pidIsAlive(PID)).toBe(false);
  });
});

describe("signalGroupThenPid", () => {
  it("delivers to the group and skips the bare-pid fallback on success", () => {
    const kills: Array<{ pid: number; signal: string }> = [];
    const kill = (pid: number, signal: string) => {
      kills.push({ pid, signal });
    };

    expect(signalGroupThenPid(kill, 101, "SIGTERM")).toBe(true);
    expect(kills).toEqual([{ pid: -101, signal: "SIGTERM" }]);
  });

  it("falls back to the bare pid when the group signal fails", () => {
    const kills: Array<{ pid: number; signal: string }> = [];
    const kill = (pid: number, signal: string) => {
      kills.push({ pid, signal });
      if (pid < 0) throw errnoError("EPERM");
    };

    expect(signalGroupThenPid(kill, 101, "SIGKILL")).toBe(true);
    expect(kills).toEqual([
      { pid: -101, signal: "SIGKILL" },
      { pid: 101, signal: "SIGKILL" },
    ]);
  });

  it("swallows a double failure and reports that nothing was reached", () => {
    const kill = () => {
      throw errnoError("ESRCH");
    };
    expect(signalGroupThenPid(kill, 101, "SIGTERM")).toBe(false);
  });
});

describe("scheduleGroupSigkill", () => {
  it("ungated: group SIGKILL fires only once the grace period elapses", () => {
    vi.useFakeTimers();
    scheduleGroupSigkill(PID, 5_000, { gateOnGroupLiveness: false });

    vi.advanceTimersByTime(4_999);
    expect(killSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(-PID, "SIGKILL");
  });

  it("ungated: fires without a liveness probe and swallows an already-gone group", () => {
    vi.useFakeTimers();
    killSpy.mockImplementation(() => {
      throw errnoError("ESRCH");
    });
    scheduleGroupSigkill(PID, 5_000, { gateOnGroupLiveness: false });

    expect(() => vi.advanceTimersByTime(5_000)).not.toThrow();
    const signals = killSpy.mock.calls.map((c) => c[1]);
    expect(signals).toEqual(["SIGKILL"]);
  });

  it("gated: probes the group and escalates while anything in it survives", () => {
    vi.useFakeTimers();
    scheduleGroupSigkill(PID, 2_000, { gateOnGroupLiveness: true });

    vi.advanceTimersByTime(2_000);
    expect(killSpy).toHaveBeenCalledWith(-PID, 0);
    expect(killSpy).toHaveBeenCalledWith(-PID, "SIGKILL");
  });

  it("gated: suppresses the SIGKILL when the group emptied within the grace period", () => {
    vi.useFakeTimers();
    killSpy.mockImplementation(((_pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === 0) throw errnoError("ESRCH");
      return true;
    }) as typeof process.kill);
    scheduleGroupSigkill(PID, 2_000, { gateOnGroupLiveness: true });

    vi.advanceTimersByTime(2_000);
    const signals = killSpy.mock.calls.map((c) => c[1]);
    expect(signals).not.toContain("SIGKILL"); // never lands on a recycled pgid
  });
});

function fakeLiveness(dyingAfterPolls: Record<number, number>) {
  let polls = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    isAlive: (pid: number) => (dyingAfterPolls[pid] ?? -1) > polls,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      polls += 1;
    },
  };
}

describe("pollPidsUntilGone", () => {
  it("returns nothing and never sleeps when every pid is dead on entry", async () => {
    const table = fakeLiveness({});

    const holdouts = await pollPidsUntilGone([101, 102], {
      ...table,
      timeoutMs: 500,
      pollIntervalMs: 100,
    });

    expect(holdouts).toEqual([]);
    expect(table.sleeps).toEqual([]);
  });

  it("returns after one interval when the pid exits promptly", async () => {
    const table = fakeLiveness({ 101: 1 });

    const holdouts = await pollPidsUntilGone([101], {
      ...table,
      timeoutMs: 500,
      pollIntervalMs: 100,
    });

    expect(holdouts).toEqual([]);
    expect(table.sleeps).toEqual([100]);
  });

  it("burns exactly ceil(timeoutMs/pollIntervalMs) sleeps on a holdout, then reports it", async () => {
    const table = fakeLiveness({ 101: Infinity });

    const holdouts = await pollPidsUntilGone([101], {
      ...table,
      timeoutMs: 250,
      pollIntervalMs: 100,
    });

    expect(holdouts).toEqual([101]);
    expect(table.sleeps).toEqual([100, 100, 100]);
  });

  it("defaults the probe to pidIsAlive over process.kill", async () => {
    killSpy.mockImplementation(() => {
      throw errnoError("ESRCH");
    });
    const sleeps: number[] = [];

    const holdouts = await pollPidsUntilGone([12345], {
      timeoutMs: 100,
      pollIntervalMs: 100,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(holdouts).toEqual([]);
    expect(sleeps).toEqual([]);
    expect(killSpy).toHaveBeenCalledWith(12345, 0);
  });
});
