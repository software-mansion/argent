import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";

// Arming (native-devtools' env setup) inserts the audio hook next to the bootstrap only while the
// `ios-audio-always-inserted` flag is on; off, the first audio tool call inserts it instead.
const setenvCalls: string[][] = [];
let currentInserted = "";

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
      const callback = typeof opts === "function" ? opts : cb!;
      const i = args.indexOf("launchctl");
      if (i >= 0 && args[i + 1] === "setenv") setenvCalls.push(args.slice(i + 2));
      const isGetenv =
        i >= 0 && args[i + 1] === "getenv" && args[i + 2] === "DYLD_INSERT_LIBRARIES";
      const isListJson = args.includes("list") && args.includes("--json");
      callback(null, {
        stdout: isGetenv ? currentInserted : isListJson ? '{"devices":{}}' : "",
        stderr: "",
      });
    },
  };
});

vi.mock("@argent/native-devtools-ios", async () => {
  const actual = await vi.importActual<typeof import("@argent/native-devtools-ios")>(
    "@argent/native-devtools-ios"
  );
  return {
    ...actual,
    bootstrapDylibPath: () => "/fake/libArgentInjectionBootstrap.dylib",
    bootstrapDylibPathTcp: () => "/fake/tcp/libArgentInjectionBootstrap.dylib",
    bootstrapDylibPathTvos: () => "/fake/tvos/libArgentInjectionBootstrap.dylib",
    audioDylibPath: () => "/fake/libArgentAudio.dylib",
  };
});

let flagOn = true;
vi.mock("@argent/configuration-core", async () => {
  const actual = await vi.importActual<typeof import("@argent/configuration-core")>(
    "@argent/configuration-core"
  );
  return {
    ...actual,
    isFeatureEnabled: (name: string) =>
      name === "ios-audio-always-inserted" ? flagOn : actual.isFeatureEnabled(name),
  };
});

import { audioDir, localIosHost } from "../src/utils/ios-host";

const UDID = "0000ABCD-0000-0000-0000-00000000F1A9";

function inserted(): string | undefined {
  return setenvCalls.filter((a) => a[0] === "DYLD_INSERT_LIBRARIES").at(-1)?.[1];
}

describe("arming inserts the audio hook per the ios-audio-always-inserted flag", () => {
  beforeEach(() => {
    setenvCalls.length = 0;
    currentInserted = "";
    fs.rmSync(audioDir(UDID), { recursive: true, force: true });
  });

  it("on (the default): bootstrap then the audio hook, the control directory set and created", async () => {
    flagOn = true;
    await localIosHost.setupNativeDevtoolsEnv(UDID, {
      transport: "unix",
      socketPath: "/tmp/x.sock",
    });
    expect(inserted()).toBe("/fake/libArgentInjectionBootstrap.dylib:/fake/libArgentAudio.dylib");
    expect(setenvCalls).toContainEqual(["ARGENT_AUDIO_DIR", audioDir(UDID)]);
    expect(fs.statSync(audioDir(UDID)).mode & 0o777).toBe(0o700);
    fs.rmSync(audioDir(UDID), { recursive: true, force: true });
  });

  it("off: bootstrap only, no control directory", async () => {
    flagOn = false;
    await localIosHost.setupNativeDevtoolsEnv(UDID, {
      transport: "unix",
      socketPath: "/tmp/x.sock",
    });
    expect(inserted()).toBe("/fake/libArgentInjectionBootstrap.dylib");
    expect(setenvCalls.some((a) => a[0] === "ARGENT_AUDIO_DIR")).toBe(false);
    expect(fs.existsSync(audioDir(UDID))).toBe(false);
  });

  it("never for the tcp transport (remote simulators have no audio hook)", async () => {
    flagOn = true;
    await localIosHost.setupNativeDevtoolsEnv(UDID, { transport: "tcp", port: 4000 });
    expect(inserted()).toBe("/fake/tcp/libArgentInjectionBootstrap.dylib");
    expect(setenvCalls.some((a) => a[0] === "ARGENT_AUDIO_DIR")).toBe(false);
  });
});
