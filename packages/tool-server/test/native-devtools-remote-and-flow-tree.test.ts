import { describe, it, expect, vi } from "vitest";

// The ios-remote host's `inspectRunningApp`: on ios-remote the
// running/indeterminate split is the ONLY distinction available — it drives
// `requiresRestart` and `describe`'s `should_restart`.

const remote = vi.hoisted(() => ({ stdout: "", calls: 0, fail: false }));

vi.mock("@argent/native-devtools-ios", () => ({
  bootstrapDylibPath: () => "/fake/dylibs/libArgentInjectionBootstrap.dylib",
  bootstrapDylibPathTcp: () => "/fake/dylibs/tcp/libArgentInjectionBootstrap.dylib",
  bootstrapDylibPathTvos: () => "/fake/dylibs/tvos/libArgentInjectionBootstrap.dylib",
  tcpInjectionDylibs: () => [],
  axServiceBinaryPath: () => "/fake/ax-service",
  axServiceBinaryPathTcp: () => "/fake/ax-service-tcp",
}));

vi.mock("../src/utils/sim-remote", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/sim-remote")>()),
  simctlSpawn: vi.fn(async () => {
    remote.calls += 1;
    if (remote.fail) throw new Error("tunnel down");
    return { stdout: remote.stdout, stderr: "" };
  }),
}));

import { remoteIosHost } from "../src/utils/ios-host";

const UDID = "AAAAAAAA-1111-2222-3333-444444444444";
const BUNDLE = "com.example.app";

describe("remoteIosHost.inspectRunningApp", () => {
  it("reports running-ness from the orchestrator and leaves the process unknown", async () => {
    remote.stdout = `4242\t0\tUIKitApplication:${BUNDLE}[dffa][rb-legacy]\n`;
    remote.calls = 0;

    const inspection = await remoteIosHost.inspectRunningApp(UDID, BUNDLE);

    // `running` must come off the real row: assuming true makes every stopped
    // remote app `indeterminate`, answered with a restart of an app that is not
    // there, and assuming false makes every running one `not_running`.
    expect(inspection.running).toBe(true);
    // App processes live on the orchestrator, so the local process table has
    // nothing to say — a fabricated process here would be judged against this
    // listener and reported as a definite verdict.
    expect(inspection.process).toBeNull();
    expect(remote.calls).toBe(1);
  });

  it("reports not running when no row backs the bundle", async () => {
    remote.stdout = `4242\t0\tUIKitApplication:com.other.app[dffa][rb-legacy]\n`;

    await expect(remoteIosHost.inspectRunningApp(UDID, BUNDLE)).resolves.toEqual({
      running: false,
      process: null,
    });
  });
});
