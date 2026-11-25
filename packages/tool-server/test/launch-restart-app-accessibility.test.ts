import { describe, it, expect, vi, beforeEach } from "vitest";

// An iOS app reads the simulator's accessibility defaults when its process
// starts, and a finished XCTest session (the driver of Maestro or Appium)
// leaves them off. An app launched after that has no tab button identifiers,
// no label text and nothing for the ax-service to read, until something writes
// the defaults back and relaunches it. So launch-app and restart-app write them
// before every launch, on local and on cloud simulators.

type Call = { cmd: string; args: readonly string[] };
const calls: Call[] = [];
let failDefaultsWrites = false;
/** While set, a defaults write does not answer until released. */
let heldWrites: Array<() => void> | null = null;

const isDefaultsWrite = (args: readonly string[]) =>
  args.includes("defaults") && args.includes("write") && args.includes("com.apple.Accessibility");

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: readonly string[],
      opts: unknown,
      cb?: (err: Error | null, out: { stdout: string; stderr: string }) => void
    ) => {
      const callback = typeof opts === "function" ? opts : cb!;
      calls.push({ cmd, args });
      if (failDefaultsWrites && isDefaultsWrite(args)) {
        callback(new Error("Invalid device or device pair"), { stdout: "", stderr: "" });
        return;
      }
      // `sim-remote spawn --json` answers with one JSON object; everything else ignores stdout.
      const stdout = args.includes("--json") ? '{"exit_code":0,"stdout":"","stderr":""}' : "";
      const answer = () => callback(null, { stdout, stderr: "" });
      if (heldWrites && isDefaultsWrite(args)) heldWrites.push(answer);
      else answer();
    },
  };
});

vi.mock("../src/utils/ios-devices", () => ({
  isTvOsSimulator: vi.fn(async () => false),
}));

import { createLaunchAppTool } from "../src/tools/launch-app";
import { createRestartAppTool } from "../src/tools/restart-app";
import type { NativeDevtoolsApi } from "../src/blueprints/native-devtools";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";

const IOS_UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const REMOTE_UDID = `remote:${IOS_UDID}`;
const APP = "com.example.app";

// What the real 2-arg precheck and the handlers consult, nothing more.
function makeNativeApi(): NativeDevtoolsApi {
  return {
    ensureEnvReady: async () => {},
    getInitFailure: () => null,
    networkCaptureAfterLaunch: async () => undefined,
  } as unknown as NativeDevtoolsApi;
}

const TOOLS = [
  ["launch-app", createLaunchAppTool],
  ["restart-app", createRestartAppTool],
] as const;

const HOSTS = [
  {
    name: "local simulator",
    udid: IOS_UDID,
    // Local iPhone and iPad sims leave AutomationEnabled out (see clearAutomationEnabled).
    flags: ["AccessibilityEnabled", "ApplicationAccessibilityEnabled"],
  },
  {
    name: "cloud simulator",
    udid: REMOTE_UDID,
    flags: ["AccessibilityEnabled", "ApplicationAccessibilityEnabled", "AutomationEnabled"],
  },
] as const;

async function run(createTool: (typeof TOOLS)[number][1], udid: string): Promise<unknown> {
  const api = makeNativeApi();
  const tool = createTool({ resolveService: vi.fn(async () => api as unknown) } as never);
  // The local branch resolves the service lazily, the remote one reads it from `services`.
  return tool.execute!({ nativeDevtools: api }, { udid, bundleId: APP });
}

const writtenFlags = () =>
  calls
    .filter(({ args }) => isDefaultsWrite(args))
    .map(({ args }) => args[args.indexOf("com.apple.Accessibility") + 1])
    .sort();

const launchIndex = () => calls.findIndex(({ args }) => args.includes("launch"));

const turns = async (count: number) => {
  for (let i = 0; i < count; i++) await new Promise((resolve) => setImmediate(resolve));
};

beforeEach(() => {
  calls.length = 0;
  failDefaultsWrites = false;
  heldWrites = null;
  __resetDepCacheForTests();
  __primeDepCacheForTests(["xcrun", "sim-remote"]);
});

describe("launch-app / restart-app turn app accessibility on before the app process starts", () => {
  for (const [toolName, createTool] of TOOLS) {
    for (const host of HOSTS) {
      it(`${toolName} on a ${host.name} writes the defaults before the launch`, async () => {
        await run(createTool, host.udid);

        expect(writtenFlags()).toEqual([...host.flags].sort());
        const launch = launchIndex();
        expect(launch).toBeGreaterThan(-1);
        const writes = calls
          .map(({ args }, index) => (isDefaultsWrite(args) ? index : -1))
          .filter((index) => index !== -1);
        expect(Math.max(...writes)).toBeLessThan(launch);
        for (const { args } of calls.filter(({ args }) => isDefaultsWrite(args))) {
          expect(args.slice(-2)).toEqual(["-bool", "true"]);
        }
      });

      it(`${toolName} on a ${host.name} still launches when the write fails`, async () => {
        failDefaultsWrites = true;
        const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
          const result = await run(createTool, host.udid);
          expect(result).toMatchObject({ bundleId: APP });
          expect(launchIndex()).toBeGreaterThan(-1);
          expect(stderr.mock.calls.join("\n")).toContain("could not turn app accessibility on");
        } finally {
          stderr.mockRestore();
        }
      });

      it(`${toolName} on a ${host.name} does not launch while the write is in flight`, async () => {
        heldWrites = [];
        const done = run(createTool, host.udid);
        await turns(10);
        expect(heldWrites.length).toBe(host.flags.length);
        expect(launchIndex()).toBe(-1);

        for (const answer of heldWrites) answer();
        await done;
        expect(launchIndex()).toBeGreaterThan(-1);
      });

      it(`${toolName} on a ${host.name} launches after 10 s when the write never answers`, async () => {
        heldWrites = [];
        const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          const done = run(createTool, host.udid);
          await vi.advanceTimersByTimeAsync(9_000);
          expect(launchIndex()).toBe(-1);

          await vi.advanceTimersByTimeAsync(1_000);
          await expect(done).resolves.toMatchObject({ bundleId: APP });
          expect(launchIndex()).toBeGreaterThan(-1);
          expect(stderr.mock.calls.join("\n")).toContain("no answer within 10s");
        } finally {
          vi.useRealTimers();
          stderr.mockRestore();
        }
      });
    }
  }
});
