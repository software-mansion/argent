import { describe, it, expect, vi } from "vitest";

// Records every child_process invocation the profiler makes so the test can
// assert how the (attacker-influenced) udid is passed and how stdout is buffered.
const rec = vi.hoisted(() => ({
  calls: [] as {
    fn: string;
    file: string;
    args: string[];
    options?: { maxBuffer?: number; input?: string };
  }[],
}));

vi.mock("child_process", () => ({
  execFileSync: (
    file: string,
    args: string[],
    options?: { maxBuffer?: number; input?: string }
  ) => {
    rec.calls.push({ fn: "execFileSync", file, args, options });
    if (args.includes("launchctl")) {
      // `launchctl list` output: PID, status, label.
      return "123\t0\tUIKitApplication:com.example.app[abc]\n";
    }
    if (args.includes("listapps")) {
      return "(opaque simctl plist)";
    }
    if (args[0] === "-convert") {
      // plutil JSON of installed apps, keyed arbitrarily.
      return JSON.stringify({
        "com.example.app": {
          CFBundleExecutable: "Example",
          CFBundleIdentifier: "com.example.app",
          ApplicationType: "User",
        },
      });
    }
    return "";
  },
  // A regression back to shell interpolation would route the command (with the
  // udid baked into the string) through execSync — make that fail loudly.
  execSync: (cmd: string) => {
    rec.calls.push({ fn: "execSync", file: String(cmd), args: [] });
    throw new Error(`execSync must not be used here (shell-injection risk): ${cmd}`);
  },
  spawn: () => {
    throw new Error("spawn not expected in this test");
  },
  // `ios.ts` transitively imports `ios-physical-device`, which does
  // `promisify(execFile)` at module load — so the mock must expose an `execFile`
  // function or the import throws. None of the physical-device paths run in this
  // shell-injection test, so calling it is a bug; fail loudly like `spawn`.
  execFile: () => {
    throw new Error("execFile not expected in this test");
  },
}));

import { enumerateRunningUserApps } from "../src/tools/profiler/native-profiler/platforms/ios";
import { DEFAULT_EXEC_MAX_BUFFER } from "../src/utils/ios-profiler/run-with-timeout";
import { deviceStrategy } from "../src/utils/ios-profiler/capture-strategy/device";

const VALID_UDID = "6DBF83B4-1A2B-4C3D-9E4F-0123456789AB";

describe("native iOS profiler: device_id shell-injection guard", () => {
  it("passes a hostile udid only as a discrete argv element (never via a shell)", () => {
    rec.calls.length = 0;
    const hostileUdid = 'booted"; touch /tmp/argent-pwned #';

    const apps = enumerateRunningUserApps(hostileUdid);
    expect(apps).toHaveLength(1);

    // No shell-interpreted execSync was used at all.
    expect(rec.calls.every((c) => c.fn === "execFileSync")).toBe(true);

    // simctl was invoked with the udid as an exact, standalone argv element —
    // not concatenated into a command string a shell could parse.
    const simctlCalls = rec.calls.filter((c) => c.args.includes("simctl"));
    expect(simctlCalls.length).toBeGreaterThanOrEqual(2);
    for (const c of simctlCalls) {
      expect(c.file).toBe("xcrun");
      expect(c.args).toContain(hostileUdid);
    }
  });

  it("captures each stage's stdout with a raised maxBuffer (no ENOBUFS on large output)", () => {
    // Splitting the old `simctl listapps | plutil` shell pipe into two
    // in-process execFileSync stages means Node — not the OS — buffers each
    // stdout. Without an explicit maxBuffer each stage inherits Node's 1 MiB
    // default and a large `listapps` (many installed apps) throws ENOBUFS,
    // surfaced as NATIVE_PROFILER_APP_LIST_FAILED. Every stage must lift the
    // cap to run-with-timeout.ts's 256 MiB.
    rec.calls.length = 0;
    enumerateRunningUserApps(VALID_UDID);

    const captures = rec.calls.filter((c) => c.fn === "execFileSync");
    expect(captures.length).toBeGreaterThanOrEqual(3); // launchctl, listapps, plutil
    for (const c of captures) {
      expect(c.options?.maxBuffer).toBe(DEFAULT_EXEC_MAX_BUFFER);
    }
  });

  it("feeds simctl listapps output to plutil over stdin (in-code pipe, not /bin/sh)", () => {
    // The old `simctl listapps | plutil` relied on /bin/sh to wire the pipe.
    // The replacement pipes in code: stage 1's stdout is handed to stage 2 via
    // execFileSync's `input`, and `--` stops plutil option parsing so the
    // trailing `-` (read-stdin) can never be taken for a flag. Guard both so a
    // refactor can't quietly drop the stdin feed or the `--` and re-open a gap.
    rec.calls.length = 0;
    enumerateRunningUserApps(VALID_UDID);

    const listapps = rec.calls.find((c) => c.args.includes("listapps"));
    const plutil = rec.calls.find((c) => c.file === "plutil");
    expect(listapps).toBeDefined();
    expect(plutil).toBeDefined();
    // Stage 2 receives stage 1's stdout via stdin (the mocked listapps returns
    // "(opaque simctl plist)"), never on the argv or via a shell.
    expect(plutil?.options?.input).toBe("(opaque simctl plist)");
    const dashIdx = plutil?.args.indexOf("--") ?? -1;
    expect(dashIdx).toBeGreaterThanOrEqual(0);
    expect(plutil?.args[dashIdx + 1]).toBe("-");
  });
});

describe("native iOS profiler: record-args device_id argv safety", () => {
  it("places a hostile device_id as an exact standalone argv element after --device", () => {
    // The record path (`xctrace record --device <deviceId> …`, spawned as argv)
    // is where device_id — the input this fix is named for — reaches a
    // subprocess. It is argv-safe by construction today (no shell), and the
    // anchored UDID classifier keeps a metacharacter payload off the iOS path
    // entirely; assert the token discipline anyway so a future {shell:true} or
    // arg-fusion regression on the primary attacker input lights up.
    const hostileDeviceId = 'booted"; touch /tmp/argent-pwned #';
    const args = deviceStrategy.buildRecordArgs({
      templatePath: "/tmp/Argent.tracetemplate",
      deviceId: hostileDeviceId,
      target: { executable: "Example", pid: 1234 },
      outputFile: "/tmp/out.trace",
    });

    const deviceIdx = args.indexOf("--device");
    expect(deviceIdx).toBeGreaterThanOrEqual(0);
    expect(args[deviceIdx + 1]).toBe(hostileDeviceId);
    // Exactly one element equals the value, and no other element embeds it —
    // i.e. it was never fused with its flag or a neighbouring token.
    expect(args.filter((a) => a === hostileDeviceId)).toHaveLength(1);
    expect(args.some((a) => a !== hostileDeviceId && a.includes(hostileDeviceId))).toBe(false);
  });
});
