import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Force the PATH probe to miss so resolution falls through to the SDK-root
// scan — that's the branch where the Windows `.exe` suffix and the
// %LOCALAPPDATA%\Android\Sdk default root matter.
vi.mock("../src/utils/command-on-path", () => ({
  commandOnPath: vi.fn(async () => null),
}));

const ENV_KEYS = ["PATH", "ANDROID_HOME", "ANDROID_SDK_ROOT", "HOME", "LOCALAPPDATA"] as const;
const originalEnv: Record<string, string | undefined> = {};
const originalPlatform = process.platform;

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

/**
 * `android-binary.ts` captures the executable extension (`.exe` on win32) at
 * module load, so the platform must be set BEFORE importing it. Re-import via
 * vi.resetModules() so each test sees the extension for its chosen platform.
 */
async function loadResolverAsWin32(): Promise<typeof import("../src/utils/android-binary")> {
  setPlatform("win32");
  vi.resetModules();
  return await import("../src/utils/android-binary");
}

describe("resolveAndroidBinary on Windows", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    // Clear env-var roots so resolution can only succeed via the OS default
    // (%LOCALAPPDATA%) we set per-test — otherwise a stray ANDROID_HOME would
    // mask what we're asserting.
    delete process.env.ANDROID_HOME;
    delete process.env.ANDROID_SDK_ROOT;
    tmpRoot = await mkdtemp(join(tmpdir(), "argent-android-win-"));
  });

  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
    setPlatform(originalPlatform);
    vi.resetModules();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("appends .exe and finds adb under %LOCALAPPDATA%\\Android\\Sdk", async () => {
    // Android Studio's default Windows SDK location. The resolver builds a
    // literal path and access()es it, so it must include the `.exe` extension.
    const sdk = join(tmpRoot, "Android", "Sdk");
    const adbDir = join(sdk, "platform-tools");
    await mkdir(adbDir, { recursive: true });
    const adbExe = join(adbDir, "adb.exe");
    await writeFile(adbExe, "", { mode: 0o755 });
    await chmod(adbExe, 0o755);
    process.env.LOCALAPPDATA = tmpRoot;

    const { resolveAndroidBinary, __resetAndroidBinaryCacheForTesting } =
      await loadResolverAsWin32();
    __resetAndroidBinaryCacheForTesting();

    expect(await resolveAndroidBinary("adb")).toBe(adbExe);
  });

  it("appends .exe for the emulator binary too", async () => {
    const sdk = join(tmpRoot, "Android", "Sdk");
    const emuDir = join(sdk, "emulator");
    await mkdir(emuDir, { recursive: true });
    const emuExe = join(emuDir, "emulator.exe");
    await writeFile(emuExe, "", { mode: 0o755 });
    await chmod(emuExe, 0o755);
    process.env.LOCALAPPDATA = tmpRoot;

    const { resolveAndroidBinary, __resetAndroidBinaryCacheForTesting } =
      await loadResolverAsWin32();
    __resetAndroidBinaryCacheForTesting();

    expect(await resolveAndroidBinary("emulator")).toBe(emuExe);
  });

  it("returns null when only the extensionless binary exists (Windows can't exec it)", async () => {
    const adbDir = join(tmpRoot, "Android", "Sdk", "platform-tools");
    await mkdir(adbDir, { recursive: true });
    // Extensionless — must NOT satisfy the win32 resolver.
    await writeFile(join(adbDir, "adb"), "", { mode: 0o755 });
    process.env.LOCALAPPDATA = tmpRoot;

    const { resolveAndroidBinary, __resetAndroidBinaryCacheForTesting } =
      await loadResolverAsWin32();
    __resetAndroidBinaryCacheForTesting();

    expect(await resolveAndroidBinary("adb")).toBeNull();
  });
});
