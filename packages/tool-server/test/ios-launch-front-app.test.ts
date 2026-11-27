import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** What happened, in order: `launch` for `simctl launch`, `front <id>` for each foreground read. */
const events: string[] = [];

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (
      _cmd: string,
      args: readonly string[],
      opts: unknown,
      cb?: (err: Error | null, out: { stdout: string; stderr: string }) => void
    ) => {
      if (args[0] === "simctl" && args[1] === "launch") events.push("launch");
      const callback = (typeof opts === "function" ? opts : cb!) as NonNullable<typeof cb>;
      callback(null, { stdout: "", stderr: "" });
    },
  };
});

const tvOs = vi.hoisted(() => ({ value: false }));
vi.mock("../src/utils/ios-devices", () => ({
  isTvOsSimulator: vi.fn(async () => tvOs.value),
}));

vi.mock("../src/blueprints/native-devtools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/blueprints/native-devtools")>()),
  precheckNativeDevtools: async () => undefined,
}));

import { ArtifactStore, type Registry } from "@argent/registry";
import { AX_SERVICE_NAMESPACE } from "../src/blueprints/ax-service";
import { createLaunchAppTool } from "../src/tools/launch-app";
import { createRestartAppTool } from "../src/tools/restart-app";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";
import { isTvOsSimulator } from "../src/utils/ios-devices";

const UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const APP = "com.example.portrait";
const PREVIOUS = "com.example.landscape";

/** The bundle ids the ax-service names as in front, one per read; the last one repeats. */
let fronts: string[];
let axUnavailable: boolean;
const foregroundApp = vi.fn(async () => {
  const bundleId = fronts.length > 1 ? fronts.shift()! : fronts[0]!;
  events.push(`front ${bundleId}`);
  return { alertVisible: false, bundleId };
});

const registry = {
  resolveService: vi.fn(async (urn: string) => {
    if (!urn.startsWith(`${AX_SERVICE_NAMESPACE}:`)) {
      return { networkCaptureAfterLaunch: async () => undefined };
    }
    events.push("ax");
    if (axUnavailable) throw new Error("ax-service could not start");
    return { foregroundApp };
  }),
} as unknown as Registry;

const tools = [
  {
    name: "launch-app",
    run: (signal?: AbortSignal) =>
      createLaunchAppTool(registry).execute!(
        {},
        { udid: UDID, bundleId: APP },
        { artifacts: new ArtifactStore(), signal }
      ),
    ok: { launched: true, bundleId: APP },
  },
  {
    name: "restart-app",
    run: (signal?: AbortSignal) =>
      createRestartAppTool(registry).execute!(
        {},
        { udid: UDID, bundleId: APP },
        { artifacts: new ArtifactStore(), signal }
      ),
    ok: { restarted: true, bundleId: APP },
  },
] as const;

beforeEach(() => {
  events.length = 0;
  fronts = [APP];
  axUnavailable = false;
  tvOs.value = false;
  vi.mocked(isTvOsSimulator).mockImplementation(async () => tvOs.value);
  foregroundApp.mockClear();
  __resetDepCacheForTests();
  __primeDepCacheForTests(["xcrun"]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe.each(tools)("$name on an iOS simulator", ({ run, ok }) => {
  it("answers once the accessibility service names the started app in front", async () => {
    // The service still resolves the app that was in front for a while after
    // `simctl launch` returns; what is read then (the orientation captures and
    // touches are turned by, the tree) would be that app's.
    fronts = [PREVIOUS, PREVIOUS, APP];

    await expect(run()).resolves.toEqual(ok);

    expect(events.filter((e) => e !== "ax")).toEqual([
      "launch",
      `front ${PREVIOUS}`,
      `front ${PREVIOUS}`,
      `front ${APP}`,
    ]);
  });

  it("starts the accessibility service before the launch", async () => {
    await expect(run()).resolves.toEqual(ok);

    expect(events.indexOf("ax")).toBeLessThan(events.indexOf("launch"));
  });

  it("stops waiting after 5 s for an app that never comes to the front", async () => {
    vi.useFakeTimers();
    fronts = [PREVIOUS];
    let settled = false;
    const result = run().finally(() => (settled = true));

    await vi.advanceTimersByTimeAsync(4_900);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);

    await expect(result).resolves.toEqual(ok);
    expect(events.at(-1)).toBe(`front ${PREVIOUS}`);
  });

  it("does not wait when the accessibility service cannot be asked", async () => {
    axUnavailable = true;

    await expect(run()).resolves.toEqual(ok);

    expect(foregroundApp).not.toHaveBeenCalled();
  });

  it.each(["timeout", "abort"] as const)(
    "handles %s during a stalled simulator lookup",
    async (end) => {
      vi.useFakeTimers();
      vi.mocked(isTvOsSimulator).mockImplementation(() => new Promise<boolean>(() => {}));
      const controller = new AbortController();
      let settled = false;
      const result = run(controller.signal).finally(() => (settled = true));
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(false);
      if (end === "abort") controller.abort();
      await vi.advanceTimersByTimeAsync(end === "abort" ? 0 : 4_900);
      expect(settled).toBe(true);
      await expect(result).resolves.toEqual(ok);
      expect(foregroundApp).not.toHaveBeenCalled();
    }
  );

  it("asks nothing of an Apple TV simulator, which runs no accessibility service", async () => {
    tvOs.value = true;

    await expect(run()).resolves.toEqual(ok);

    expect(foregroundApp).not.toHaveBeenCalled();
  });
});
