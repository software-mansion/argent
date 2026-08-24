import { describe, it, expect, vi, beforeEach } from "vitest";

const execFileMock = vi.fn();

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

import { emulatorSupportsFlag } from "../src/utils/adb";

beforeEach(() => {
  execFileMock.mockReset();
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
