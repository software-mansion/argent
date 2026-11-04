import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";

// Force the PATH fallback to miss so the DevEco roots are what is searched.
vi.mock("../src/utils/command-on-path", () => ({
  commandOnPath: vi.fn(async () => null),
}));

// Records every stat'd candidate: the macOS default root cannot be populated in a test.
const { probed } = vi.hoisted(() => ({ probed: [] as string[] }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    access: async (path: string, mode?: number) => {
      probed.push(String(path));
      return actual.access(path, mode);
    },
  };
});

const HDC_RELATIVE = join("sdk", "default", "openharmony", "toolchains", "hdc");
const EMULATOR_RELATIVE = join("tools", "emulator", "Emulator");
const MACOS_DEVECO_APP = "/Applications/DevEco-Studio.app";

const originalPlatform = process.platform;
const originalHome = process.env.DEVECO_STUDIO_HOME;

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

/** Both resolvers memoize for 60s; a fresh import resets that. */
async function loadResolvers() {
  vi.resetModules();
  const [hdc, cli] = await Promise.all([
    import("../src/utils/harmony-hdc"),
    import("../src/utils/harmony-cli"),
  ]);
  return { resolveHdc: hdc.resolveHdc, resolveHarmonyEmulator: cli.resolveHarmonyEmulator };
}

async function writeExecutable(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "");
  await chmod(path, 0o755);
}

describe("DevEco Studio binary resolution", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "argent-deveco-root-"));
    probed.length = 0;
    setPlatform("darwin");
  });

  afterEach(async () => {
    setPlatform(originalPlatform);
    if (originalHome === undefined) delete process.env.DEVECO_STUDIO_HOME;
    else process.env.DEVECO_STUDIO_HOME = originalHome;
    vi.resetModules();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  describe("$DEVECO_STUDIO_HOME set to the macOS app bundle", () => {
    it("finds hdc", async () => {
      const bundle = join(tmpRoot, "DevEco-Studio.app");
      const hdc = join(bundle, "Contents", HDC_RELATIVE);
      await writeExecutable(hdc);
      process.env.DEVECO_STUDIO_HOME = bundle;

      const { resolveHdc } = await loadResolvers();
      expect(await resolveHdc()).toBe(hdc);
    });

    it("finds the Emulator manager", async () => {
      const bundle = join(tmpRoot, "DevEco-Studio.app");
      const emulator = join(bundle, "Contents", EMULATOR_RELATIVE);
      await writeExecutable(emulator);
      process.env.DEVECO_STUDIO_HOME = bundle;

      const { resolveHarmonyEmulator } = await loadResolvers();
      expect(await resolveHarmonyEmulator()).toBe(emulator);
    });
  });

  it("still resolves a root that already points inside the bundle", async () => {
    const contents = join(tmpRoot, "DevEco-Studio.app", "Contents");
    const hdc = join(contents, HDC_RELATIVE);
    await writeExecutable(hdc);
    process.env.DEVECO_STUDIO_HOME = contents;

    const { resolveHdc } = await loadResolvers();
    expect(await resolveHdc()).toBe(hdc);
  });

  describe("on Windows, where the install ships .exe binaries", () => {
    beforeEach(() => setPlatform("win32"));

    it("finds hdc.exe", async () => {
      const root = join(tmpRoot, "DevEco Studio");
      const hdc = `${join(root, HDC_RELATIVE)}.exe`;
      await writeExecutable(hdc);
      process.env.DEVECO_STUDIO_HOME = root;

      const { resolveHdc } = await loadResolvers();
      expect(await resolveHdc()).toBe(hdc);
    });

    it("finds Emulator.exe", async () => {
      const root = join(tmpRoot, "DevEco Studio");
      const emulator = `${join(root, EMULATOR_RELATIVE)}.exe`;
      await writeExecutable(emulator);
      process.env.DEVECO_STUDIO_HOME = root;

      const { resolveHarmonyEmulator } = await loadResolvers();
      expect(await resolveHarmonyEmulator()).toBe(emulator);
    });
  });

  describe("running the manager once it has been resolved", () => {
    it("classifies a run killed at its ceiling as a timeout, naming the signal", async () => {
      // A timed-out `Emulator` prints no diagnostic to classify.
      const bundle = join(tmpRoot, "DevEco-Studio.app");
      const emulator = join(bundle, "Contents", EMULATOR_RELATIVE);
      await mkdir(join(emulator, ".."), { recursive: true });
      await writeFile(emulator, "#!/usr/bin/env bash\nsleep 30\n");
      await chmod(emulator, 0o755);
      process.env.DEVECO_STUDIO_HOME = bundle;

      vi.resetModules();
      const { runHarmonyEmulator } = await import("../src/utils/harmony-cli");
      const err = await runHarmonyEmulator(["-list"], 100).then(
        () => null,
        (e: unknown) => e
      );

      expect(getFailureSignal(err)).toMatchObject({
        error_code: FAILURE_CODES.HARMONY_EMULATOR_COMMAND_FAILED,
        error_kind: "timeout",
        failure_command: "deveco_emulator",
        failure_signal: "SIGKILL",
      });
    });
  });

  describe("$DEVECO_STUDIO_HOME pointing at a root with no DevEco install", () => {
    // A set-but-wrong variable must not hide a working default install.
    it("goes on to probe the macOS default root for hdc", async () => {
      process.env.DEVECO_STUDIO_HOME = tmpRoot;

      const { resolveHdc } = await loadResolvers();
      await resolveHdc();

      const envCandidate = join(tmpRoot, HDC_RELATIVE);
      const defaultCandidate = join(MACOS_DEVECO_APP, "Contents", HDC_RELATIVE);
      expect(probed).toContain(defaultCandidate);
      expect(probed.indexOf(envCandidate)).toBeGreaterThanOrEqual(0);
      expect(probed.indexOf(envCandidate)).toBeLessThan(probed.indexOf(defaultCandidate));
    });

    it("goes on to probe the macOS default root for the Emulator manager", async () => {
      process.env.DEVECO_STUDIO_HOME = tmpRoot;

      const { resolveHarmonyEmulator } = await loadResolvers();
      await resolveHarmonyEmulator();

      const envCandidate = join(tmpRoot, EMULATOR_RELATIVE);
      const defaultCandidate = join(MACOS_DEVECO_APP, "Contents", EMULATOR_RELATIVE);
      expect(probed).toContain(defaultCandidate);
      expect(probed.indexOf(envCandidate)).toBeGreaterThanOrEqual(0);
      expect(probed.indexOf(envCandidate)).toBeLessThan(probed.indexOf(defaultCandidate));
    });
  });
});
