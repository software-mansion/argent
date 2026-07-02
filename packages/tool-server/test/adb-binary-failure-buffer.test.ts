import { describe, it, expect, vi, beforeEach } from "vitest";

const execFileMock = vi.fn();

// Binary execs run with encoding:"buffer", so on failure Node attaches
// Buffer stderr/stdout to the rejected error (not strings). This mock mirrors
// that contract so describeAdbFailure is exercised against Buffer fields.
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: readonly string[],
      opts: unknown,
      cb?: (err: Error | null, out: { stdout: unknown; stderr: unknown }) => void
    ) => {
      const callback = typeof opts === "function" ? opts : cb!;
      const result = execFileMock(cmd, args);
      if (result instanceof Error) {
        const e = result as Error & { stderr?: unknown; stdout?: unknown };
        callback(e, { stdout: e.stdout ?? Buffer.alloc(0), stderr: e.stderr ?? Buffer.alloc(0) });
      } else callback(null, result ?? { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
    },
  };
});

vi.mock("../src/utils/android-binary", () => ({
  resolveAndroidBinary: vi.fn(async (name: "adb" | "emulator") => name),
  __resetAndroidBinaryCacheForTesting: () => {},
}));

import { adbExecOutBinary } from "../src/utils/adb";

beforeEach(() => {
  execFileMock.mockReset();
});

// Regression (Bug-ATV4): describeAdbFailure called `(e.stderr ?? "").trim()`
// but binary execs reject with a Buffer stderr — Buffer has no `.trim`, so the
// handler itself threw `(e.stderr ?? "").trim is not a function`, masking adb's
// real diagnostic. The handler must coerce Buffer→string first.
describe("describeAdbFailure handles Buffer stderr/stdout from binary execs", () => {
  async function expectRejection(): Promise<string> {
    try {
      await adbExecOutBinary("emulator-5554", "uiautomator dump");
      throw new Error("expected rejection");
    } catch (err) {
      return (err as Error).message;
    }
  }

  it("surfaces the adb diagnostic from a Buffer stderr instead of crashing", async () => {
    execFileMock.mockImplementation(() =>
      Object.assign(new Error("Command failed: adb -s emulator-5554 exec-out uiautomator dump"), {
        code: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("error: device 'emulator-5554' offline"),
      })
    );
    const msg = await expectRejection();
    expect(msg).not.toMatch(/is not a function/);
    expect(msg).toContain("error: device 'emulator-5554' offline");
  });

  it("falls back to a Buffer stdout when stderr is empty", async () => {
    execFileMock.mockImplementation(() =>
      Object.assign(new Error("Command failed"), {
        code: 1,
        stdout: Buffer.from("junk output, no <hierarchy>"),
        stderr: Buffer.alloc(0),
      })
    );
    const msg = await expectRejection();
    expect(msg).not.toMatch(/is not a function/);
    expect(msg).toContain("junk output, no <hierarchy>");
  });
});
