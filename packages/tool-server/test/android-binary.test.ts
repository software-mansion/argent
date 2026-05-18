import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  __resetAndroidBinaryCacheForTesting,
  resolveAndroidBinary,
} from "../src/utils/android-binary";
import {
  __resetDepCacheForTests,
  ensureDep,
  DependencyMissingError,
} from "../src/utils/check-deps";

// Snapshot the env vars we mutate so a failing assertion can't leak state into
// the next test (or the surrounding process: vitest reuses the worker for
// other suites and a stale ANDROID_HOME would silently flip their behavior).
const ENV_KEYS = ["PATH", "ANDROID_HOME", "ANDROID_SDK_ROOT"] as const;
const originalEnv: Record<string, string | undefined> = {};

async function fakeSdk(root: string, name: "adb" | "emulator"): Promise<string> {
  const subdir = name === "adb" ? "platform-tools" : "emulator";
  const dir = join(root, subdir);
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  // Minimal executable shim — the resolver only checks X_OK + path; spawning
  // is exercised separately in adb.ts integration tests.
  await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

describe("resolveAndroidBinary", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    __resetAndroidBinaryCacheForTesting();
    __resetDepCacheForTests();
    tmpRoot = await mkdtemp(join(tmpdir(), "argent-android-binary-"));
  });

  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("finds emulator under $ANDROID_HOME when not on PATH", async () => {
    const sdk = join(tmpRoot, "sdk");
    const expected = await fakeSdk(sdk, "emulator");
    // Strip PATH down to OS basics so the test doesn't accidentally find a
    // real `emulator` binary on the host running the suite (CI shouldn't have
    // one but a developer's macOS easily can).
    process.env.PATH = "/usr/bin:/bin";
    process.env.ANDROID_HOME = sdk;
    delete process.env.ANDROID_SDK_ROOT;

    const path = await resolveAndroidBinary("emulator");
    expect(path).toBe(expected);
  });

  it("finds adb under $ANDROID_HOME/platform-tools when not on PATH", async () => {
    const sdk = join(tmpRoot, "sdk");
    const expected = await fakeSdk(sdk, "adb");
    process.env.PATH = "/usr/bin:/bin";
    process.env.ANDROID_HOME = sdk;
    delete process.env.ANDROID_SDK_ROOT;

    const path = await resolveAndroidBinary("adb");
    expect(path).toBe(expected);
  });

  it("falls back to $ANDROID_SDK_ROOT when $ANDROID_HOME is unset", async () => {
    const sdk = join(tmpRoot, "sdk-root");
    const expected = await fakeSdk(sdk, "emulator");
    process.env.PATH = "/usr/bin:/bin";
    delete process.env.ANDROID_HOME;
    process.env.ANDROID_SDK_ROOT = sdk;

    const path = await resolveAndroidBinary("emulator");
    expect(path).toBe(expected);
  });

  it("prefers PATH over $ANDROID_HOME when both resolve", async () => {
    // PATH-installed copy
    const pathBinDir = join(tmpRoot, "pathbin");
    await mkdir(pathBinDir, { recursive: true });
    const pathCopy = join(pathBinDir, "emulator");
    await writeFile(pathCopy, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(pathCopy, 0o755);
    // $ANDROID_HOME-installed copy
    const sdk = join(tmpRoot, "sdk");
    await fakeSdk(sdk, "emulator");

    process.env.PATH = `${pathBinDir}:/usr/bin:/bin`;
    process.env.ANDROID_HOME = sdk;
    delete process.env.ANDROID_SDK_ROOT;

    const path = await resolveAndroidBinary("emulator");
    expect(path).toBe(pathCopy);
  });

  it("returns null when neither PATH nor SDK roots resolve", async () => {
    process.env.PATH = "/usr/bin:/bin";
    delete process.env.ANDROID_HOME;
    delete process.env.ANDROID_SDK_ROOT;

    const path = await resolveAndroidBinary("emulator");
    expect(path).toBeNull();
  });

  it("ignores a non-executable file at the canonical SDK path", async () => {
    const sdk = join(tmpRoot, "sdk");
    const dir = join(sdk, "emulator");
    await mkdir(dir, { recursive: true });
    // Mode 0o644 — present but not executable, simulating a corrupted install.
    await writeFile(join(dir, "emulator"), "stub", { mode: 0o644 });
    await chmod(join(dir, "emulator"), 0o644);

    process.env.PATH = "/usr/bin:/bin";
    process.env.ANDROID_HOME = sdk;
    delete process.env.ANDROID_SDK_ROOT;

    const path = await resolveAndroidBinary("emulator");
    // Resolver should refuse the non-executable candidate. With no other
    // root configured, that means null.
    expect(path).toBeNull();
  });
});

describe("ensureDep('emulator')", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    __resetAndroidBinaryCacheForTesting();
    __resetDepCacheForTests();
    tmpRoot = await mkdtemp(join(tmpdir(), "argent-ensure-dep-"));
  });

  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("passes when emulator is resolvable via $ANDROID_HOME alone", async () => {
    const sdk = join(tmpRoot, "sdk");
    await fakeSdk(sdk, "emulator");
    process.env.PATH = "/usr/bin:/bin";
    process.env.ANDROID_HOME = sdk;
    delete process.env.ANDROID_SDK_ROOT;

    await expect(ensureDep("emulator")).resolves.toBeUndefined();
  });

  it("throws DependencyMissingError with install hint when neither resolves", async () => {
    process.env.PATH = "/usr/bin:/bin";
    delete process.env.ANDROID_HOME;
    delete process.env.ANDROID_SDK_ROOT;

    await expect(ensureDep("emulator")).rejects.toBeInstanceOf(DependencyMissingError);
    try {
      await ensureDep("emulator");
    } catch (err) {
      // The hint must guide the user to fix the actual problem (set
      // ANDROID_HOME) rather than just the prior PATH-only message.
      expect((err as Error).message).toMatch(/ANDROID_HOME/);
      expect((err as Error).message).toMatch(/emulator/);
    }
  });
});
