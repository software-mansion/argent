import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry } from "../../src/utils/setup-registry";
import { definitionsById } from "../helpers/catalog";
import {
  appBuildArgs,
  appBuildKey,
  assertResolvedConfiguration,
  CommandExitError,
  CommandTimeoutError,
  deviceErrorText,
  freeProfileLimitMessage,
  iosAppTargets,
  isCrash,
  launchBuildCacheDir,
  pickScheme,
  runLogged,
  showBuildSettingsArgs,
  withXctraceCrashRetry,
} from "../../src/utils/ios-launch-time/workflow";

let directory: string | null = null;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = null;
});

it("advertises both launch commands as long running", () => {
  const definitions = definitionsById(createRegistry());
  expect(definitions.get("ios-launch-time-measure")?.longRunning).toBe(true);
  expect(definitions.get("ios-launch-time-profile")?.longRunning).toBe(true);
});

it("stops a logged subprocess when its tool request is cancelled", async () => {
  directory = await mkdtemp(join(tmpdir(), "argent-launch-abort-"));
  const controller = new AbortController();
  const work = runLogged(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: directory,
    logPath: join(directory, "child.log"),
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 100);
  await expect(work).rejects.toMatchObject({ name: "AbortError" });
});

it("kills a cancelled subprocess that ignores SIGTERM after the grace period", async () => {
  directory = await mkdtemp(join(tmpdir(), "argent-launch-abort-kill-"));
  const logPath = join(directory, "child.log");
  const controller = new AbortController();
  const work = runLogged(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"],
    { cwd: directory, logPath, signal: controller.signal }
  );
  // Abort only once the SIGTERM handler is installed.
  while (!(await readFile(logPath, "utf8").catch(() => "")).includes("ready")) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const started = Date.now();
  controller.abort();
  await expect(work).rejects.toMatchObject({ name: "AbortError" });
  expect(Date.now() - started).toBeLessThan(7_000);
}, 15_000);

it("marks a subprocess that runs past its timeout", async () => {
  directory = await mkdtemp(join(tmpdir(), "argent-launch-timeout-"));
  const error = await runLogged(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: directory,
    logPath: join(directory, "child.log"),
    timeoutMs: 200,
  }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CommandTimeoutError);
  expect((error as CommandTimeoutError).timedOut).toBe(true);
});

it("passes the requested configuration to xcodebuild", () => {
  const settings = showBuildSettingsArgs("App.xcodeproj", "App", "Production", "dest", "/dd");
  expect(settings[settings.indexOf("-configuration") + 1]).toBe("Production");
  const build = appBuildArgs("App.xcodeproj", "App", "Production", "dest", "/dd", ["X=1"]);
  expect(build[0]).toBe("build");
  expect(build[build.indexOf("-configuration") + 1]).toBe("Production");
  expect(build).not.toContain("Release");
  expect(build.at(-1)).toBe("X=1");
});

it("checks the resolved CONFIGURATION against the requested one", () => {
  expect(() =>
    assertResolvedConfiguration({ CONFIGURATION: "Production" }, "Production")
  ).not.toThrow();
  expect(() => assertResolvedConfiguration({ CONFIGURATION: "Release" }, "Production")).toThrow(
    "Xcode did not resolve the app to Production."
  );
});

it("keeps build caches of different configurations apart", () => {
  const a = appBuildKey("c", "s", "d", "Release", "Xcode 26.3");
  expect(a).toBe(appBuildKey("c", "s", "d", "Release", "Xcode 26.3"));
  expect(a).not.toBe(appBuildKey("c", "s", "d", "Production", "Xcode 26.3"));
});

it("keeps build caches of different Xcode versions apart", () => {
  expect(appBuildKey("c", "s", "d", "Release", "Xcode 26.3")).not.toBe(
    appBuildKey("c", "s", "d", "Release", "Xcode 26.4")
  );
});

describe("freeProfileLimitMessage", () => {
  const cap =
    "This device has reached the maximum number of installed apps using a free developer profile.";
  // Trimmed from a real xcodebuild log: the installed IDs follow the cap line
  // inside `{( ... )}`, each with its team prefix. The own runner of that run
  // was com.argent.runner.t5dpz5ekad8; t5w6h93822s was a leftover of another team.
  const xcodebuildLog = `Testing failed:
\tUnable to Install “ArgentRunnerUITests-Runner”
Recovery Suggestion: This device has reached the maximum number of installed apps using a free developer profile: {(
    "5DPZ5EKAD8.com.maciekstosio.ttiledgerapp",
    "2D63C2YCBH.org.reactjs.native.example.--PRODUCT-NAME-rfc1034identifier-oskar",
    "5W6H93822S.com.argent.runner.t5w6h93822s.uitests.xctrunner"
)}
User Info: {
    DVTErrorCreationDateKey = "2026-10-09 11:39:54 +0000";
    IDERunOperationFailingWorker = IDEInstallCoreDeviceWorker;
}
    ARGENT_RUNNER_APP_BUNDLE_ID=com.argent.runner.t5dpz5ekad8
** TEST FAILED **`;

  it("ignores text without the free-profile cap", () => {
    expect(
      freeProfileLimitMessage("No profiles for x", { subject: "s", logPath: "/l" })
    ).toBeNull();
  });

  it("explains the cap and names the log", () => {
    const message = freeProfileLimitMessage(cap, { subject: "the runner", logPath: "/l.log" });
    expect(message).toContain("no slot for the runner");
    expect(message).toContain("Log: /l.log");
    expect(message).not.toContain("leftover");
  });

  it("names a team-prefixed Argent runner of another team from the installed list", () => {
    const message = freeProfileLimitMessage(xcodebuildLog, {
      subject: "the runner",
      logPath: "/l",
      ownBundleIdPrefix: "com.argent.runner.t5dpz5ekad8",
    });
    expect(message).toContain(
      "com.argent.runner.t5w6h93822s looks like a leftover Argent runner from a different team"
    );
    expect(message).not.toContain("t5dpz5ekad8");
  });

  it("does not call the own runner a leftover", () => {
    const message = freeProfileLimitMessage(xcodebuildLog, {
      subject: "the runner",
      logPath: "/l",
      ownBundleIdPrefix: "com.argent.runner.T5W6H93822S",
    });
    expect(message).not.toContain("t5w6h93822s");
    // The own runner's ID outside the installed list is not a leftover either.
    expect(message).not.toContain("t5dpz5ekad8");
  });

  it("does not claim a different team when the own runner is unknown", () => {
    const message = freeProfileLimitMessage(xcodebuildLog, { subject: "the app" });
    expect(message).toContain("com.argent.runner.t5w6h93822s is an installed Argent runner");
    expect(message).not.toContain("different team");
  });

  it("reads the installed IDs from a multi-line devicectl install failure", () => {
    // runDevicectl keeps only the first stderr line in the message; the rest
    // stays in the stderr of the execFile error it wraps as the cause.
    const stderr = `ERROR: Unable to Install “Ledger” (com.apple.dt.CoreDeviceError error 3002.)
       NSURL = file:///tmp/Ledger.app/
--
This device has reached the maximum number of installed apps using a free developer profile: {(
    "5DPZ5EKAD8.com.maciekstosio.ttiledgerapp",
    "5W6H93822S.com.argent.runner.t5w6h93822s.uitests.xctrunner"
)} (MIInstallerErrorDomain error 13.)`;
    const error = new Error(
      "Failed to install app: ERROR: Unable to Install “Ledger” (com.apple.dt.CoreDeviceError error 3002.)",
      { cause: Object.assign(new Error("Command failed"), { stderr }) }
    );
    expect(freeProfileLimitMessage(error.message, { subject: "the app" })).toBeNull();
    const message = freeProfileLimitMessage(deviceErrorText(error), {
      subject: "the app com.maciekstosio.ttiledgerapp",
      ownBundleIdPrefix: "com.argent.runner.t5dpz5ekad8",
    });
    expect(message).toContain("no slot for the app com.maciekstosio.ttiledgerapp");
    expect(message).toContain("com.argent.runner.t5w6h93822s looks like a leftover");
  });
});

it("reports the free-profile cap from a failed logged command, not a signing hint", async () => {
  directory = await mkdtemp(join(tmpdir(), "argent-launch-free-"));
  const script =
    "console.error('error: Provisioning Profile: x'); " +
    "console.error('maximum number of installed apps using a free developer profile'); process.exit(65)";
  const error = await runLogged(process.execPath, ["-e", script], {
    cwd: directory,
    logPath: join(directory, "child.log"),
  }).catch((e: Error) => e);
  expect((error as Error).message).toContain("free developer profile");
  expect((error as Error).message).not.toContain("Provisioning failed");
});

it("defaults the app configuration to Release in both tool schemas", () => {
  const definitions = definitionsById(createRegistry());
  for (const id of ["ios-launch-time-measure", "ios-launch-time-profile"]) {
    const schema = definitions.get(id)!.zodSchema as import("zod").ZodType;
    const parsed = schema.parse({ workspace_path: "/x" }) as { configuration: string };
    expect(parsed.configuration).toBe("Release");
  }
});

it("picks the app scheme among the schemes CocoaPods adds", () => {
  const pods = new Set(["React-Core", "Yoga", "Pods-App"]);
  const all = ["App", "React-Core", "Yoga", "Pods-App"];
  expect(pickScheme(all, "/r/ios/App.xcworkspace", pods)).toBe("App");
  expect(pickScheme(["Only"], "/r/ios/App.xcworkspace", new Set())).toBe("Only");
  // Several app schemes: the one named after the workspace wins.
  expect(pickScheme(["Runner", "Runner-Dev", "Yoga"], "/r/ios/Runner.xcworkspace", pods)).toBe(
    "Runner"
  );
  expect(pickScheme(["Dev", "Prod"], "/r/ios/App.xcworkspace", new Set())).toBeNull();
});

it("selects the iOS app target over embedded watch apps and App Clips", () => {
  const target = (name: string, settings: Record<string, string>) => ({
    target: name,
    buildSettings: { WRAPPER_EXTENSION: "app", ...settings },
  });
  const app = target("App", {
    PRODUCT_TYPE: "com.apple.product-type.application",
    PLATFORM_NAME: "iphoneos",
  });
  const watch = target("Watch", {
    PRODUCT_TYPE: "com.apple.product-type.application",
    PLATFORM_NAME: "watchos",
  });
  const clip = target("Clip", {
    PRODUCT_TYPE: "com.apple.product-type.application.on-demand-install-capable",
    PLATFORM_NAME: "iphoneos",
  });
  const widget = { target: "Widget", buildSettings: { WRAPPER_EXTENSION: "appex" } };
  expect(iosAppTargets([app, watch, clip, widget])).toEqual([app]);
  const unknown = target("Legacy", {});
  expect(iosAppTargets([unknown, widget])).toEqual([unknown]);
});

it("keeps launch build caches out of the app project", () => {
  expect(launchBuildCacheDir("app", "k")).toBe(
    join(homedir(), ".argent", "build-cache", "ios-launch-time", "k")
  );
  expect(launchBuildCacheDir("runner", "k")).toBe(
    join(homedir(), ".argent", "build-cache", "ios-launch-time-runner", "k")
  );
});

describe("xctrace crash retry", () => {
  const exitError = (code: number | null, signal: NodeJS.Signals | null) =>
    new CommandExitError("xcrun failed", code, signal);
  // execFile rejects with the same fields on a plain Error.
  const execFileError = (code: number | null, signal: string | null) =>
    Object.assign(new Error("Command failed: xcrun xctrace export --toc"), { code, signal });

  it("classifies segfaults and other crash signals as crashes", () => {
    expect(isCrash(exitError(139, null))).toBe(true);
    expect(isCrash(exitError(null, "SIGSEGV"))).toBe(true);
    expect(isCrash(exitError(null, "SIGBUS"))).toBe(true);
    expect(isCrash(exitError(null, "SIGABRT"))).toBe(true);
    expect(isCrash(execFileError(null, "SIGSEGV"))).toBe(true);
    expect(isCrash(execFileError(139, null))).toBe(true);
  });

  it("does not classify timeouts, aborts or ordinary exits as crashes", () => {
    expect(isCrash(exitError(1, null))).toBe(false);
    expect(isCrash(execFileError(1, null))).toBe(false);
    expect(isCrash(new CommandTimeoutError("timed out"))).toBe(false);
    expect(isCrash(execFileError(null, "SIGTERM"))).toBe(false);
    expect(isCrash(exitError(null, "SIGKILL"))).toBe(false);
    expect(isCrash(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(false);
    expect(isCrash(Object.assign(new Error("spawn"), { code: "ENOENT" }))).toBe(false);
    expect(isCrash(null)).toBe(false);
  });

  it("succeeds on the third attempt after two crashes", async () => {
    let calls = 0;
    const result = await withXctraceCrashRetry(async () => {
      calls += 1;
      if (calls < 3) throw exitError(null, "SIGSEGV");
      return "toc";
    });
    expect(result).toBe("toc");
    expect(calls).toBe(3);
  });

  it("gives up after three crashes", async () => {
    let calls = 0;
    const error = await withXctraceCrashRetry(async () => {
      calls += 1;
      throw exitError(139, null);
    }).catch((e: unknown) => e);
    expect(isCrash(error)).toBe(true);
    expect(calls).toBe(3);
  });

  it.each([
    ["a timeout", new CommandTimeoutError("timed out")],
    ["an abort", Object.assign(new Error("aborted"), { name: "AbortError" })],
    ["a plain exit 1", exitError(1, null)],
  ])("does not retry %s", async (_label, failure) => {
    let calls = 0;
    const error = await withXctraceCrashRetry(async () => {
      calls += 1;
      throw failure;
    }).catch((e: unknown) => e);
    expect(error).toBe(failure);
    expect(calls).toBe(1);
  });

  it("stops retrying once the request is cancelled", async () => {
    const controller = new AbortController();
    let calls = 0;
    const work = withXctraceCrashRetry(async () => {
      calls += 1;
      controller.abort();
      throw exitError(null, "SIGSEGV");
    }, controller.signal);
    await expect(work).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });

  it("exposes the signal of a logged command that crashed", async () => {
    directory = await mkdtemp(join(tmpdir(), "argent-launch-crash-"));
    const error = await runLogged("/bin/sh", ["-c", "kill -SEGV $$"], {
      cwd: directory,
      logPath: join(directory, "child.log"),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommandExitError);
    expect(error).toMatchObject({ code: null, signal: "SIGSEGV" });
    expect((error as Error).message).toContain("was killed by SIGSEGV");
    expect(isCrash(error)).toBe(true);
  });

  it("exposes the exit code of a logged command that failed", async () => {
    directory = await mkdtemp(join(tmpdir(), "argent-launch-exit-"));
    const error = await runLogged("/bin/sh", ["-c", "exit 1"], {
      cwd: directory,
      logPath: join(directory, "child.log"),
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 1, signal: null });
    expect(isCrash(error)).toBe(false);
  });
});
