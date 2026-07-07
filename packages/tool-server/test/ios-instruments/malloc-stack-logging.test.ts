import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import type { NativeProfilerSessionApi } from "../../src/blueprints/native-profiler-session";

// Exercises the malloc_stack_logging launch path in startNativeProfilerIos
// directly (no blueprint/native-devtools imports) so we can assert the exact
// xctrace argv. Default mode must still `--attach`; malloc_stack_logging mode
// must cold-`--launch` the resolved .app with `--env MallocStackLogging=1`.

class StartFakeChild extends EventEmitter {
  pid = 4242;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

const LISTAPPS_JSON = JSON.stringify({
  "com.example.myapp": {
    CFBundleExecutable: "MyApp",
    CFBundleIdentifier: "com.example.myapp",
    ApplicationType: "User",
  },
});

function fakeApi(): NativeProfilerSessionApi {
  return {
    deviceId: "DEVICE-UDID",
    platform: "ios",
    appProcess: null,
    capturePid: null,
    captureProcess: null,
    cpuFilterPid: null,
    traceFile: null,
    exportedFiles: null,
    profilingActive: false,
    wallClockStartMs: null,
    parsedData: null,
    recordingTimeout: null,
    recordingTimedOut: false,
    recordingExitedUnexpectedly: false,
    lastExitInfo: null,
    androidOnDeviceTracePath: null,
  };
}

// Every simctl/xcode subprocess the profiler runs goes through execFileSync (discrete
// argv, shell-injection-hardened) — launchctl and `xcodebuild -version` included, since
// the capture-strategy selector reads the Xcode version the same hardened way. So the
// mock keys off the bin/argv rather than a command string. `simctl listapps` returns a
// plist that `plutil` converts to JSON; `xcodebuild` defaults to unmocked ("") so the
// version reads as undetermined unless a caller opts in via the `xcodebuild` option.
interface ExecFileSyncOpts {
  maxBuffer?: number;
  input?: string;
  encoding?: string;
  timeout?: number;
}
function makeExecFileSyncFn(opts?: { xcodebuild?: string }) {
  return vi.fn((bin: string, args: string[] = [], _opts?: ExecFileSyncOpts) => {
    if (bin === "xcodebuild") return opts?.xcodebuild ?? ""; // capture-strategy reads `xcodebuild -version`
    if (bin === "plutil") return LISTAPPS_JSON; // plutil converts the listapps plist to JSON
    if (args.includes("listapps")) return "<plist/>"; // raw plist, piped into plutil
    if (args.includes("launchctl"))
      return "1\t0\tUIKitApplication:com.example.myapp[abcd][rb-legacy]\n"; // `simctl spawn <udid> launchctl list`
    if (args.includes("get_app_container")) return "/Users/x/Library/.../MyApp.app\n";
    if (args.includes("terminate")) return "";
    return "";
  });
}

function mockChildProcess() {
  const spawnFn = vi.fn(() => new StartFakeChild());
  // Nothing routes through execSync anymore (launchctl/xcodebuild are hardened to
  // execFileSync); keep a stub so a stray call no-ops rather than crashing.
  const execSyncFn = vi.fn(() => "");
  const execFileSyncFn = makeExecFileSyncFn();
  return { spawnFn, execSyncFn, execFileSyncFn };
}

async function importStart() {
  const mod = await import("../../src/tools/profiler/native-profiler/platforms/ios");
  return mod.startNativeProfilerIos;
}

describe("native-profiler-start malloc_stack_logging", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("child_process");
    vi.doUnmock("../../src/utils/react-profiler/debug/dump");
    vi.doUnmock("../../src/utils/ios-profiler/notify");
    vi.doUnmock("../../src/utils/ios-profiler/startup");
  });

  function applyCommonMocks(spawnFn: unknown, execSyncFn: unknown, execFileSyncFn: unknown) {
    vi.doMock("child_process", () => ({
      spawn: spawnFn,
      execSync: execSyncFn,
      execFile: vi.fn(),
      execFileSync: execFileSyncFn,
    }));
    vi.doMock("../../src/utils/react-profiler/debug/dump", () => ({
      getDebugDir: vi.fn(async () => "/tmp/argent-profiler-cwd"),
    }));
    vi.doMock("../../src/utils/ios-profiler/notify", () => ({
      listenForDarwinNotification: vi.fn(() => {
        throw new Error("notifyutil unavailable in tests");
      }),
    }));
    vi.doMock("../../src/utils/ios-profiler/startup", () => ({
      waitForXctraceReady: vi.fn(async () => ({ stderrBuffer: "" })),
    }));
  }

  it("cold-launches the .app with MallocStackLogging when malloc_stack_logging is true", async () => {
    const { spawnFn, execSyncFn, execFileSyncFn } = mockChildProcess();
    applyCommonMocks(spawnFn, execSyncFn, execFileSyncFn);

    const startNativeProfilerIos = await importStart();
    const api = fakeApi();
    const result = await startNativeProfilerIos(api, {
      device_id: "DEVICE-UDID",
      app_process: "MyApp",
      malloc_stack_logging: true,
    });

    expect(result.status).toBe("recording");
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [bin, args] = spawnFn.mock.calls[0] as unknown as [string, string[]];
    expect(bin).toBe("xctrace");

    // launch + env, not attach
    expect(args).toContain("--launch");
    expect(args).toContain("--env");
    expect(args[args.indexOf("--env") + 1]).toBe("MallocStackLogging=1");
    expect(args).not.toContain("--attach");
    // --device with the correct udid is the whole premise of the degraded-Xcode
    // guard (the cold launch can only run on the device path), so assert it is
    // present and threaded through — a regression that dropped it or passed the
    // wrong device would otherwise slip past.
    expect(args).toContain("--device");
    expect(args[args.indexOf("--device") + 1]).toBe("DEVICE-UDID");
    // the launched target is the resolved .app bundle, and must be the LAST args
    // (everything after `--` is the launched command).
    const dashIdx = args.indexOf("--");
    expect(dashIdx).toBeGreaterThan(args.indexOf("--launch"));
    expect(args[dashIdx + 1]).toBe("/Users/x/Library/.../MyApp.app");
    expect(dashIdx + 1).toBe(args.length - 1);

    // the running instance is terminated first for a clean cold start
    const efsArgs = execFileSyncFn.mock.calls.map((c) => (c[1] as string[]) ?? []);
    expect(efsArgs.some((a) => a.includes("terminate") && a.includes("com.example.myapp"))).toBe(
      true
    );
    expect(efsArgs.some((a) => a.includes("get_app_container"))).toBe(true);
  });

  it("captures the listapps plist with a large buffer so a big simulator can't overflow it", async () => {
    // getInstalledApps buffers the FULL plist into Node (it's larger than the JSON
    // plutil emits), so the listapps capture must raise maxBuffer well above Node's
    // 1 MiB default — otherwise a well-populated simulator throws ENOBUFS where the
    // old shell pipe (which only buffered the smaller JSON) worked.
    const { spawnFn, execSyncFn, execFileSyncFn } = mockChildProcess();
    applyCommonMocks(spawnFn, execSyncFn, execFileSyncFn);

    const startNativeProfilerIos = await importStart();
    const api = fakeApi();
    await startNativeProfilerIos(api, {
      device_id: "DEVICE-UDID",
      app_process: "MyApp",
      malloc_stack_logging: true,
    });

    const listappsCall = execFileSyncFn.mock.calls.find(
      (c) => Array.isArray(c[1]) && c[1].includes("listapps")
    );
    expect(listappsCall).toBeTruthy();
    expect(listappsCall?.[2]?.maxBuffer).toBeGreaterThan(8 * 1024 * 1024);
  });

  it("does not terminate the app if the debug dir can't be created (malloc mode)", async () => {
    // getDebugDir()'s mkdir runs BEFORE the terminate, so a failure (e.g. ENOSPC)
    // must leave the running app untouched — never killed-without-relaunch.
    const { spawnFn, execSyncFn, execFileSyncFn } = mockChildProcess();
    vi.doMock("child_process", () => ({
      spawn: spawnFn,
      execSync: execSyncFn,
      execFile: vi.fn(),
      execFileSync: execFileSyncFn,
    }));
    vi.doMock("../../src/utils/react-profiler/debug/dump", () => ({
      getDebugDir: vi.fn(async () => {
        throw new Error("ENOSPC: no space left on device");
      }),
    }));
    vi.doMock("../../src/utils/ios-profiler/notify", () => ({
      listenForDarwinNotification: vi.fn(() => {
        throw new Error("notifyutil unavailable in tests");
      }),
    }));
    vi.doMock("../../src/utils/ios-profiler/startup", () => ({
      waitForXctraceReady: vi.fn(async () => ({ stderrBuffer: "" })),
    }));

    const startNativeProfilerIos = await importStart();
    const api = fakeApi();
    await expect(
      startNativeProfilerIos(api, {
        device_id: "DEVICE-UDID",
        app_process: "MyApp",
        malloc_stack_logging: true,
      })
    ).rejects.toThrow(/ENOSPC/);

    const efsArgs = execFileSyncFn.mock.calls.map((c) => (c[1] as string[]) ?? []);
    expect(efsArgs.some((a) => a.includes("terminate"))).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("does not terminate the app if the .app bundle path can't be resolved (malloc mode)", async () => {
    // getAppBundlePath (simctl get_app_container) runs BEFORE the destructive terminate,
    // exactly like the debug-dir mkdir guard above — so a failed container resolution must
    // leave the running app untouched, never killed-without-relaunch. Also pins the
    // FailureError code so a reachable user-facing failure stays telemetry-classified.
    const prev = process.env.ARGENT_IOS_CAPTURE;
    delete process.env.ARGENT_IOS_CAPTURE;
    try {
      const spawnFn = vi.fn(() => new StartFakeChild());
      const execSyncFn = vi.fn(() => "");
      const execFileSyncFn = vi.fn((bin: string, args: string[] = []) => {
        // resolveAppForLaunch succeeds (valid listapps) so we reach getAppBundlePath...
        if (bin === "plutil") return LISTAPPS_JSON;
        if (args.includes("listapps")) return "<plist/>";
        // ...where get_app_container fails BEFORE any terminate.
        if (args.includes("get_app_container")) throw new Error("No such file or directory");
        if (args.includes("terminate")) return "";
        return "";
      });
      applyCommonMocks(spawnFn, execSyncFn, execFileSyncFn);

      const startNativeProfilerIos = await importStart();
      const api = fakeApi();
      const err = await startNativeProfilerIos(api, {
        device_id: "DEVICE-UDID",
        app_process: "MyApp",
        malloc_stack_logging: true,
      }).then(
        () => null,
        (e: unknown) => e
      );

      expect(err).toBeTruthy();
      expect(getFailureSignal(err)?.error_code).toBe(
        FAILURE_CODES.NATIVE_PROFILER_APP_BUNDLE_PATH_FAILED
      );
      // Bundle-path resolution failed BEFORE the destructive terminate → app untouched.
      const efsArgs = execFileSyncFn.mock.calls.map((c) => (c[1] as string[]) ?? []);
      expect(efsArgs.some((a) => a.includes("terminate"))).toBe(false);
      expect(spawnFn).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.ARGENT_IOS_CAPTURE;
      else process.env.ARGENT_IOS_CAPTURE = prev;
    }
  });

  it("rejects an empty resolved .app bundle path before terminating (malloc mode)", async () => {
    // simctl returning a blank container path must be refused up front (otherwise the argv
    // becomes `xctrace --launch -- ""`), and — like the throw case — before the terminate.
    const prev = process.env.ARGENT_IOS_CAPTURE;
    delete process.env.ARGENT_IOS_CAPTURE;
    try {
      const spawnFn = vi.fn(() => new StartFakeChild());
      const execSyncFn = vi.fn(() => "");
      const execFileSyncFn = vi.fn((bin: string, args: string[] = []) => {
        if (bin === "plutil") return LISTAPPS_JSON;
        if (args.includes("listapps")) return "<plist/>";
        // Whitespace-only container path → empty after the .trim() in getAppBundlePath.
        if (args.includes("get_app_container")) return "  \n";
        if (args.includes("terminate")) return "";
        return "";
      });
      applyCommonMocks(spawnFn, execSyncFn, execFileSyncFn);

      const startNativeProfilerIos = await importStart();
      const api = fakeApi();
      const err = await startNativeProfilerIos(api, {
        device_id: "DEVICE-UDID",
        app_process: "MyApp",
        malloc_stack_logging: true,
      }).then(
        () => null,
        (e: unknown) => e
      );

      expect(err).toBeTruthy();
      expect(getFailureSignal(err)?.error_code).toBe(
        FAILURE_CODES.NATIVE_PROFILER_APP_BUNDLE_PATH_FAILED
      );
      const efsArgs = execFileSyncFn.mock.calls.map((c) => (c[1] as string[]) ?? []);
      expect(efsArgs.some((a) => a.includes("terminate"))).toBe(false);
      expect(spawnFn).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.ARGENT_IOS_CAPTURE;
      else process.env.ARGENT_IOS_CAPTURE = prev;
    }
  });

  it("attaches (no launch/env) by default", async () => {
    const { spawnFn, execSyncFn, execFileSyncFn } = mockChildProcess();
    applyCommonMocks(spawnFn, execSyncFn, execFileSyncFn);

    const startNativeProfilerIos = await importStart();
    const api = fakeApi();
    await startNativeProfilerIos(api, {
      device_id: "DEVICE-UDID",
      app_process: "MyApp",
    });

    const [, args] = spawnFn.mock.calls[0] as unknown as [string, string[]];
    expect(args).toContain("--attach");
    // default mode attaches by host PID (Xcode 26.5 compat); the mock's launchctl yields pid 1
    expect(args[args.indexOf("--attach") + 1]).toBe("1");
    expect(args).not.toContain("--launch");
    expect(args).not.toContain("--env");
    // default attach mode never terminates the running app
    const efsArgs = execFileSyncFn.mock.calls.map((c) => (c[1] as string[]) ?? []);
    expect(efsArgs.some((a) => a.includes("terminate"))).toBe(false);
  });

  // A degraded Xcode (26.4 and later) is reported by `xcodebuild -version`, which the
  // capture-strategy selector reads. The malloc cold launch needs `--device`, which is
  // broken on those versions, so the start must be refused UP FRONT — before the running
  // app is terminated and before any xctrace spawn.
  function mockChildProcessDegraded() {
    const spawnFn = vi.fn(() => new StartFakeChild());
    const execSyncFn = vi.fn(() => "");
    // A degraded Xcode (26.4 and later) as reported by the hardened `xcodebuild -version`
    // read (execFileSync) that the capture-strategy selector performs.
    const execFileSyncFn = makeExecFileSyncFn({
      xcodebuild: "Xcode 26.5\nBuild version 17F42",
    });
    return { spawnFn, execSyncFn, execFileSyncFn };
  }

  it("refuses malloc_stack_logging on a degraded Xcode before terminating the app", async () => {
    const prev = process.env.ARGENT_IOS_CAPTURE;
    delete process.env.ARGENT_IOS_CAPTURE;
    // The guard must not first emit the "using the all-processes capture fallback"
    // stderr line (that fallback never runs here — the block throws instead), which
    // would read as though the fallback is about to run, directly followed by an abort.
    const stderrWrites: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stderrWrites.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
        return true;
      });
    try {
      const { spawnFn, execSyncFn, execFileSyncFn } = mockChildProcessDegraded();
      applyCommonMocks(spawnFn, execSyncFn, execFileSyncFn);

      const startNativeProfilerIos = await importStart();
      const api = fakeApi();
      const err = await startNativeProfilerIos(api, {
        device_id: "DEVICE-UDID",
        app_process: "MyApp",
        malloc_stack_logging: true,
      }).then(
        () => null,
        (e: unknown) => e
      );

      // It must fail, with the degraded-Xcode failure code (telemetry-classified).
      expect(err).toBeTruthy();
      expect(getFailureSignal(err)?.error_code).toBe(
        FAILURE_CODES.NATIVE_PROFILER_MALLOC_DEGRADED_XCODE
      );
      // And critically: it never touched the app or xctrace — no terminate, no
      // bundle-path resolution, no spawn. The app the user had running is intact.
      const efsArgs = execFileSyncFn.mock.calls.map((c) => (c[1] as string[]) ?? []);
      expect(efsArgs.some((a) => a.includes("terminate"))).toBe(false);
      expect(efsArgs.some((a) => a.includes("get_app_container"))).toBe(false);
      expect(spawnFn).not.toHaveBeenCalled();
      // No misleading "fallback is about to run" log preceded the refusal.
      expect(stderrWrites.some((w) => w.includes("capture fallback"))).toBe(false);
    } finally {
      stderrSpy.mockRestore();
      if (prev === undefined) delete process.env.ARGENT_IOS_CAPTURE;
      else process.env.ARGENT_IOS_CAPTURE = prev;
    }
  });

  it("ARGENT_IOS_CAPTURE=device forces the malloc cold launch through on a degraded Xcode", async () => {
    const prev = process.env.ARGENT_IOS_CAPTURE;
    process.env.ARGENT_IOS_CAPTURE = "device";
    try {
      const { spawnFn, execSyncFn, execFileSyncFn } = mockChildProcessDegraded();
      applyCommonMocks(spawnFn, execSyncFn, execFileSyncFn);

      const startNativeProfilerIos = await importStart();
      const api = fakeApi();
      const result = await startNativeProfilerIos(api, {
        device_id: "DEVICE-UDID",
        app_process: "MyApp",
        malloc_stack_logging: true,
      });

      // The override bypasses the guard, so the cold launch proceeds as usual.
      expect(result.status).toBe("recording");
      const [, args] = spawnFn.mock.calls[0] as unknown as [string, string[]];
      expect(args).toContain("--launch");
      expect(args).toContain("--env");
    } finally {
      if (prev === undefined) delete process.env.ARGENT_IOS_CAPTURE;
      else process.env.ARGENT_IOS_CAPTURE = prev;
    }
  });

  it("warns about an unrecognised ARGENT_IOS_CAPTURE in malloc mode instead of dropping it silently", async () => {
    // The malloc guard resolves the strategy via the side-effect-free resolver, so a
    // typo'd override would previously vanish without a word — unlike the normal record
    // flow, which warns. On a healthy Xcode the typo is ignored and malloc still runs,
    // but the user must be told their value was dropped (otherwise a later degraded-Xcode
    // refusal can even advise "set ARGENT_IOS_CAPTURE=device" while the typo sits ignored).
    const prev = process.env.ARGENT_IOS_CAPTURE;
    process.env.ARGENT_IOS_CAPTURE = "devise"; // typo for "device"
    const stderrWrites: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stderrWrites.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
        return true;
      });
    try {
      // Default mock leaves `xcodebuild` unmocked → version undetermined → device
      // strategy, so the guard proceeds (does not refuse) despite the bad override.
      const { spawnFn, execSyncFn, execFileSyncFn } = mockChildProcess();
      applyCommonMocks(spawnFn, execSyncFn, execFileSyncFn);

      const startNativeProfilerIos = await importStart();
      const api = fakeApi();
      const result = await startNativeProfilerIos(api, {
        device_id: "DEVICE-UDID",
        app_process: "MyApp",
        malloc_stack_logging: true,
      });

      // The typo neither blocks the healthy device path nor passes silently.
      expect(result.status).toBe("recording");
      expect(spawnFn).toHaveBeenCalledTimes(1);
      expect(
        stderrWrites.some((w) => w.includes('ignoring unrecognised ARGENT_IOS_CAPTURE="devise"'))
      ).toBe(true);
    } finally {
      stderrSpy.mockRestore();
      if (prev === undefined) delete process.env.ARGENT_IOS_CAPTURE;
      else process.env.ARGENT_IOS_CAPTURE = prev;
    }
  });

  it("best-effort relaunches the app when the malloc cold launch fails after terminate", async () => {
    const prev = process.env.ARGENT_IOS_CAPTURE;
    delete process.env.ARGENT_IOS_CAPTURE;
    try {
      const spawnFn = vi.fn(() => new StartFakeChild());
      // Nothing routes through execSync anymore (xcodebuild/listapps/launchctl are all
      // hardened to execFileSync); a bare stub is all that's needed.
      const execSyncFn = vi.fn(() => "");
      // A non-degraded Xcode, read via the hardened execFileSync `xcodebuild -version`
      // (NOT execSync), so the guard genuinely passes and the path reaches the cold
      // launch. terminate succeeds (empty return) → the app was running → relaunch armed.
      const execFileSyncFn = makeExecFileSyncFn({ xcodebuild: "Xcode 16.4\nBuild version 16F6" });
      vi.doMock("child_process", () => ({
        spawn: spawnFn,
        execSync: execSyncFn,
        execFile: vi.fn(),
        execFileSync: execFileSyncFn,
      }));
      vi.doMock("../../src/utils/react-profiler/debug/dump", () => ({
        getDebugDir: vi.fn(async () => "/tmp/argent-profiler-cwd"),
      }));
      vi.doMock("../../src/utils/ios-profiler/notify", () => ({
        listenForDarwinNotification: vi.fn(() => {
          throw new Error("notifyutil unavailable in tests");
        }),
      }));
      // Force the capture start to fail *after* the app has been terminated.
      vi.doMock("../../src/utils/ios-profiler/startup", () => ({
        waitForXctraceReady: vi.fn(async () => {
          throw new Error("xctrace exited before recording started");
        }),
      }));

      const startNativeProfilerIos = await importStart();
      const api = fakeApi();
      const err = await startNativeProfilerIos(api, {
        device_id: "DEVICE-UDID",
        app_process: "MyApp",
        malloc_stack_logging: true,
      }).then(
        () => null,
        (e: unknown) => e
      );

      // The start failed (error surfaced) AND the terminated app was relaunched.
      expect(err).toBeTruthy();
      const relaunch = execFileSyncFn.mock.calls.find(
        (c) => Array.isArray(c[1]) && (c[1] as string[]).includes("launch")
      );
      expect(relaunch).toBeTruthy();
      expect(relaunch![1]).toEqual(["simctl", "launch", "DEVICE-UDID", "com.example.myapp"]);
    } finally {
      if (prev === undefined) delete process.env.ARGENT_IOS_CAPTURE;
      else process.env.ARGENT_IOS_CAPTURE = prev;
    }
  });

  it("does NOT relaunch a not-running named app when the malloc cold launch fails", async () => {
    // resolveAppForLaunch accepts an installed-but-not-running app_process, so the
    // preceding `simctl terminate` is a no-op. A failed start must then NOT foreground
    // an app the user never had open — only an app we actually killed gets restored.
    const prev = process.env.ARGENT_IOS_CAPTURE;
    delete process.env.ARGENT_IOS_CAPTURE;
    try {
      const spawnFn = vi.fn(() => new StartFakeChild());
      const execSyncFn = vi.fn(() => "");
      const execFileSyncFn = vi.fn((bin: string, args: string[] = []) => {
        // Non-degraded Xcode (execFileSync `xcodebuild -version`) so the guard passes
        // and the path actually reaches app resolution + terminate.
        if (bin === "xcodebuild") return "Xcode 16.4\nBuild version 16F6";
        // getInstalledApps buffers the listapps plist and runs it through plutil → JSON,
        // so resolveAppForLaunch finds the installed-but-not-running MyApp and the path
        // REACHES terminate. Returning "" for listapps/plutil would make getInstalledApps
        // hit JSON.parse("") and throw SyntaxError before terminate ever ran — which is
        // exactly the illusory-coverage bug this test must avoid.
        if (bin === "plutil") return LISTAPPS_JSON;
        if (args.includes("listapps")) return "<plist/>";
        if (args.includes("get_app_container")) return "/Users/x/Library/.../MyApp.app\n";
        // Installed but NOT running → terminate fails exactly like real simctl does, so
        // mallocRelaunchBundleId is never armed.
        if (args.includes("terminate")) throw new Error("found nothing to terminate");
        return "";
      });
      vi.doMock("child_process", () => ({
        spawn: spawnFn,
        execSync: execSyncFn,
        execFile: vi.fn(),
        execFileSync: execFileSyncFn,
      }));
      vi.doMock("../../src/utils/react-profiler/debug/dump", () => ({
        getDebugDir: vi.fn(async () => "/tmp/argent-profiler-cwd"),
      }));
      vi.doMock("../../src/utils/ios-profiler/notify", () => ({
        listenForDarwinNotification: vi.fn(() => {
          throw new Error("notifyutil unavailable in tests");
        }),
      }));
      // Cold launch fails AFTER the (no-op) terminate.
      vi.doMock("../../src/utils/ios-profiler/startup", () => ({
        waitForXctraceReady: vi.fn(async () => {
          throw new Error("xctrace exited before recording started");
        }),
      }));

      const startNativeProfilerIos = await importStart();
      const api = fakeApi();
      const err = await startNativeProfilerIos(api, {
        device_id: "DEVICE-UDID",
        app_process: "MyApp",
        malloc_stack_logging: true,
      }).then(
        () => null,
        (e: unknown) => e
      );

      // The start failure still surfaces — and it is the cold-launch failure, NOT an
      // earlier resolution error. (With an empty listapps mock, getInstalledApps used to
      // throw "SyntaxError: Unexpected end of JSON input" before terminate ran, so the
      // no-op-terminate → no-relaunch scenario named here was never actually exercised.)
      expect(err).toBeTruthy();
      expect(err).not.toBeInstanceOf(SyntaxError);
      // The path genuinely reached the (no-op) terminate for the not-running app...
      const efsArgs = execFileSyncFn.mock.calls.map((c) => (c[1] as string[]) ?? []);
      expect(efsArgs.some((a) => a.includes("terminate"))).toBe(true);
      // ...but no best-effort relaunch fired, because we never actually killed it.
      const relaunched = execFileSyncFn.mock.calls.some(
        (c) => Array.isArray(c[1]) && (c[1] as string[]).includes("launch")
      );
      expect(relaunched).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.ARGENT_IOS_CAPTURE;
      else process.env.ARGENT_IOS_CAPTURE = prev;
    }
  });

  it("attributes the malloc refusal to a forced override, not a degraded Xcode, under ARGENT_IOS_CAPTURE=all-processes", async () => {
    // On a perfectly healthy Xcode, the only reason the strategy isn't `device` is
    // the forced override — so the refusal must say so (and carry a distinct code),
    // not blame a --device deadlock that isn't present.
    const prev = process.env.ARGENT_IOS_CAPTURE;
    process.env.ARGENT_IOS_CAPTURE = "all-processes";
    try {
      const spawnFn = vi.fn(() => new StartFakeChild());
      // ARGENT_IOS_CAPTURE=all-processes short-circuits before any `xcodebuild -version`
      // read, so the Xcode version is irrelevant here; execSync is unused (every
      // subprocess goes through execFileSync), so a bare stub suffices.
      const execSyncFn = vi.fn(() => "");
      const execFileSyncFn = makeExecFileSyncFn();
      applyCommonMocks(spawnFn, execSyncFn, execFileSyncFn);

      const startNativeProfilerIos = await importStart();
      const api = fakeApi();
      const err = await startNativeProfilerIos(api, {
        device_id: "DEVICE-UDID",
        app_process: "MyApp",
        malloc_stack_logging: true,
      }).then(
        () => null,
        (e: unknown) => e
      );

      expect(err).toBeTruthy();
      // Distinct telemetry code for the forced-override cause, not degraded-Xcode.
      expect(getFailureSignal(err)?.error_code).toBe(
        FAILURE_CODES.NATIVE_PROFILER_MALLOC_STRATEGY_OVERRIDE
      );
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain("ARGENT_IOS_CAPTURE");
      expect(msg).not.toMatch(/deadlock|26\.4/);
      // Refused up front — the healthy app is untouched.
      const efsArgs = execFileSyncFn.mock.calls.map((c) => (c[1] as string[]) ?? []);
      expect(efsArgs.some((a) => a.includes("terminate"))).toBe(false);
      expect(efsArgs.some((a) => a.includes("get_app_container"))).toBe(false);
      expect(spawnFn).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.ARGENT_IOS_CAPTURE;
      else process.env.ARGENT_IOS_CAPTURE = prev;
    }
  });

  it("throws LAUNCH_APP_NOT_FOUND when a malloc app_process matches no installed user app", async () => {
    const prev = process.env.ARGENT_IOS_CAPTURE;
    delete process.env.ARGENT_IOS_CAPTURE;
    try {
      // Default mock leaves `xcodebuild` unmocked → version undetermined → device
      // strategy, so the degraded-Xcode guard passes and we reach app resolution.
      const { spawnFn, execSyncFn, execFileSyncFn } = mockChildProcess();
      applyCommonMocks(spawnFn, execSyncFn, execFileSyncFn);

      const startNativeProfilerIos = await importStart();
      const api = fakeApi();
      const err = await startNativeProfilerIos(api, {
        device_id: "DEVICE-UDID",
        app_process: "GhostApp", // not present in LISTAPPS_JSON
        malloc_stack_logging: true,
      }).then(
        () => null,
        (e: unknown) => e
      );

      expect(err).toBeTruthy();
      expect(getFailureSignal(err)?.error_code).toBe(
        FAILURE_CODES.NATIVE_PROFILER_LAUNCH_APP_NOT_FOUND
      );
      // Resolution failed before any destructive/side-effecting action.
      const efsArgs = execFileSyncFn.mock.calls.map((c) => (c[1] as string[]) ?? []);
      expect(efsArgs.some((a) => a.includes("terminate"))).toBe(false);
      expect(efsArgs.some((a) => a.includes("get_app_container"))).toBe(false);
      expect(spawnFn).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.ARGENT_IOS_CAPTURE;
      else process.env.ARGENT_IOS_CAPTURE = prev;
    }
  });

  it("throws MULTIPLE_RUNNING_USER_APPS in malloc mode when no app_process and several apps run", async () => {
    const prev = process.env.ARGENT_IOS_CAPTURE;
    delete process.env.ARGENT_IOS_CAPTURE;
    try {
      const twoApps = JSON.stringify({
        "com.example.myapp": {
          CFBundleExecutable: "MyApp",
          CFBundleIdentifier: "com.example.myapp",
          ApplicationType: "User",
        },
        "com.example.other": {
          CFBundleExecutable: "OtherApp",
          CFBundleIdentifier: "com.example.other",
          ApplicationType: "User",
        },
      });
      const spawnFn = vi.fn(() => new StartFakeChild());
      const execSyncFn = vi.fn(() => "");
      // getInstalledApps resolves the installed set via execFileSync(listapps) piped
      // through plutil; the running set comes from execFileSync(launchctl list). Both the
      // two-app plist and the two running PIDs are delivered through the execFileSync mock.
      const execFileSyncFn = vi.fn((bin: string, args: string[] = []) => {
        if (bin === "plutil") return twoApps;
        if (args.includes("listapps")) return "<plist/>";
        if (args.includes("launchctl"))
          return (
            "1\t0\tUIKitApplication:com.example.myapp[a][rb]\n" +
            "2\t0\tUIKitApplication:com.example.other[b][rb]\n"
          );
        if (args.includes("get_app_container")) return "/Users/x/Library/.../MyApp.app\n";
        if (args.includes("terminate")) return "";
        return "";
      });
      applyCommonMocks(spawnFn, execSyncFn, execFileSyncFn);

      const startNativeProfilerIos = await importStart();
      const api = fakeApi();
      const err = await startNativeProfilerIos(api, {
        device_id: "DEVICE-UDID",
        malloc_stack_logging: true, // no app_process → auto-detect → ambiguous
      }).then(
        () => null,
        (e: unknown) => e
      );

      expect(err).toBeTruthy();
      expect(getFailureSignal(err)?.error_code).toBe(
        FAILURE_CODES.NATIVE_PROFILER_MULTIPLE_RUNNING_USER_APPS
      );
      const efsArgs = execFileSyncFn.mock.calls.map((c) => (c[1] as string[]) ?? []);
      expect(efsArgs.some((a) => a.includes("terminate"))).toBe(false);
      expect(spawnFn).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.ARGENT_IOS_CAPTURE;
      else process.env.ARGENT_IOS_CAPTURE = prev;
    }
  });
});
