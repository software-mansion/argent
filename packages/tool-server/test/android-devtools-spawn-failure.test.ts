// `am instrument` exits 1 for every refusal and writes its reason to STDOUT, so
// the status block is both the only diagnosis an agent gets and the only thing
// telling a missing helper apart from a fault a reinstall cannot fix.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceInfo } from "@argent/registry";
import { fakeAmInstrument } from "./helpers/fake-am-instrument";

const am = fakeAmInstrument();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: () => am.spawn() };
});

vi.mock("../src/utils/adb", () => ({
  runAdb: vi.fn(async () => ({ stdout: "45678\n", stderr: "" })),
  adbShell: vi.fn(async () => "package:com.argent.androiddevtools versionCode:1\n"),
}));

vi.mock("../src/utils/android-binary", () => ({
  resolveAndroidBinary: vi.fn(async () => "/usr/bin/adb"),
}));

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

import {
  androidDevtoolsBlueprint,
  classifyHelperSpawnFault,
} from "../src/blueprints/android-devtools";
import {
  __resetAndroidDevtoolsInstallCache,
  __setHelperAttemptCooldownForTesting,
} from "../src/utils/android-helper-install";

const DEVICE: DeviceInfo = { id: "emulator-5554", platform: "android", kind: "emulator" };

async function spawnFailureMessage(run: Parameters<typeof am.queue>[0]): Promise<string> {
  am.queue(run);
  const err = await androidDevtoolsBlueprint
    .factory({}, DEVICE, { device: DEVICE })
    .catch((e: unknown) => e);
  return (err as Error).message;
}

beforeEach(() => {
  am.spawned.length = 0;
  __resetAndroidDevtoolsInstallCache();
  __setHelperAttemptCooldownForTesting(0);
});

describe("classifyHelperSpawnFault", () => {
  it("reads the device's missing-instrumentation wording, in both spellings", () => {
    expect(
      classifyHelperSpawnFault(
        "INSTRUMENTATION_STATUS: Error=Unable to find instrumentation info for: ComponentInfo{com.argent.androiddevtools/.SnapshotInstrumentation}"
      )
    ).toBe("instrumentation-missing");
    expect(
      classifyHelperSpawnFault("Error=Unable to find instrumentation target package: com.argent")
    ).toBe("instrumentation-missing");
  });

  it("classifies anything else as unknown, so it is never reinstalled over", () => {
    expect(classifyHelperSpawnFault("")).toBe("unknown");
    expect(classifyHelperSpawnFault("INSTRUMENTATION_STATUS_CODE: -1")).toBe("unknown");
    expect(classifyHelperSpawnFault("java.lang.SecurityException: not allowed")).toBe("unknown");
    // The stderr stack of EVERY refusal opens with this line; reading it as a
    // missing package would reinstall over faults a reinstall cannot fix.
    expect(
      classifyHelperSpawnFault(
        "android.util.AndroidException: INSTRUMENTATION_FAILED: com.argent.androiddevtools/.SnapshotInstrumentation"
      )
    ).toBe("unknown");
  });
});

describe("am instrument failure reporting", () => {
  it("quotes the status block and drops the stack that follows it", async () => {
    const message = await spawnFailureMessage({
      stdout: [
        "INSTRUMENTATION_STATUS: Error=Unable to find instrumentation info for: ComponentInfo{com.argent.androiddevtools/.SnapshotInstrumentation}",
        "INSTRUMENTATION_STATUS_CODE: -1",
        "android.util.AndroidException: INSTRUMENTATION_FAILED: com.argent.androiddevtools/.SnapshotInstrumentation",
        "\tat com.android.commands.am.Instrument.run(Instrument.java:521)",
        "\tat com.android.commands.am.Am.onRun(Am.java:81)",
      ],
      exit: { code: 1 },
    });

    expect(message).toContain("Error=Unable to find instrumentation info");
    expect(message).toContain("INSTRUMENTATION_STATUS_CODE: -1");
    expect(message).not.toContain("Instrument.java:521");
  });

  // The adb server adb forks on first use can inherit stdout and hold it open,
  // so `close` never comes. Settling from `exit` after a short grace keeps that
  // run from waiting out the 30 s ready timeout — and from rejecting as a
  // timeout, which the repair path cannot classify.
  it("settles from the exit when the pipes stay open", async () => {
    const started = Date.now();
    const message = await spawnFailureMessage({
      stdout: ["INSTRUMENTATION_STATUS_CODE: -1"],
      exit: { code: 1 },
      keepPipesOpen: true,
    });

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(message).toContain("INSTRUMENTATION_STATUS_CODE: -1");
  });

  it("falls back to the stderr tail only when the device printed no status", async () => {
    const withStatus = await spawnFailureMessage({
      stdout: ["INSTRUMENTATION_STATUS_CODE: -1"],
      stderr: "adb: device offline",
      exit: { code: 1 },
    });
    expect(withStatus).toContain("INSTRUMENTATION_STATUS_CODE: -1");
    expect(withStatus).not.toContain("stderr=");

    const withoutStatus = await spawnFailureMessage({
      stderr: "adb: device offline",
      exit: { code: 1 },
    });
    expect(withoutStatus).toContain("stderr=adb: device offline");
  });
});
