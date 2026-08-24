import { describe, it, expect, vi, beforeEach } from "vitest";

const execFileMock = vi.fn();
const execFileOpts: Record<string, unknown>[] = [];

// Callback-style double, matching the pattern in adb-binary-failure-buffer.test.ts:
// adb.ts builds `promisify(execFile)` at module-eval time, so the mock must be a
// plain callback function — attaching `promisify.custom` here races module load
// order and leaves the generic wrapper awaiting a callback that never fires.
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
      execFileOpts.push(opts as Record<string, unknown>);
      const callback = typeof opts === "function" ? opts : cb!;
      const result = execFileMock(cmd, args);
      if (result instanceof Error) {
        // Real execFile attaches the captured streams to the rejected error;
        // replicate that here since the promisify wrapper does not.
        const e = result as Error & { stdout?: string; stderr?: string };
        e.stdout = e.stdout ?? "";
        e.stderr = e.stderr ?? "";
        callback(e, { stdout: e.stdout, stderr: e.stderr });
      } else {
        callback(null, result ?? { stdout: "", stderr: "" });
      }
    },
  };
});

// `emulatorSupportsFlag` resolves the emulator binary before probing; stub the
// resolver to a bare name so the mock above matches regardless of whether the
// host has the SDK installed.
vi.mock("../src/utils/android-binary", () => ({
  resolveAndroidBinary: vi.fn(async (name: "adb" | "emulator") => name),
  __resetAndroidBinaryCacheForTesting: () => {},
}));

import { checkSnapshotLoadable, emulatorSupportsFlag, listAvds } from "../src/utils/adb";

beforeEach(() => {
  execFileMock.mockReset();
  execFileOpts.length = 0;
});

describe("emulatorSupportsFlag — failed `-help` probes are not memoized", () => {
  // A transient failure (timeout under load, spawn error, silent exit) produces
  // no listing and therefore no verdict. Memoizing it would pin `false` for the
  // process lifetime and silently drop crash-dialog suppression on every later
  // boot. The cache is keyed `${binaryPath}|${flag}`, so each case uses a
  // distinct flag to stay isolated from the other cases in this file.

  it("retries on the next call after a failed spawn that produced no output", async () => {
    execFileMock.mockImplementationOnce(
      () => new Error("spawn emulator ENOENT") as Error & { stdout?: string; stderr?: string }
    );
    execFileMock.mockImplementationOnce(() => ({
      stdout: "usage: emulator [options]\n -retry-flag never\n",
      stderr: "",
    }));

    expect(await emulatorSupportsFlag("-retry-flag")).toBe(false);
    expect(await emulatorSupportsFlag("-retry-flag")).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("does not memoize a timeout either (execFile kills with empty streams)", async () => {
    execFileMock.mockImplementationOnce(() => {
      const err = new Error("command timed out after 10s") as Error & {
        stdout?: string;
        stderr?: string;
        killed?: boolean;
      };
      err.killed = true;
      return err;
    });

    expect(await emulatorSupportsFlag("-timeout-flag")).toBe(false);
    expect(execFileMock).toHaveBeenCalledTimes(1);

    await emulatorSupportsFlag("-timeout-flag");
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("does not memoize a zero-exit run that printed no listing", async () => {
    execFileMock.mockImplementationOnce(() => ({ stdout: "", stderr: "" }));
    execFileMock.mockImplementationOnce(() => ({
      stdout: " -silent-success-flag never\n",
      stderr: "",
    }));

    expect(await emulatorSupportsFlag("-silent-success-flag")).toBe(false);
    expect(await emulatorSupportsFlag("-silent-success-flag")).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("does not memoize a timeout that captured only part of the listing", async () => {
    execFileMock.mockImplementationOnce(() => {
      const err = new Error("command timed out after 10s") as Error & {
        stdout?: string;
        stderr?: string;
        killed?: boolean;
      };
      err.killed = true;
      // Partial capture that happens not to contain the probed flag: a
      // memoized verdict from it could miss a flag further down the listing.
      err.stdout = "usage: emulator [options]\n -no-metrics\n";
      return err;
    });
    execFileMock.mockImplementationOnce(() => ({
      stdout: " -partial-timeout-flag never\n",
      stderr: "",
    }));

    expect(await emulatorSupportsFlag("-partial-timeout-flag")).toBe(false);
    expect(await emulatorSupportsFlag("-partial-timeout-flag")).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("still memoizes a real verdict read from a non-zero exit's captured listing", async () => {
    execFileMock.mockImplementation(() => {
      const err = new Error("exit 1") as Error & { stdout?: string; stderr?: string };
      // Some builds list usage on stderr while exiting non-zero.
      err.stderr = "-captured-exit-flag never\n";
      return err;
    });

    expect(await emulatorSupportsFlag("-captured-exit-flag")).toBe(true);
    expect(await emulatorSupportsFlag("-captured-exit-flag")).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("memoizes a normal zero-exit verdict too", async () => {
    execFileMock.mockImplementation(() => ({ stdout: " -captured-ok-flag never\n", stderr: "" }));

    expect(await emulatorSupportsFlag("-captured-ok-flag")).toBe(true);
    expect(await emulatorSupportsFlag("-captured-ok-flag")).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("kills a hung probe with SIGKILL so the timeout cannot be ignored", async () => {
    // Node's default kill signal is SIGTERM; an emulator wedged in init can
    // ignore it and the probe promise never settles, hanging boot-device.
    execFileMock.mockImplementation(() => ({ stdout: " -sigkill-flag never\n", stderr: "" }));

    await emulatorSupportsFlag("-sigkill-flag");

    expect(execFileOpts[0]?.killSignal).toBe("SIGKILL");
  });

  it("warns on stderr when a probe fails without producing a verdict", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    execFileMock.mockImplementationOnce(() => new Error("EMFILE: too many open files"));

    await emulatorSupportsFlag("-warn-flag");

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('assuming "-warn-flag" unsupported for this boot')
    );
    stderrSpy.mockRestore();
  });
});

// Same SIGKILL wiring as the -help probe above, pinned for the other two
// emulator spawns so a dropped killSignal cannot silently reintroduce the
// never-settling hang on the snapshot-probe or AVD-listing paths.
describe("emulator probe spawns are SIGKILL-protected", () => {
  it("listAvds kills a hung `-list-avds` with SIGKILL", async () => {
    execFileMock.mockImplementation(() => ({ stdout: "Pixel_7_API_34\n", stderr: "" }));

    await listAvds();

    expect(execFileOpts[0]?.killSignal).toBe("SIGKILL");
    expect(execFileOpts[0]?.timeout).toBe(5_000);
  });

  it("checkSnapshotLoadable kills a hung probe with SIGKILL", async () => {
    execFileMock.mockImplementation(() => ({ stdout: "Loadable\n", stderr: "" }));

    const result = await checkSnapshotLoadable("Pixel_7_API_34");

    expect(result.loadable).toBe(true);
    expect(execFileOpts[0]?.killSignal).toBe("SIGKILL");
  });
});
