import { beforeEach, describe, expect, it, vi } from "vitest";

const pending: Array<{
  args: readonly string[];
  finish: (stdout: string) => void;
  fail: (err: Error) => void;
}> = [];

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: (
    _cmd: string,
    args: readonly string[],
    _opts: unknown,
    cb: (err: Error | null, out: { stdout: string; stderr: string }) => void
  ) => {
    pending.push({
      args,
      finish: (stdout) => cb(null, { stdout, stderr: "" }),
      fail: (err) => cb(err, { stdout: "", stderr: "" }),
    });
  },
}));

vi.mock("@argent/native-devtools-ios", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@argent/native-devtools-ios")>()),
  bootstrapDylibPath: () => "/fake/bootstrap.dylib",
}));

vi.mock("../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-devices")>()),
  isTvOsSimulator: async () => false,
}));

vi.mock("../src/utils/ios-device-sets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-device-sets")>()),
  simctlTargetForUdid: async (udid: string) => ({ nativeId: udid, prefix: ["simctl"] }),
}));

vi.mock("@argent/configuration-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@argent/configuration-core")>()),
  isFeatureEnabled: () => false,
}));

import { localIosHost } from "../src/utils/ios-host";

const UDID = "11111111-1111-1111-1111-111111111111";
const ENDPOINT = { transport: "unix", socketPath: "/tmp/argent-nd-test.sock" } as const;

function issued(): string[] {
  return pending.map(({ args }) => args.slice(3).join(" "));
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  pending.length = 0;
});

describe("arming a local iOS simulator", () => {
  it("issues every independent spawn at once and writes DYLD_INSERT_LIBRARIES after reading it", async () => {
    const armed = localIosHost.setupNativeDevtoolsEnv(UDID, ENDPOINT);
    await flush();

    expect(issued()).toEqual([
      "launchctl getenv DYLD_INSERT_LIBRARIES",
      "launchctl setenv NATIVE_DEVTOOLS_IOS_CDP_SOCKET /tmp/argent-nd-test.sock",
      "defaults write com.apple.Accessibility AccessibilityEnabled -bool true",
      "defaults write com.apple.Accessibility ApplicationAccessibilityEnabled -bool true",
    ]);

    pending[0]!.finish("/existing/other.dylib\n");
    for (const call of pending.slice(1)) call.finish("");
    await flush();

    expect(issued().at(-1)).toBe("launchctl setenv DYLD_INSERT_LIBRARIES /fake/bootstrap.dylib");
    pending.at(-1)!.finish("");
    await expect(armed).resolves.toBeUndefined();
  });

  it("fails only after the DYLD_INSERT_LIBRARIES write a failed step overlapped has finished", async () => {
    let settled = false;
    const armed = localIosHost.setupNativeDevtoolsEnv(UDID, ENDPOINT).finally(() => {
      settled = true;
    });
    await flush();

    pending[1]!.fail(new Error("endpoint setenv failed"));
    await flush();
    expect(settled).toBe(false);

    pending[0]!.finish("");
    for (const call of pending.slice(2)) call.finish("");
    await flush();
    expect(issued().at(-1)).toBe("launchctl setenv DYLD_INSERT_LIBRARIES /fake/bootstrap.dylib");
    expect(settled).toBe(false);

    pending.at(-1)!.finish("");
    await expect(armed).rejects.toThrow("endpoint setenv failed");
  });
});
