import { execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import {
  assertXctestrunParses,
  computeRunnerCacheKey,
  ensureRunnerArtifact,
  isProfileMissingDeviceFailure,
  killStaleRunnersForDevice,
  launchRunner,
  PROCESS_TABLE_ARGV,
  resolveRunnerProjectPath,
  resolveRunnerSigningConfig,
  resolveSigningHint,
  runnerBuildStaticArgs,
  waitForPidsToExit,
  xcodebuildFailureSummary,
  XctestrunFormatError,
  type RunnerArtifact,
  type RunnerSigningConfig,
} from "../src/utils/ios-device/runner-build";
import { PS_BIN } from "../src/utils/vega-process";
import { __setCertificateListerForTests } from "../src/utils/ios-device/team-detect";
import { TEAM_B_PEM } from "./fixtures/signing-certs";

const execFileAsync = promisify(execFile);

let tmpRoot: string;
beforeAll(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "argent-runner-build-"));
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

describe("resolveRunnerSigningConfig", () => {
  // The keychain seam: every case pins the lister, so no test ever shells out
  // to the developer's real `security` keychain.
  beforeEach(() => __setCertificateListerForTests(async () => ""));
  afterEach(() => {
    delete process.env.ARGENT_IOS_TEAM_ID;
    __setCertificateListerForTests(null);
  });

  it("derives the whole config from ARGENT_IOS_TEAM_ID without touching the keychain", async () => {
    process.env.ARGENT_IOS_TEAM_ID = " FGHIJ67890 ";
    const lister = vi.fn(async () => "");
    __setCertificateListerForTests(lister);

    await expect(resolveRunnerSigningConfig()).resolves.toEqual({
      teamId: "FGHIJ67890",
      appBundleId: "com.argent.runner.tfghij67890",
      testBundleId: "com.argent.runner.tfghij67890.uitests",
    });
    expect(lister).not.toHaveBeenCalled();
  });

  it("falls back to the detected team when the env var is unset", async () => {
    __setCertificateListerForTests(async (cn) => (cn === "Apple Development" ? TEAM_B_PEM : ""));

    await expect(resolveRunnerSigningConfig()).resolves.toEqual({
      teamId: "FGHIJ67890",
      appBundleId: "com.argent.runner.tfghij67890",
      testBundleId: "com.argent.runner.tfghij67890.uitests",
    });
  });

  it("answers an empty keychain with the sign-into-Xcode error, never naming the env var", async () => {
    const caught: unknown = await resolveRunnerSigningConfig().then(
      () => null,
      (error: unknown) => error
    );

    expect((caught as Error).message).toBe(
      "No Apple Development signing certificate was found in this Mac's keychain, " +
        "so the on-device runner cannot be signed. Open Xcode > Settings > Accounts " +
        "and sign in with your Apple ID; then, still in that pane, choose Manage " +
        "Certificates and click + > Apple Development. Retry once the certificate " +
        "exists; argent detects the team automatically."
    );
    // The pre-detection message told users to set ARGENT_IOS_TEAM_ID; with no
    // certificate a team id alone could not sign anything, so it must be gone.
    expect((caught as Error).message).not.toContain("ARGENT_IOS_TEAM_ID");
    const signal = getFailureSignal(caught);
    expect(signal?.error_code).toBe(FAILURE_CODES.IOS_DEVICE_RUNNER_NOT_READY);
    expect(signal?.failure_stage).toBe("ios_device_signing_team");
    expect(signal?.error_kind).toBe("validation");
  });
});

describe("computeRunnerCacheKey", () => {
  it("is stable for identical inputs", () => {
    const a = computeRunnerCacheKey("srcs", "Xcode 16.4", runnerBuildStaticArgs(PROJECT, CONFIG));
    const b = computeRunnerCacheKey("srcs", "Xcode 16.4", runnerBuildStaticArgs(PROJECT, CONFIG));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("changes when a static xcodebuild arg is edited", () => {
    const args = runnerBuildStaticArgs(PROJECT, CONFIG);
    const edited = args.map((a) => (a === "ENABLE_DEBUG_DYLIB=NO" ? "ENABLE_DEBUG_DYLIB=YES" : a));
    expect(edited).not.toEqual(args); // guards the fixture against arg drift
    expect(computeRunnerCacheKey("srcs", "x", edited)).not.toBe(
      computeRunnerCacheKey("srcs", "x", args)
    );
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

describe("resolveSigningHint", () => {
  it("answers the fresh-team failure with the registration hint, not the sign-in one", () => {
    const hint = resolveSigningHint(
      "error: Your team has no devices from which to generate a provisioning profile."
    );
    expect(hint).toContain("no registered devices");
    expect(hint).not.toContain("Xcode > Settings > Accounts");
  });

  it("maps the explicit registration failure to the personal-team cap", () => {
    expect(
      resolveSigningHint("error: Failed Registering Bundle Identifier (in target 'ArgentRunner')")
    ).toContain("Personal Team");
  });

  it("gives the registration hint when 'is not available' carries registration context", () => {
    const output =
      'The app identifier "com.argent.runner.tabcde12345" cannot be registered to your ' +
      "development team because it is not available.";
    expect(resolveSigningHint(output)).toContain("Personal Team");
  });

  it("does not blame registration for unrelated 'is not available' failures", () => {
    const output =
      "xcodebuild: error: iPhone 15 with iOS 18.0 is not available for this run destination.";
    expect(resolveSigningHint(output)).toBeNull();
  });

  it("maps provisioning failures to the Xcode sign-in hint", () => {
    expect(
      resolveSigningHint('No profiles for "com.argent.runner.tabcde12345" were found')
    ).toContain("Xcode > Settings > Accounts");
  });
});

/**
 * Run launchRunner with PATH replaced by `pathDir` (so "xcodebuild" resolves
 * to a stub, or to nothing) and HOME moved under tmpRoot (so the launch log
 * lands in the fixture tree, not the real ~/.argent).
 */
async function launchWithPath(pathDir: string): Promise<Awaited<ReturnType<typeof launchRunner>>> {
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
  process.env.PATH = pathDir;
  process.env.HOME = tmpRoot;
  try {
    return await launchRunner({
      udid: "00008120-000000000000001E",
      xctestrunPath: path.join(tmpRoot, "fake.xctestrun"),
      derivedDataPath: path.join(tmpRoot, "derived"),
      port: 50505,
    });
  } finally {
    process.env.PATH = saved.PATH;
    process.env.HOME = saved.HOME;
  }
}

describe("launchRunner", () => {
  it("rejects with the wrapped spawn failure instead of crashing the process", async () => {
    const emptyBin = path.join(tmpRoot, "empty-bin");
    await fsp.mkdir(emptyBin, { recursive: true });

    // Before the spawn/error race, the ENOENT arrived as an unhandled async
    // "error" event; this test completing green is the no-crash proof.
    const error = await launchWithPath(emptyBin).catch((caught: unknown) => caught);

    expect((error as Error).name).toBe("FailureError");
    expect((error as Error).message).toBe(
      "xcodebuild could not be started. Check that Xcode is installed and on PATH."
    );
    expect(((error as Error).cause as NodeJS.ErrnoException).code).toBe("ENOENT");
  });

  it("resolves with the launched child and per-device log and bundle paths", async () => {
    const stubBin = path.join(tmpRoot, "stub-bin");
    await fsp.mkdir(stubBin, { recursive: true });
    // The stub echoes the forwarded port variable and its argv so the log
    // pins that the session's port rides the spawn env as TEST_RUNNER_<VAR>
    // and that the crash bundle path is pinned on the command line.
    await fsp.writeFile(
      path.join(stubBin, "xcodebuild"),
      '#!/bin/sh\necho "PORT=$TEST_RUNNER_ARGENT_RUNNER_PORT ARGS=$@"\nexit 0\n',
      { mode: 0o755 }
    );

    const launched = await launchWithPath(stubBin);

    expect(launched.child.pid).toBeGreaterThan(0);
    expect(path.dirname(launched.logPath)).toBe(
      path.join(tmpRoot, ".argent", "ios-device-runner", "logs")
    );
    // Fixed per-device names: the whole retention policy is overwrite-on-launch.
    expect(path.basename(launched.logPath)).toBe("runner-00008120.log");
    expect(launched.resultBundlePath).toBe(
      path.join(tmpRoot, ".argent", "ios-device-runner", "results", "argent-00008120.xcresult")
    );
    await once(launched.child, "exit");
    const log = await fsp.readFile(launched.logPath, "utf8");
    expect(log).toContain("PORT=50505");
    expect(log).toContain("-resultBundlePath");
    // The swallow listener that keeps a late "error" from becoming uncaught.
    expect(launched.child.listenerCount("error")).toBe(1);

    // A second launch truncates the log rather than appending to it.
    const second = await launchWithPath(stubBin);
    await once(second.child, "exit");
    const secondLog = await fsp.readFile(second.logPath, "utf8");
    expect(secondLog.match(/PORT=/g)).toHaveLength(1);
  });
});

/**
 * Fake process table driving waitForPidsToExit's seams; no real processes.
 * `dyingAfterPolls` maps a pid to the number of sleeps after which its
 * liveness probe starts reporting it gone; pids absent from the map are dead
 * from the start, Infinity ignores SIGTERM forever.
 */
function fakeProcessTable(dyingAfterPolls: Record<number, number>) {
  let polls = 0;
  const sleeps: number[] = [];
  const kills: Array<{ pid: number; signal: string }> = [];
  return {
    sleeps,
    kills,
    isAlive: (pid: number) => (dyingAfterPolls[pid] ?? -1) > polls,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      polls += 1;
    },
    kill: (pid: number, signal: string) => {
      kills.push({ pid, signal });
    },
  };
}

describe("waitForPidsToExit", () => {
  it("polls the bounded window then SIGKILLs the process group of a holdout", async () => {
    const table = fakeProcessTable({ 101: Infinity });

    const holdouts = await waitForPidsToExit([101], {
      ...table,
      timeoutMs: 500,
      pollIntervalMs: 100,
    });

    expect(holdouts).toEqual([101]);
    expect(table.sleeps).toEqual([100, 100, 100, 100, 100]);
    expect(table.kills).toEqual([{ pid: -101, signal: "SIGKILL" }]);
  });

  it("SIGKILLs only the holdout when the other pid exits mid-window", async () => {
    const table = fakeProcessTable({ 101: 2, 102: Infinity });

    const holdouts = await waitForPidsToExit([101, 102], {
      ...table,
      timeoutMs: 300,
      pollIntervalMs: 100,
    });

    expect(holdouts).toEqual([102]);
    expect(table.kills).toEqual([{ pid: -102, signal: "SIGKILL" }]);
  });

  it("tolerates a pid exiting between the last poll and the escalation", async () => {
    const table = fakeProcessTable({ 101: Infinity });

    const holdouts = await waitForPidsToExit([101], {
      ...table,
      timeoutMs: 100,
      pollIntervalMs: 100,
      kill: () => {
        throw new Error("ESRCH: no such process");
      },
    });

    expect(holdouts).toEqual([101]);
  });
});

const STALE_UDID = "00008120-000000000000001E";
const STALE_XCTESTRUN =
  "/Users/dev/.argent/ios-device-runner/derived/cache-aaaa111122223333/Build/Products/" +
  "ArgentRunner_iphoneos18.0-arm64.xctestrun";

/**
 * One `ps -ax -o pid=,ppid=,command=` line shaped like a launched runner.
 * The defaults satisfy all three argv filter clauses; each override drops
 * exactly one, so a spared override pins that clause individually.
 */
function runnerPsLine(opts: {
  pid: number;
  ppid: number;
  action?: string;
  udid?: string;
  xctestrun?: string;
}): string {
  return [
    String(opts.pid).padStart(5),
    String(opts.ppid).padStart(5),
    "/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild",
    opts.action ?? "test-without-building",
    "-xctestrun",
    opts.xctestrun ?? STALE_XCTESTRUN,
    "-destination",
    `platform=iOS,id=${opts.udid ?? STALE_UDID}`,
  ].join(" ");
}

function fakeSweepDeps(dyingAfterPolls: Record<number, number>, psLines: string[]) {
  return {
    ...fakeProcessTable(dyingAfterPolls),
    listProcesses: async () => psLines.join("\n"),
    timeoutMs: 300,
    pollIntervalMs: 100,
  };
}

describe("killStaleRunnersForDevice", () => {
  it("SIGTERMs an orphan re-parented to launchd (ppid 1), ignoring unrelated lines", async () => {
    const deps = fakeSweepDeps({}, [
      "  400     1 /usr/local/bin/node /opt/argent/dist/server.js",
      runnerPsLine({ pid: 101, ppid: 1 }),
    ]);

    const killed = await killStaleRunnersForDevice(STALE_UDID, deps);

    expect(killed).toBe(1);
    expect(deps.kills).toEqual([{ pid: -101, signal: "SIGTERM" }]);
    expect(deps.sleeps).toEqual([]);
  });

  it("SIGTERMs an orphan whose parent pid is no longer alive", async () => {
    // ppid 4242 is absent from the table, so the liveness probe reports it
    // gone: the owning tool-server died without launchd adoption completing.
    const deps = fakeSweepDeps({}, [runnerPsLine({ pid: 101, ppid: 4242 })]);

    const killed = await killStaleRunnersForDevice(STALE_UDID, deps);

    expect(killed).toBe(1);
    expect(deps.kills).toEqual([{ pid: -101, signal: "SIGTERM" }]);
  });

  it("spares a matched runner whose parent is a LIVE peer tool-server", async () => {
    const deps = fakeSweepDeps({ 4242: Infinity }, [runnerPsLine({ pid: 101, ppid: 4242 })]);

    const killed = await killStaleRunnersForDevice(STALE_UDID, deps);

    expect(killed).toBe(0); // the peer's session conflict is testmanagerd's to report
    expect(deps.kills).toEqual([]);
    expect(deps.sleeps).toEqual([]);
  });

  it("never signals its own pid, even when it would count as an orphan", async () => {
    const deps = fakeSweepDeps({}, [runnerPsLine({ pid: process.pid, ppid: 1 })]);

    expect(await killStaleRunnersForDevice(STALE_UDID, deps)).toBe(0);
    expect(deps.kills).toEqual([]);
  });

  // The three clause tests below each present an ORPHAN (ppid 1), so the only
  // thing sparing it is the missing argv clause under test.
  it("spares a line without the test-without-building clause (a build is not a runner)", async () => {
    const deps = fakeSweepDeps({}, [
      runnerPsLine({ pid: 101, ppid: 1, action: "build-for-testing" }),
    ]);

    expect(await killStaleRunnersForDevice(STALE_UDID, deps)).toBe(0);
    expect(deps.kills).toEqual([]);
  });

  it("spares a runner driving a DIFFERENT device", async () => {
    const deps = fakeSweepDeps({}, [
      runnerPsLine({ pid: 101, ppid: 1, udid: "00008120-FFFFFFFFFFFFFFFF" }),
    ]);

    expect(await killStaleRunnersForDevice(STALE_UDID, deps)).toBe(0);
    expect(deps.kills).toEqual([]);
  });

  it("spares an xcodebuild test run outside our cache root", async () => {
    const deps = fakeSweepDeps({}, [
      runnerPsLine({
        pid: 101,
        ppid: 1,
        xctestrun: "/Users/dev/proj/build/MyAppUITests.xctestrun",
      }),
    ]);

    expect(await killStaleRunnersForDevice(STALE_UDID, deps)).toBe(0);
    expect(deps.kills).toEqual([]);
  });

  it("escalates a SIGTERM-ignoring orphan to SIGKILL via waitForPidsToExit", async () => {
    const deps = fakeSweepDeps({ 101: Infinity }, [runnerPsLine({ pid: 101, ppid: 1 })]);

    const killed = await killStaleRunnersForDevice(STALE_UDID, deps);

    expect(killed).toBe(1);
    expect(deps.sleeps).toEqual([100, 100, 100]);
    expect(deps.kills).toEqual([
      { pid: -101, signal: "SIGTERM" },
      { pid: -101, signal: "SIGKILL" },
    ]);
  });

  it("falls back to a bare-pid SIGTERM when the process-group signal fails", async () => {
    const kills: Array<{ pid: number; signal: string }> = [];
    const deps = {
      ...fakeSweepDeps({}, [runnerPsLine({ pid: 101, ppid: 1 })]),
      kill: (pid: number, signal: string) => {
        kills.push({ pid, signal });
        if (pid < 0) throw new Error("EPERM: operation not permitted");
      },
    };

    expect(await killStaleRunnersForDevice(STALE_UDID, deps)).toBe(1);
    expect(kills).toEqual([
      { pid: -101, signal: "SIGTERM" },
      { pid: 101, signal: "SIGTERM" },
    ]);
  });

  it("treats a failed ps snapshot as nothing to reap", async () => {
    const deps = {
      ...fakeSweepDeps({}, []),
      listProcesses: async (): Promise<string> => {
        throw new Error("ps: command failed");
      },
    };

    expect(await killStaleRunnersForDevice(STALE_UDID, deps)).toBe(0);
    expect(deps.kills).toEqual([]);
  });

  it("default ps provider spawns the absolute PS_BIN, immune to a GUI-launched /bin-less PATH", () => {
    const [bin, ...args] = PROCESS_TABLE_ARGV;
    expect(bin).toBe(PS_BIN);
    expect(path.isAbsolute(bin)).toBe(true);
    expect(args).toEqual(["-ax", "-o", "pid=,ppid=,command="]);
  });
});
