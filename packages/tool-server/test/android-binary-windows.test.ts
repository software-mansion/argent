import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

// Capture per-test execFile stub so each case can supply its own probe result
// (or throw) for the PATH lookup before the SDK-root fallback runs.
const execFileMock = vi.fn();

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  // Node's `child_process.execFile` carries a `[util.promisify.custom]`
  // symbol that makes `promisify(execFile)` resolve to `{ stdout, stderr }`
  // rather than the standard single-value shape. The android-binary module
  // destructures `.stdout`, so the mock MUST install the same custom symbol;
  // otherwise the resolved value is the bare stdout string, `.stdout`
  // returns undefined, and the trimmed-line check fails silently.
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
const ORIGINAL_ANDROID_HOME = process.env.ANDROID_HOME;
const ORIGINAL_ANDROID_SDK_ROOT = process.env.ANDROID_SDK_ROOT;

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function restorePlatform() {
  Object.defineProperty(process, "platform", { value: ORIGINAL_PLATFORM, configurable: true });
}

function restoreAndroidEnv() {
  if (ORIGINAL_ANDROID_HOME === undefined) delete process.env.ANDROID_HOME;
  else process.env.ANDROID_HOME = ORIGINAL_ANDROID_HOME;
  if (ORIGINAL_ANDROID_SDK_ROOT === undefined) delete process.env.ANDROID_SDK_ROOT;
  else process.env.ANDROID_SDK_ROOT = ORIGINAL_ANDROID_SDK_ROOT;
}

describe("resolveAndroidBinary (Windows: `where` + `.exe` filename)", () => {
  let resolveAndroidBinary: typeof import("../src/utils/android-binary").resolveAndroidBinary;
  let resetCache: typeof import("../src/utils/android-binary").__resetAndroidBinaryCacheForTesting;
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    execFileMock.mockReset();
    setPlatform("win32");
    delete process.env.ANDROID_HOME;
    delete process.env.ANDROID_SDK_ROOT;
    const mod = await import("../src/utils/android-binary");
    resolveAndroidBinary = mod.resolveAndroidBinary;
    resetCache = mod.__resetAndroidBinaryCacheForTesting;
    resetCache();
    tempDir = await mkdtemp(join(tmpdir(), "android-binary-win-test-"));
  });

  afterEach(async () => {
    restorePlatform();
    restoreAndroidEnv();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("uses `where adb` on Windows (not `command -v`)", async () => {
    execFileMock.mockReturnValue("C:\\Android\\platform-tools\\adb.exe\r\n");
    await resolveAndroidBinary("adb");
    expect(execFileMock).toHaveBeenCalledOnce();
    const [cmd, args] = execFileMock.mock.calls[0]!;
    expect(cmd).toBe("where");
    expect(args).toEqual(["adb"]);
  });

  it("returns the first line when `where` prints multiple matches", async () => {
    // `where` resolves every PATH match — common when both Android Studio's
    // SDK and a Chocolatey adb are installed. Take the first.
    execFileMock.mockReturnValue(
      "C:\\Android\\platform-tools\\adb.exe\r\nC:\\choco\\bin\\adb.exe\r\n"
    );
    const result = await resolveAndroidBinary("adb");
    expect(result).toBe("C:\\Android\\platform-tools\\adb.exe");
  });

  it("falls back to ANDROID_HOME with `.exe` suffix when `where` misses", async () => {
    execFileMock.mockReturnValue(new Error("Could not find files"));
    // Build a fake SDK with an .exe binary in the canonical subdir.
    const sdkRoot = tempDir;
    await mkdir(join(sdkRoot, "platform-tools"), { recursive: true });
    const exePath = join(sdkRoot, "platform-tools", "adb.exe");
    await writeFile(exePath, "fake adb binary");
    // Windows has no exec bit; X_OK degrades to F_OK, so writeFile alone is
    // enough. (chmod is a no-op on win32 but harmless.)
    await chmod(exePath, 0o755).catch(() => {});
    process.env.ANDROID_HOME = sdkRoot;

    const result = await resolveAndroidBinary("adb");
    expect(result).toBe(exePath);
    expect(result).toMatch(/adb\.exe$/);
  });

  it("returns null when binary is missing from both PATH and SDK roots", async () => {
    execFileMock.mockReturnValue(new Error("not found"));
    process.env.ANDROID_HOME = tempDir; // exists but empty
    const result = await resolveAndroidBinary("adb");
    expect(result).toBeNull();
  });

  it("uses `emulator.exe` (not bare `emulator`) for the emulator binary on Windows", async () => {
    execFileMock.mockReturnValue(new Error("not found"));
    const sdkRoot = tempDir;
    await mkdir(join(sdkRoot, "emulator"), { recursive: true });
    const exePath = join(sdkRoot, "emulator", "emulator.exe");
    await writeFile(exePath, "fake emulator binary");
    // The probe uses access(path, X_OK). On the host (real macOS) we need an
    // exec bit for that to pass; on a real Windows host X_OK degrades to F_OK
    // so this chmod is just a host-portable shim. The .catch swallows EPERM
    // on filesystems that ignore chmod (e.g. running this test on Windows CI).
    await chmod(exePath, 0o755).catch(() => {});
    process.env.ANDROID_HOME = sdkRoot;

    const result = await resolveAndroidBinary("emulator");
    expect(result).toBe(exePath);
    expect(result).toMatch(/emulator\.exe$/);
  });

  it("does NOT find a bare `emulator` (no .exe) on Windows even if it exists", async () => {
    execFileMock.mockReturnValue(new Error("not found"));
    const sdkRoot = tempDir;
    await mkdir(join(sdkRoot, "emulator"), { recursive: true });
    // Drop a Unix-style executable binary; on Windows binaryFilename() asks
    // for `emulator.exe`, so this should NOT resolve. The chmod ensures the
    // X_OK probe would otherwise succeed — without it the test would pass
    // for the wrong reason (X_OK failing because the file is not executable).
    const unixPath = join(sdkRoot, "emulator", "emulator");
    await writeFile(unixPath, "fake unix binary");
    await chmod(unixPath, 0o755).catch(() => {});
    process.env.ANDROID_HOME = sdkRoot;

    const result = await resolveAndroidBinary("emulator");
    expect(result).toBeNull();
  });

  it("honors ANDROID_SDK_ROOT as a legacy fallback after ANDROID_HOME", async () => {
    execFileMock.mockReturnValue(new Error("not found"));
    const sdkRoot = tempDir;
    await mkdir(join(sdkRoot, "platform-tools"), { recursive: true });
    const exePath = join(sdkRoot, "platform-tools", "adb.exe");
    await writeFile(exePath, "fake adb binary");
    await chmod(exePath, 0o755).catch(() => {});
    // ANDROID_HOME is unset — ANDROID_SDK_ROOT must take over.
    process.env.ANDROID_SDK_ROOT = sdkRoot;

    const result = await resolveAndroidBinary("adb");
    expect(result).toBe(exePath);
  });
});

describe("resolveAndroidBinary (POSIX bare-name regression)", () => {
  let resolveAndroidBinary: typeof import("../src/utils/android-binary").resolveAndroidBinary;
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    execFileMock.mockReset();
    setPlatform("darwin");
    delete process.env.ANDROID_HOME;
    delete process.env.ANDROID_SDK_ROOT;
    const mod = await import("../src/utils/android-binary");
    resolveAndroidBinary = mod.resolveAndroidBinary;
    mod.__resetAndroidBinaryCacheForTesting();
    tempDir = await mkdtemp(join(tmpdir(), "android-binary-posix-test-"));
  });

  afterEach(async () => {
    restorePlatform();
    restoreAndroidEnv();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("uses `/bin/sh -c command -v adb` on macOS (not `where`)", async () => {
    execFileMock.mockReturnValue("/opt/homebrew/bin/adb\n");
    await resolveAndroidBinary("adb");
    expect(execFileMock).toHaveBeenCalledOnce();
    const [cmd, args] = execFileMock.mock.calls[0]!;
    expect(cmd).toBe("/bin/sh");
    expect(args).toEqual(["-c", "command -v adb"]);
  });

  it("falls back to bare `adb` filename (no .exe) under ANDROID_HOME on POSIX", async () => {
    execFileMock.mockReturnValue(new Error("not found"));
    const sdkRoot = tempDir;
    await mkdir(join(sdkRoot, "platform-tools"), { recursive: true });
    const binPath = join(sdkRoot, "platform-tools", "adb");
    await writeFile(binPath, "fake adb binary");
    await chmod(binPath, 0o755);
    process.env.ANDROID_HOME = sdkRoot;

    const result = await resolveAndroidBinary("adb");
    expect(result).toBe(binPath);
    // On POSIX the suffix-less filename is what we want — explicit assertion
    // guards against a regression that would prepend `.exe` on macOS.
    expect(result).not.toMatch(/\.exe$/);
  });
});
