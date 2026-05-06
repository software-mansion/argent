import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promisify } from "node:util";

// Capture per-test execFile stub so each case can supply its own probe result.
const execFileMock = vi.fn();

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  // Node's real `child_process.execFile` exposes a `[util.promisify.custom]`
  // override that yields `{ stdout, stderr }` instead of the default
  // single-value promise shape. `check-deps.ts` calls `await execFileAsync(...)`
  // (the promisified form) but does not destructure the result — the call is
  // only used as a presence check, so the standard single-value shape would
  // be enough here. We still install the custom symbol so this mock matches
  // the real surface, keeping it reusable for the SDK-resolver tests that DO
  // destructure `.stdout`.
  const fakeExecFile = (...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
    const result = execFileMock(...args.slice(0, -1));
    if (result instanceof Error) {
      queueMicrotask(() => cb(result, "", ""));
    } else {
      queueMicrotask(() => cb(null, result ?? "", ""));
    }
    return { on: () => {} } as unknown as ReturnType<typeof actual.execFile>;
  };
  Object.defineProperty(fakeExecFile, promisify.custom, {
    value: (cmd: string, cmdArgs?: string[], opts?: object) =>
      new Promise((resolve, reject) => {
        const result = execFileMock(cmd, cmdArgs, opts);
        if (result instanceof Error) reject(result);
        else resolve({ stdout: result ?? "", stderr: "" });
      }),
  });
  return {
    ...actual,
    execFile: fakeExecFile,
  };
});

const ORIGINAL_PLATFORM = process.platform;

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function restorePlatform() {
  Object.defineProperty(process, "platform", { value: ORIGINAL_PLATFORM, configurable: true });
}

describe("check-deps probe (Windows `where` branch)", () => {
  let ensureDep: typeof import("../src/utils/check-deps").ensureDep;
  let DependencyMissingError: typeof import("../src/utils/check-deps").DependencyMissingError;
  let resetCache: typeof import("../src/utils/check-deps").__resetDepCacheForTests;

  beforeEach(async () => {
    vi.resetModules();
    execFileMock.mockReset();
    setPlatform("win32");
    const mod = await import("../src/utils/check-deps");
    ensureDep = mod.ensureDep;
    DependencyMissingError = mod.DependencyMissingError;
    resetCache = mod.__resetDepCacheForTests;
    resetCache();
  });

  afterEach(() => {
    restorePlatform();
  });

  it("uses `where xcrun` on Windows (not `command -v`)", async () => {
    execFileMock.mockReturnValue("C:\\Path\\xcrun.exe\r\n");
    await ensureDep("xcrun");
    expect(execFileMock).toHaveBeenCalledOnce();
    const [cmd, args] = execFileMock.mock.calls[0]!;
    expect(cmd).toBe("where");
    expect(args).toEqual(["xcrun"]);
  });

  it("does not invoke `/bin/sh` on Windows", async () => {
    execFileMock.mockReturnValue("C:\\Path\\xcrun.exe\r\n");
    await ensureDep("xcrun");
    const calls = execFileMock.mock.calls.map((c) => c[0]);
    expect(calls).not.toContain("/bin/sh");
  });

  it("throws DependencyMissingError when `where` exits non-zero (binary not on PATH)", async () => {
    execFileMock.mockReturnValue(new Error("INFO: Could not find files for the given pattern(s)."));
    await expect(ensureDep("xcrun")).rejects.toBeInstanceOf(DependencyMissingError);
  });

  it("missing-error message names the binary and includes install hint", async () => {
    execFileMock.mockReturnValue(new Error("not found"));
    let caught: unknown;
    try {
      await ensureDep("xcrun");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DependencyMissingError);
    const err = caught as InstanceType<typeof DependencyMissingError>;
    expect(err.missing).toEqual(["xcrun"]);
    expect(err.message).toMatch(/xcode-select --install/i);
  });

  it("succeeds (no throw) when `where` returns a valid path", async () => {
    execFileMock.mockReturnValue("C:\\Path\\xcrun.exe\r\n");
    await expect(ensureDep("xcrun")).resolves.toBeUndefined();
  });

  it("caches the positive result so a second call does not re-shell", async () => {
    execFileMock.mockReturnValue("C:\\Path\\xcrun.exe\r\n");
    await ensureDep("xcrun");
    await ensureDep("xcrun");
    expect(execFileMock).toHaveBeenCalledOnce();
  });
});

describe("check-deps probe (POSIX `command -v` branch — regression check)", () => {
  let ensureDep: typeof import("../src/utils/check-deps").ensureDep;

  beforeEach(async () => {
    vi.resetModules();
    execFileMock.mockReset();
    setPlatform("darwin");
    const mod = await import("../src/utils/check-deps");
    ensureDep = mod.ensureDep;
    mod.__resetDepCacheForTests();
  });

  afterEach(() => {
    restorePlatform();
  });

  it("uses `/bin/sh -c command -v <dep>` on macOS", async () => {
    execFileMock.mockReturnValue("/usr/bin/xcrun\n");
    await ensureDep("xcrun");
    expect(execFileMock).toHaveBeenCalledOnce();
    const [cmd, args] = execFileMock.mock.calls[0]!;
    expect(cmd).toBe("/bin/sh");
    expect(args).toEqual(["-c", "command -v xcrun"]);
  });
});
