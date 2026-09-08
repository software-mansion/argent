import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DeviceInfo } from "@argent/registry";

const execFileMock = vi.fn();

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
      const callback = typeof opts === "function" ? opts : cb!;
      const options = typeof opts === "function" ? undefined : opts;
      const result = execFileMock(cmd, args, options);
      if (result instanceof Error) callback(result, { stdout: "", stderr: "" });
      else callback(null, result ?? { stdout: "", stderr: "" });
    },
  };
});

/**
 * iOS argv goes through `simctlArgsForUdid`, which resolves the device set the
 * UDID lives in and probes with `simctl list` when extra sets are configured.
 * That would make the spawn counts below depend on the developer's own
 * `ios.additionalDeviceSets`, so pin the config: no extra sets, no probe. The
 * `--set`-scoped spelling is covered in ios-device-sets' own tests.
 */
vi.mock("@argent/configuration-core", async () => {
  const actual = await vi.importActual<typeof import("@argent/configuration-core")>(
    "@argent/configuration-core"
  );
  return { ...actual, getAdditionalIosDeviceSets: () => [] };
});

vi.mock("../src/utils/android-binary", () => ({
  resolveAndroidBinary: vi.fn(async (name: "adb" | "emulator") => name),
  __resetAndroidBinaryCacheForTesting: () => {},
}));

// The suite-wide setup file (test/setup/stub-status-bar.ts) replaces this module
// so other tests never shell out; this file is the one place that tests the real
// implementation (against the execFile mock above), so opt back in.
vi.unmock("../src/utils/status-bar");

import { pinStatusBar, restoreStatusBar } from "../src/utils/status-bar";

const ANDROID_DEVICE: DeviceInfo = {
  id: "emulator-5554",
  platform: "android",
  kind: "emulator",
};

const IOS_SIMULATOR: DeviceInfo = {
  id: "1B48C3B4-8E17-4E92-A4A4-4B1AC3F0BD7B",
  platform: "ios",
  kind: "simulator",
};

const IOS_PHYSICAL_DEVICE: DeviceInfo = {
  id: "00008110-000978540290401E",
  platform: "ios",
  kind: "device",
};

const IOS_REMOTE_SIMULATOR: DeviceInfo = {
  id: "remote:1B48C3B4-8E17-4E92-A4A4-4B1AC3F0BD7B",
  platform: "ios-remote",
  kind: "simulator",
};

/** The udid the `sim-remote` CLI sees: the `remote:` prefix is stripped first. */
const REMOTE_UDID = "1B48C3B4-8E17-4E92-A4A4-4B1AC3F0BD7B";

/** Shell payloads of every `adb -s <serial> shell <cmd>` call, in order. */
function shellCalls(): string[] {
  return execFileMock.mock.calls
    .filter(([cmd, args]) => cmd === "adb" && args[0] === "-s" && args[2] === "shell")
    .map(([, args]) => args[3] as string);
}

beforeEach(() => {
  execFileMock.mockReset();
});

describe("pinStatusBar (ios)", () => {
  it("pins a simulator via `simctl status_bar override` and returns true", async () => {
    execFileMock.mockReturnValue({ stdout: "", stderr: "" });

    expect(await pinStatusBar(IOS_SIMULATOR)).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledWith(
      "xcrun",
      [
        "simctl",
        "status_bar",
        IOS_SIMULATOR.id,
        "override",
        "--time",
        "9:37",
        "--batteryState",
        "charged",
        "--batteryLevel",
        "100",
        "--wifiBars",
        "3",
        "--cellularBars",
        "4",
      ],
      undefined
    );
  });

  it("skips a physical device without spawning anything and returns false", async () => {
    // `simctl` cannot address a hardware UDID: the override would fail, and the
    // catch's restore would fail the same way, two wasted subprocesses per
    // flow run. `false` also means the caller schedules no run-end restore.
    expect(await pinStatusBar(IOS_PHYSICAL_DEVICE)).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe("pinStatusBar (ios-remote)", () => {
  it("pins a remote simulator through the sim-remote CLI and returns true", async () => {
    execFileMock.mockReturnValue({ stdout: "", stderr: "" });

    expect(await pinStatusBar(IOS_REMOTE_SIMULATOR)).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileMock.mock.calls[0]!;
    expect(cmd).toBe("sim-remote");
    // The `remote:` prefix is the tool-server's, not the orchestrator's.
    expect(args.slice(0, 3)).toEqual(["simctl", "status_bar", REMOTE_UDID]);
  });

  it("overrides a remote simulator to the same values as a local one", async () => {
    // A remote run compares against the baseline a local run of the same model
    // committed, so the two must pin the bar to identical pixels — a clock that
    // drifted between the arms would fail every shared snapshot on the bar
    // alone. Compared against the local argv rather than a restated literal, so
    // moving either arm's values without the other fails here.
    execFileMock.mockReturnValue({ stdout: "", stderr: "" });

    await pinStatusBar(IOS_SIMULATOR);
    const local = (execFileMock.mock.calls[0]![1] as string[]).slice(3);
    execFileMock.mockClear();

    await pinStatusBar(IOS_REMOTE_SIMULATOR);
    const remote = (execFileMock.mock.calls[0]![1] as string[]).slice(3);

    expect(remote).toEqual(local);
    // Both really carry the override, so an empty-vs-empty comparison cannot pass.
    expect(local).toContain("--time");
  });

  it("reports pinned when the undo fails too, so the run-end restore fires", async () => {
    // One dead tunnel fails both calls. Unlike a local `xcrun`, the override
    // crossed a network: the CLI can fail on a response whose request the far
    // host already applied, and a cloud simulator is shared, so a stuck pin
    // outlives this run. Report `true` so the caller's teardown retries.
    execFileMock.mockReturnValue(new Error("sim-remote: connection closed"));

    await expect(pinStatusBar(IOS_REMOTE_SIMULATOR)).resolves.toBe(true);
  });

  it("undoes a partially applied remote pin and reports unpinned", async () => {
    // A cloud hiccup must not fail the run, and the caller schedules no
    // run-end restore after a `false` — so the undo has to happen here or the
    // bar stays overridden.
    execFileMock.mockImplementation((_cmd: string, args: string[]) =>
      args.includes("override") ? new Error("sim-remote: request timed out") : { stdout: "" }
    );

    await expect(pinStatusBar(IOS_REMOTE_SIMULATOR)).resolves.toBe(false);
    const argvs = execFileMock.mock.calls.map(([, args]) => args as string[]);
    expect(argvs.some((a) => a.includes("clear"))).toBe(true);
  });
});

describe("pinStatusBar (android)", () => {
  it("returns true when every demo-mode command succeeds", async () => {
    execFileMock.mockReturnValue({ stdout: "", stderr: "" });

    expect(await pinStatusBar(ANDROID_DEVICE)).toBe(true);
    expect(shellCalls().some((c) => c.includes("command exit"))).toBe(false);
  });

  it("sends the demo-mode exit broadcast when a command fails after enter", async () => {
    // Fail the clock broadcast — demo mode has already been entered by then,
    // so pinStatusBar must undo it rather than leave the device pinned with
    // no restore scheduled (the caller skips restoreStatusBar on false).
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      const shell = args[3] ?? "";
      if (shell.includes("command clock")) return new Error("adb: device offline");
      return { stdout: "", stderr: "" };
    });

    expect(await pinStatusBar(ANDROID_DEVICE)).toBe(false);
    expect(shellCalls().some((c) => c.includes("command exit"))).toBe(true);
    expect(shellCalls().some((c) => c.includes("sysui_demo_allowed 0"))).toBe(true);
  });

  it("reports pinned when the cleanup exit broadcast fails too, so the run-end restore fires", async () => {
    // Demo mode was entered and could not be exited (transient adb). Returning
    // false here would tell the caller nothing needs restoring, leaving the
    // frozen clock/battery applied after the run — so report `true` instead
    // and let the caller's teardown restore retry.
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      const shell = args[3] ?? "";
      if (shell.includes("command clock") || shell.includes("command exit"))
        return new Error("adb: device offline");
      return { stdout: "", stderr: "" };
    });

    await expect(pinStatusBar(ANDROID_DEVICE)).resolves.toBe(true);
  });
});

describe("restoreStatusBar (ios-remote)", () => {
  it("clears the override through the sim-remote CLI", async () => {
    // Without this arm the pin above is never undone: the caller only calls
    // restore, and a run would leave the cloud simulator frozen at 9:37.
    execFileMock.mockReturnValue({ stdout: "", stderr: "" });

    expect(await restoreStatusBar(IOS_REMOTE_SIMULATOR)).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileMock.mock.calls[0]!;
    expect(cmd).toBe("sim-remote");
    expect(args).toEqual(["simctl", "status_bar", REMOTE_UDID, "clear"]);
  });

  it("reports failure instead of throwing when the CLI fails", async () => {
    execFileMock.mockReturnValue(new Error("sim-remote: not logged in"));

    await expect(restoreStatusBar(IOS_REMOTE_SIMULATOR)).resolves.toBe(false);
  });
});

describe("restoreStatusBar (android)", () => {
  it("exits demo mode and resets sysui_demo_allowed", async () => {
    execFileMock.mockReturnValue({ stdout: "", stderr: "" });

    expect(await restoreStatusBar(ANDROID_DEVICE)).toBe(true);
    expect(shellCalls()).toEqual([
      "am broadcast -a com.android.systemui.demo -e command exit",
      "settings put global sysui_demo_allowed 0",
    ]);
  });

  it("still resets sysui_demo_allowed when the exit broadcast fails, and reports failure", async () => {
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      const shell = args[3] ?? "";
      if (shell.includes("command exit")) return new Error("adb: device offline");
      return { stdout: "", stderr: "" };
    });

    expect(await restoreStatusBar(ANDROID_DEVICE)).toBe(false);
    expect(shellCalls().some((c) => c.includes("sysui_demo_allowed 0"))).toBe(true);
  });
});
