import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import {
  assertXctestrunParses,
  computeRunnerCacheKey,
  ensureRunnerArtifact,
  isProfileExpiredFailure,
  isProfileMissingDeviceFailure,
  resolveRunnerProjectPath,
  runnerBuildStaticArgs,
  xcodebuildFailureSummary,
  XctestrunFormatError,
  type RunnerArtifact,
} from "../src/utils/ios-device/runner-artifact";
import type { RunnerSigningConfig } from "../src/utils/ios-device/runner-signing";

const execFileAsync = promisify(execFile);

let tmpRoot: string;
beforeAll(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "argent-runner-artifact-"));
});
afterAll(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

/**
 * Write a plist-XML .xctestrun from a JSON object via the same plutil the
 * production code shells out to. plutil ships only with macOS, so every case
 * built on this helper is gated on darwin.
 */
async function writeXctestrun(name: string, contents: unknown): Promise<string> {
  const jsonPath = path.join(tmpRoot, `${name}.json`);
  const xctestrunPath = path.join(tmpRoot, `${name}.xctestrun`);
  await fsp.writeFile(jsonPath, JSON.stringify(contents));
  await execFileAsync("plutil", ["-convert", "xml1", jsonPath, "-o", xctestrunPath]);
  return xctestrunPath;
}

// The probe shells out to plutil, so it and its fixtures are macOS-only. The
// unit-test job runs on Linux, where a missing plutil would fail the valid
// case and pass the torn case for the wrong reason.
describe.skipIf(process.platform !== "darwin")("assertXctestrunParses", () => {
  it("accepts a well-formed xctestrun", async () => {
    const src = await writeXctestrun("valid", {
      __xctestrun_metadata__: { FormatVersion: 2 },
      TestConfigurations: [],
    });

    await expect(assertXctestrunParses(src)).resolves.toBeUndefined();
  });

  it("wraps an unparseable (truncated) xctestrun in the typed format error", async () => {
    const truncatedPath = path.join(tmpRoot, "truncated.xctestrun");
    // The head of a real plist, torn mid-write: plutil cannot parse it. Raw,
    // this would surface as an execFileAsync error the blueprint's self-heal
    // could not key on.
    await fsp.writeFile(
      truncatedPath,
      '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n<key>TestConfig'
    );

    const error = await assertXctestrunParses(truncatedPath).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(XctestrunFormatError);
    expect((error as Error).name).toBe("XctestrunFormatError");
    expect((error as Error).message).toContain("could not be parsed as a plist");
    expect((error as Error).message).toContain(truncatedPath);
    expect((error as Error).cause).toBeDefined();
  });
});

const PROJECT = "/opt/argent/ios-device-runner/ArgentRunner/ArgentRunner.xcodeproj";
const CONFIG: RunnerSigningConfig = {
  teamId: "ABCDE12345",
  appBundleId: "com.argent.runner.tabcde12345",
  testBundleId: "com.argent.runner.tabcde12345.uitests",
};

describe("runnerBuildStaticArgs", () => {
  it("always signs automatically under the configured team", () => {
    const args = runnerBuildStaticArgs(PROJECT, CONFIG);

    expect(args).toContain("CODE_SIGN_STYLE=Automatic");
    expect(args).toContain("DEVELOPMENT_TEAM=ABCDE12345");
    // The manual-signing surface is gone: no argv may carry an identity or a
    // profile, the pair xcodebuild refuses next to automatic signing.
    expect(
      args.filter((a) => /^(CODE_SIGN_IDENTITY|PROVISIONING_PROFILE_SPECIFIER)=/.test(a))
    ).toEqual([]);
  });
});

describe("computeRunnerCacheKey", () => {
  it("emits a 16-character lowercase hex key", () => {
    const key = computeRunnerCacheKey("srcs", "Xcode 16.4", runnerBuildStaticArgs(PROJECT, CONFIG));
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });

  it("changes with the signing config, which rides in via the args", () => {
    const base = computeRunnerCacheKey("srcs", "x", runnerBuildStaticArgs(PROJECT, CONFIG));
    for (const config of [
      { ...CONFIG, appBundleId: "com.other.argent.runner" },
      { ...CONFIG, teamId: "FGHIJ67890" },
    ]) {
      expect(computeRunnerCacheKey("srcs", "x", runnerBuildStaticArgs(PROJECT, config))).not.toBe(
        base
      );
    }
  });

  it("changes with the sources and toolchain fingerprints", () => {
    const args = runnerBuildStaticArgs(PROJECT, CONFIG);
    const base = computeRunnerCacheKey("srcs", "Xcode 16.4", args);
    expect(computeRunnerCacheKey("other-srcs", "Xcode 16.4", args)).not.toBe(base);
    expect(computeRunnerCacheKey("srcs", "Xcode 26.0", args)).not.toBe(base);
  });

  it("keeps the per-run destination/derived-data pair out of the static args", () => {
    const args = runnerBuildStaticArgs(PROJECT, CONFIG);
    expect(args).not.toContain("-destination");
    expect(args).not.toContain("-derivedDataPath");
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 1_000 && !cond(); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(cond()).toBe(true);
}

describe("ensureRunnerArtifact", () => {
  let fakeProject: string;
  let emptyBin: string;

  beforeAll(async () => {
    // resolveRunnerProjectPath returns the override verbatim; only its parent
    // dir is walked by the source fingerprint, so an empty one suffices.
    fakeProject = path.join(tmpRoot, "fake-runner-proj", "ArgentRunner.xcodeproj");
    await fsp.mkdir(path.dirname(fakeProject), { recursive: true });
    // An empty PATH dir makes the toolchain fingerprint deterministically
    // fall back to "unknown-xcode" instead of shelling out to real Xcode.
    emptyBin = path.join(tmpRoot, "ensure-empty-bin");
    await fsp.mkdir(emptyBin, { recursive: true });
  });

  /**
   * Run `fn` with HOME moved under a per-test dir (so the build dir stays
   * inside the fixture tree), PATH narrowed to `binDir` (empty by default, so
   * nothing reaches the real Xcode), and the project override pointed at the
   * fake, the env-swap fixture pattern launchRunner's tests established.
   */
  async function withEnsureEnv<T>(
    name: string,
    fn: () => Promise<T>,
    binDir: string = emptyBin
  ): Promise<T> {
    const saved = {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      PROJECT: process.env.ARGENT_IOS_RUNNER_PROJECT,
    };
    process.env.HOME = path.join(tmpRoot, `ensure-home-${name}`);
    process.env.PATH = binDir;
    process.env.ARGENT_IOS_RUNNER_PROJECT = fakeProject;
    try {
      return await fn();
    } finally {
      process.env.HOME = saved.HOME;
      process.env.PATH = saved.PATH;
      if (saved.PROJECT === undefined) delete process.env.ARGENT_IOS_RUNNER_PROJECT;
      else process.env.ARGENT_IOS_RUNNER_PROJECT = saved.PROJECT;
    }
  }

  /**
   * A build seam that mints the base xctestrun exactly where the real build
   * arm would, counting invocations; `gate` holds the build mid-flight (after
   * the count, before any file exists) so a test can pin what happens while a
   * build is provably in progress.
   */
  function fakeBuild(counter: { builds: number }, gate?: Promise<void>) {
    return async (derivedDataPath: string): Promise<RunnerArtifact> => {
      counter.builds += 1;
      if (gate) await gate;
      const productsDir = path.join(derivedDataPath, "Build", "Products");
      await fsp.mkdir(productsDir, { recursive: true });
      const xctestrunPath = path.join(productsDir, "ArgentRunner_iphoneos18.0-arm64.xctestrun");
      await fsp.writeFile(xctestrunPath, "plist");
      return { xctestrunPath, derivedDataPath, fromCache: false };
    };
  }

  it("reports fromCache honestly and rebuilds the same key only when forced", async () => {
    await withEnsureEnv("hit-and-force", async () => {
      const counter = { builds: 0 };
      const build = fakeBuild(counter);

      const first = await ensureRunnerArtifact(CONFIG, { build });
      expect(first.fromCache).toBe(false);

      const hit = await ensureRunnerArtifact(CONFIG, { build });
      expect(hit.fromCache).toBe(true);
      expect(hit.xctestrunPath).toBe(first.xctestrunPath);
      expect(counter.builds).toBe(1);

      const forced = await ensureRunnerArtifact(CONFIG, { build, force: true });
      expect(forced.fromCache).toBe(false);
      expect(counter.builds).toBe(2);
    });
  });

  /** Plant a fake embedded profile where the cached runner app keeps it. */
  async function writeFakeProfile(derivedDataPath: string, expiresAt: string): Promise<void> {
    const app = path.join(
      derivedDataPath,
      "Build",
      "Products",
      "Debug-iphoneos",
      "ArgentRunnerUITests-Runner.app"
    );
    await fsp.mkdir(app, { recursive: true });
    // A real .mobileprovision is a CMS blob with the plist inline; the reader
    // only needs the ExpirationDate pair to be present as plain text.
    await fsp.writeFile(
      path.join(app, "embedded.mobileprovision"),
      `\u0000cms\u0000<plist><dict><key>ExpirationDate</key>\n\t<date>${expiresAt}</date></dict></plist>`,
      "latin1"
    );
  }

  it("re-signs in place when the cached profile is within an hour of expiry", async () => {
    await withEnsureEnv("profile-expiring", async () => {
      const counter = { builds: 0 };
      const build = fakeBuild(counter);

      const first = await ensureRunnerArtifact(CONFIG, { build });
      const marker = path.join(first.derivedDataPath, "Build", "keep-me");
      await fsp.writeFile(marker, "");
      await writeFakeProfile(first.derivedDataPath, "2020-01-01T00:00:00Z");

      const renewed = await ensureRunnerArtifact(CONFIG, { build });
      expect(renewed.fromCache).toBe(false);
      expect(counter.builds).toBe(2);
      // The stamp still matched, so the tree was re-signed, not wiped.
      await expect(fsp.access(marker)).resolves.toBeUndefined();
    });
  });

  it("keeps the cache hit while the profile has more than an hour left", async () => {
    await withEnsureEnv("profile-fresh", async () => {
      const counter = { builds: 0 };
      const build = fakeBuild(counter);

      const first = await ensureRunnerArtifact(CONFIG, { build });
      await writeFakeProfile(first.derivedDataPath, "2999-01-01T00:00:00Z");

      const hit = await ensureRunnerArtifact(CONFIG, { build });
      expect(hit.fromCache).toBe(true);
      expect(counter.builds).toBe(1);
    });
  });

  it("keeps the cache hit when the profile cannot be read", async () => {
    await withEnsureEnv("profile-unreadable", async () => {
      const counter = { builds: 0 };
      const build = fakeBuild(counter);

      const first = await ensureRunnerArtifact(CONFIG, { build });
      await writeFakeProfile(first.derivedDataPath, "not a date");

      const hit = await ensureRunnerArtifact(CONFIG, { build });
      expect(hit.fromCache).toBe(true);
      expect(counter.builds).toBe(1);
    });
  });

  it("serializes concurrent same-key ensures into exactly one build", async () => {
    await withEnsureEnv("same-key", async () => {
      const counter = { builds: 0 };
      const gate = deferred();
      const build = fakeBuild(counter, gate.promise);

      const first = ensureRunnerArtifact(CONFIG, { build });
      // The first call provably holds the key's lock mid-build before the
      // second even starts, so the second MUST queue, not race.
      await until(() => counter.builds === 1);
      const second = ensureRunnerArtifact(CONFIG, { build });
      gate.resolve();

      const [a, b] = await Promise.all([first, second]);
      expect(counter.builds).toBe(1);
      expect(a.fromCache).toBe(false);
      expect(b.fromCache).toBe(true);
      expect(b.xctestrunPath).toBe(a.xctestrunPath);
    });
  });

  it("rebuilds in place when the cache key changes: one tree, no siblings", async () => {
    await withEnsureEnv("key-change", async () => {
      const counter = { builds: 0 };
      const build = fakeBuild(counter);
      const first = await ensureRunnerArtifact(CONFIG, { build });

      // A leftover of the first generation must not survive into the next:
      // mixing products across sources/Xcode/signing generations is what the
      // stamp-mismatch wipe exists to prevent.
      const leftover = path.join(first.derivedDataPath, "Build", "Products", "stale-product");
      await fsp.writeFile(leftover, "");

      // A different bundle id changes the static args and thus the cache key.
      const otherConfig: RunnerSigningConfig = {
        ...CONFIG,
        appBundleId: "com.other.argent.runner",
        testBundleId: "com.other.argent.runner.uitests",
      };
      const other = await ensureRunnerArtifact(otherConfig, { build });
      expect(other.fromCache).toBe(false);
      expect(other.derivedDataPath).toBe(first.derivedDataPath);
      await expect(fsp.access(leftover)).rejects.toThrow();

      // Flipping back rebuilds again: exactly one generation lives in the dir.
      const back = await ensureRunnerArtifact(CONFIG, { build });
      expect(back.fromCache).toBe(false);
      expect(counter.builds).toBe(3);
    });
  });

  it("rebuilds when the stamp is missing even though an xctestrun exists (interrupted build)", async () => {
    await withEnsureEnv("no-stamp", async () => {
      const counter = { builds: 0 };
      const build = fakeBuild(counter);
      const first = await ensureRunnerArtifact(CONFIG, { build });

      // The stamp is written only after a successful build, so its absence
      // means the tree cannot be trusted regardless of what files exist.
      await fsp.rm(path.join(first.derivedDataPath, ".argent-cache-key"));

      const again = await ensureRunnerArtifact(CONFIG, { build });
      expect(again.fromCache).toBe(false);
      expect(counter.builds).toBe(2);
    });
  });

  it("stamps the build dir with the cache key after a real-arm build", async () => {
    const stubBin = path.join(tmpRoot, "ensure-stub-bin");
    await fsp.mkdir(stubBin, { recursive: true });
    await fsp.writeFile(
      path.join(stubBin, "xcodebuild"),
      [
        "#!/bin/sh",
        // The toolchain fingerprint calls this first; it takes no derived dir.
        'if [ "$1" = "-version" ]; then echo "Xcode 99.0"; exit 0; fi',
        'for arg in "$@"; do derived="$arg"; done', // -derivedDataPath's value is last
        '/bin/mkdir -p "$derived/Build/Products"', // PATH holds only this stub
        ': > "$derived/Build/Products/ArgentRunner_iphoneos18.0-arm64.xctestrun"',
        "",
      ].join("\n"),
      { mode: 0o755 }
    );

    const artifact = await withEnsureEnv("stamp", () => ensureRunnerArtifact(CONFIG), stubBin);

    const stamp = await fsp.readFile(
      path.join(artifact.derivedDataPath, ".argent-cache-key"),
      "utf8"
    );
    expect(stamp).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("resolveRunnerProjectPath", () => {
  it("stamps the project-not-found error with a failure signal", () => {
    const saved = process.env.ARGENT_IOS_RUNNER_PROJECT;
    delete process.env.ARGENT_IOS_RUNNER_PROJECT;
    try {
      let caught: unknown;
      try {
        // Under vitest __dirname is the source tree, where no copy of the
        // project sits next to the module, so the not-found arm is the
        // natural outcome.
        resolveRunnerProjectPath();
      } catch (error) {
        caught = error;
      }

      expect((caught as Error).message).toContain(
        "Could not locate the ios-device-runner Xcode project"
      );
      expect((caught as Error).message).toMatch(
        /ios-device-runner\/ArgentRunner\/ArgentRunner\.xcodeproj/
      );
      // Telemetry classification (T44): the broken-install story must not
      // fall into the registry's unclassified bucket.
      const signal = getFailureSignal(caught);
      expect(signal?.error_code).toBe(FAILURE_CODES.IOS_DEVICE_RUNNER_NOT_READY);
      expect(signal?.failure_stage).toBe("ios_device_runner_project_resolve");
    } finally {
      if (saved === undefined) delete process.env.ARGENT_IOS_RUNNER_PROJECT;
      else process.env.ARGENT_IOS_RUNNER_PROJECT = saved;
    }
  });
});

describe("isProfileMissingDeviceFailure", () => {
  it("recognizes the fresh-team shape alongside the new-device shapes", () => {
    const cases = [
      "Error 0xe8008012 while installing",
      "profile doesn't include the currently selected device",
      "this provisioning profile cannot be installed on this device",
      "error: Your team has no devices from which to generate a provisioning profile.",
    ];
    for (const text of cases) {
      expect(isProfileMissingDeviceFailure(text), text).toBe(true);
    }
    expect(isProfileMissingDeviceFailure("ld: symbol(s) not found")).toBe(false);
  });
});

describe("isProfileExpiredFailure", () => {
  it("recognizes installd's expiry codes and Xcode's expiry wording", () => {
    const cases = [
      // installd, as surfaced in the launch log (MobileDevice.framework error table).
      "Failed to verify code signature of ArgentRunnerUITests-Runner.app : 0xe8008011 (This provisioning profile has expired.)",
      "Failed to verify code signature of ArgentRunnerUITests-Runner.app : 0xe8008015 (A valid provisioning profile for this executable was not found.)",
      // Xcode host-side wording (IDEFoundation).
      'error: Provisioning profile "iOS Team Provisioning Profile: com.argent.runner" expired on 2026-09-02.',
      "Profile expired on 2026-09-02.",
    ];
    for (const text of cases) {
      expect(isProfileExpiredFailure(text), text).toBe(true);
    }
    // Device-missing shapes belong to isProfileMissingDeviceFailure, not here.
    expect(
      isProfileExpiredFailure(
        "0xe8008012 (This provisioning profile cannot be installed on this device.)"
      )
    ).toBe(false);
    expect(isProfileExpiredFailure("profile doesn't include the currently selected device")).toBe(
      false
    );
    expect(isProfileExpiredFailure("ld: symbol(s) not found")).toBe(false);
  });
});

describe("xcodebuildFailureSummary", () => {
  it("extracts the error lines, deduped, instead of the boilerplate tail", () => {
    const output = [
      "Build description signature: abc",
      "/proj.xcodeproj: error: No Accounts: Add a new account in Accounts settings.",
      "/proj.xcodeproj: error: No profiles for 'com.x' were found: Xcode couldn't find any.",
      "/proj.xcodeproj: error: No Accounts: Add a new account in Accounts settings.",
      "** TEST BUILD FAILED **",
      "The following build commands failed:",
      "\tBuilding project ArgentRunner for testing with scheme ArgentRunner",
      "(1 failure)",
    ].join("\n");

    const summary = xcodebuildFailureSummary(output);

    expect(summary).toBe(
      "/proj.xcodeproj: error: No Accounts: Add a new account in Accounts settings.\n" +
        "/proj.xcodeproj: error: No profiles for 'com.x' were found: Xcode couldn't find any."
    );
    expect(summary).not.toContain("TEST BUILD FAILED");
  });

  it("falls back to the tail when no error line exists", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    expect(xcodebuildFailureSummary(lines.join("\n"))).toBe(lines.slice(-15).join("\n"));
  });
});
