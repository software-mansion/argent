import { describe, it, expect, vi, beforeEach } from "vitest";

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
      const result = execFileMock(cmd, args);
      if (result instanceof Error) {
        // Mirror execFile's actual rejection contract: stderr/stdout/signal/killed
        // are all attached to the error object so describeAdbFailure can read them.
        const e = result as Error & { stderr?: string; stdout?: string };
        callback(e, { stdout: e.stdout ?? "", stderr: e.stderr ?? "" });
      } else callback(null, result ?? { stdout: "", stderr: "" });
    },
  };
});

vi.mock("../src/utils/android-binary", () => ({
  resolveAndroidBinary: vi.fn(async (name: "adb" | "emulator") => name),
  __resetAndroidBinaryCacheForTesting: () => {},
}));

import { runAdb } from "../src/utils/adb";

beforeEach(() => {
  execFileMock.mockReset();
});

// Timeout-SIGKILL leaves empty stderr/stdout and a bare "Command failed: <argv>"
// message; without surfacing signal/killed/code the cause is invisible.
describe("describeAdbFailure surfaces timeout/SIGKILL metadata", () => {
  async function expectRejection(args: string[]): Promise<string> {
    try {
      await runAdb(args);
      throw new Error("expected rejection");
    } catch (err) {
      return (err as Error).message;
    }
  }

  it("appends signal=SIGKILL and killed=true when stderr/stdout are empty", async () => {
    execFileMock.mockImplementation(() =>
      Object.assign(new Error("Command failed: adb -s emulator-5554 shell wm size"), {
        signal: "SIGKILL" as const,
        killed: true,
        code: null,
        stdout: "",
        stderr: "",
      })
    );
    const msg = await expectRejection(["-s", "emulator-5554", "shell", "wm size"]);
    expect(msg).toMatch(/killed=true/);
    expect(msg).toMatch(/signal=SIGKILL/);
  });

  it("preserves stderr-driven message when adb did emit a diagnostic", async () => {
    execFileMock.mockImplementation(() =>
      Object.assign(new Error("Command failed: adb -s emulator-5554 shell wm size"), {
        stderr: "error: device 'emulator-5554' offline",
        stdout: "",
        code: 1,
      })
    );
    const msg = await expectRejection(["-s", "emulator-5554", "shell", "wm size"]);
    expect(msg).toContain("error: device 'emulator-5554' offline");
    // stderr path must not be polluted with the suffix
    expect(msg).not.toMatch(/\(.*code=/);
  });

  it("appends non-zero exit code when the child exited cleanly without stderr", async () => {
    execFileMock.mockImplementation(() =>
      Object.assign(new Error("Command failed: adb -s X shell foo"), {
        code: 127,
        stdout: "",
        stderr: "",
      })
    );
    const msg = await expectRejection(["-s", "X", "shell", "foo"]);
    expect(msg).toMatch(/\(code=127\)/);
  });

  it("surfaces spawn-error string codes (ENOENT) when nothing else is present", async () => {
    execFileMock.mockImplementation(() =>
      Object.assign(new Error("spawn adb ENOENT"), {
        code: "ENOENT",
        syscall: "spawn adb",
        path: "adb",
      })
    );
    const msg = await expectRejection(["devices"]);
    expect(msg).toMatch(/\(code=ENOENT\)/);
  });

  it("emits no empty () suffix when no signal/killed/code is set", async () => {
    execFileMock.mockImplementation(() =>
      Object.assign(new Error("boom"), { stdout: "", stderr: "" })
    );
    const msg = await expectRejection(["devices"]);
    expect(msg).toBe("adb devices failed: boom");
  });
});
