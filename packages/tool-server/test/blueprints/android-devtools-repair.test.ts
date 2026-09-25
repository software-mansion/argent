// `am instrument` exits 1 for every refusal and writes its reason to STDOUT, so
// the status block is both the only diagnosis an agent gets and the only thing
// telling a helper the device lost apart from a fault a reinstall cannot fix.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FAILURE_CODES, getFailureSignal, type DeviceInfo } from "@argent/registry";

/** One `am instrument` run: what the device prints, and how the process ends. */
interface AmRun {
  stdout?: string[];
  stderr?: string;
  /** Omit for a run that stays alive — the ready path. */
  exit?: { code: number };
  /** Leave the pipes open after the exit, as a grandchild holding stdout does. */
  keepPipesOpen?: boolean;
}

class FakeProc extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);
}

const queued: AmRun[] = [];
const spawned: FakeProc[] = [];
let lastRun: AmRun = {};
const adbCalls: string[][] = [];
let installFails: string | null = null;

// `exit` fires with the output still buffered and `close` only once the reader
// has drained it — node's own ordering, and why the blueprint settles on close.
function spawnFake(): FakeProc {
  const run = queued.shift() ?? lastRun;
  lastRun = run;
  const proc = new FakeProc();
  spawned.push(proc);
  setImmediate(() => {
    if (!run.exit) {
      for (const line of run.stdout ?? []) proc.stdout.write(`${line}\n`);
      return;
    }
    proc.emit("exit", run.exit.code, null);
    for (const line of run.stdout ?? []) proc.stdout.write(`${line}\n`);
    if (run.stderr) proc.stderr.write(run.stderr);
    if (run.keepPipesOpen) return;
    proc.stdout.end();
    proc.stderr.end();
    proc.stdout.on("end", () => setImmediate(() => proc.emit("close", run.exit!.code, null)));
  });
  return proc;
}

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: () => spawnFake() };
});

vi.mock("../../src/utils/adb", () => {
  const runAdb = vi.fn(async (args: string[]) => {
    adbCalls.push(args);
    if (args.includes("forward")) return { stdout: "45678\n", stderr: "" };
    if (args.includes("install") && installFails) throw new Error(installFails);
    return { stdout: "", stderr: "" };
  });
  return {
    runAdb,
    // Goes through runAdb above, as the real one does.
    adbForward: vi.fn(async (serial: string, hostPort: number, devicePort: number) => {
      const { stdout } = await runAdb([
        "-s",
        serial,
        "forward",
        `tcp:${hostPort}`,
        `tcp:${devicePort}`,
      ]);
      return stdout.trim();
    }),
    // The probe reports the bundled build as present, so every install here is
    // one the repair path forced.
    adbShell: vi.fn(async () => "package:com.argent.androiddevtools versionCode:1\n"),
  };
});

vi.mock("../../src/utils/android-binary", () => ({
  resolveAndroidBinary: vi.fn(async () => "/usr/bin/adb"),
}));

// The bundled APK is built by a gradle step CI does not run.
vi.mock("@argent/native-devtools-android", () => ({
  helperManifest: () => ({
    packageName: "com.argent.androiddevtools",
    instrumentationRunner: "com.argent.androiddevtools/.SnapshotInstrumentation",
    versionName: "0.1.0",
    versionCode: 1,
    installFlags: ["-r", "-t"],
  }),
  bundledHelperApkPath: () => "/tmp/argent-android-devtools.apk",
}));

vi.mock("../../src/utils/android-devtools-client", () => ({
  connectAndroidDevtoolsClient: vi.fn(async () => ({
    request: vi.fn(async () => ({ ok: true })),
    close: vi.fn(),
  })),
}));

import {
  androidDevtoolsBlueprint,
  classifyHelperSpawnFault,
} from "../../src/blueprints/android-devtools";

const DEVICE: DeviceInfo = { id: "emulator-5554", platform: "android", kind: "emulator" };

const MISSING: AmRun = {
  stdout: [
    "INSTRUMENTATION_STATUS: Error=Unable to find instrumentation info for: ComponentInfo{com.argent.androiddevtools/.SnapshotInstrumentation}",
    "INSTRUMENTATION_STATUS_CODE: -1",
    "android.util.AndroidException: INSTRUMENTATION_FAILED: com.argent.androiddevtools",
    "\tat com.android.commands.am.Instrument.run(Instrument.java:521)",
  ],
  exit: { code: 1 },
};
const READY: AmRun = { stdout: ["INSTRUMENTATION_STATUS: port=41000"] };

function installs(): string[][] {
  return adbCalls.filter((args) => args.includes("install"));
}

async function start() {
  return androidDevtoolsBlueprint.factory({}, DEVICE, { device: DEVICE });
}

beforeEach(() => {
  queued.length = 0;
  spawned.length = 0;
  adbCalls.length = 0;
  lastRun = {};
  installFails = null;
});

describe("classifyHelperSpawnFault", () => {
  it("reads the device's missing-instrumentation wording, in both spellings", () => {
    expect(classifyHelperSpawnFault("Error=Unable to find instrumentation info for: x")).toBe(
      "instrumentation-missing"
    );
    expect(classifyHelperSpawnFault("Error=Unable to find instrumentation target package: x")).toBe(
      "instrumentation-missing"
    );
  });

  it("classifies anything else as unknown, so it is never reinstalled over", () => {
    expect(classifyHelperSpawnFault("")).toBe("unknown");
    expect(classifyHelperSpawnFault("Error=Permission Denial")).toBe("unknown");
    // The stderr stack of EVERY refusal opens with this line.
    expect(classifyHelperSpawnFault("android.util.AndroidException: INSTRUMENTATION_FAILED:")).toBe(
      "unknown"
    );
  });
});

describe("android-devtools helper repair", () => {
  it("reinstalls once and starts when the device says the instrumentation is missing", async () => {
    queued.push(MISSING, READY);

    const instance = await start();

    expect(instance.api.isReady()).toBe(true);
    expect(spawned).toHaveLength(2);
    // `-d` so the reinstall may go backwards over a foreign same-version build.
    expect(installs()).toEqual([
      ["-s", "emulator-5554", "install", "-r", "-t", "-d", "/tmp/argent-android-devtools.apk"],
    ]);

    await instance.dispose();
  });

  it("quotes the device's own reason and drops the stack that follows it", async () => {
    queued.push(MISSING);

    const err = await start().catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.ANDROID_DEVTOOLS_HELPER_REPAIR_FAILED
    );
    expect((err as Error).message).toContain("Error=Unable to find instrumentation info");
    // Neither the stack, nor the status code and exit code that name nothing,
    // nor a command telling the reader to go and fetch the reason just quoted.
    expect((err as Error).message).not.toContain("Instrument.java:521");
    expect((err as Error).message).not.toContain("STATUS_CODE");
    expect((err as Error).message).not.toContain("code=1");
    expect((err as Error).message).not.toContain("adb -s emulator-5554 shell am instrument");
    expect(installs()).toHaveLength(1);
  });

  // The adb server adb forks on first use can hold stdout open, so `close`
  // never comes; settling from `exit` after a short grace keeps that run from
  // waiting out the 30 s ready timeout and rejecting as an unclassified one.
  it("settles from the exit, with the status intact, when the pipes stay open", async () => {
    queued.push({
      stdout: ["INSTRUMENTATION_STATUS: Error=Permission Denial"],
      exit: { code: 1 },
      keepPipesOpen: true,
    });
    const started = Date.now();

    const err = await start().catch((e: unknown) => e);

    expect(Date.now() - started).toBeLessThan(1_000);
    expect((err as Error).message).toContain("Error=Permission Denial");
  });

  it("does not reinstall for a fault a reinstall cannot fix", async () => {
    queued.push({
      stdout: ["INSTRUMENTATION_STATUS: Error=Permission Denial"],
      stderr: "java.lang.SecurityException: not allowed",
      exit: { code: 1 },
    });

    const err = await start().catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.ANDROID_DEVTOOLS_HELPER_EXITED_BEFORE_READY
    );
    expect(spawned).toHaveLength(1);
    expect(installs()).toHaveLength(0);
  });

  it("reports an install that fails, without spawning a second time", async () => {
    queued.push(MISSING);
    // The shape runAdb throws: the whole argv, including the APK's absolute
    // path, ahead of what adb actually said.
    installFails =
      "adb -s emulator-5554 install -r -t /Users/dev/argent/packages/native-devtools-android/bin/" +
      "argent-android-devtools-0.1.0.apk failed: adb: failed to install argent-android-devtools-0.1.0.apk: " +
      "Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]";

    const err = await start().catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.ANDROID_DEVTOOLS_HELPER_INSTALL_FAILED
    );
    // The failure code survives the cap, and the argv is gone.
    expect((err as Error).message).toContain("Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]");
    expect((err as Error).message).not.toContain("/Users/dev/argent");
    expect(spawned).toHaveLength(1);
  });
});
