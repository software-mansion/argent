import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// Arming (native-devtools' env setup) inserts the audio hook next to the bootstrap only while the
// `ios-audio-always-inserted` flag is on; off, the first audio tool call inserts it instead.
const setenvCalls: string[][] = [];
const unsetenvCalls: string[] = [];
let currentInserted = "";
let currentAudioDir = "";

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
      if (failAudioDirSetenv && i >= 0 && args[i + 2] === "ARGENT_AUDIO_DIR") {
        callback(new Error("launchctl setenv failed"), { stdout: "", stderr: "" });
        return;
      }
      if (i >= 0 && args[i + 1] === "setenv") setenvCalls.push(args.slice(i + 2));
      if (i >= 0 && args[i + 1] === "unsetenv") unsetenvCalls.push(args[i + 2]);
      const isGetenv =
        i >= 0 && args[i + 1] === "getenv" && args[i + 2] === "DYLD_INSERT_LIBRARIES";
      const isGetAudioDir =
        i >= 0 && args[i + 1] === "getenv" && args[i + 2] === "ARGENT_AUDIO_DIR";
      const isListJson = args.includes("list") && args.includes("--json");
      callback(null, {
        stdout: isGetenv
          ? currentInserted
          : isGetAudioDir
            ? currentAudioDir
            : isListJson
              ? '{"devices":{}}'
              : "",
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
    audioDylibPath: () => {
      if (audioDylibMissing)
        throw new Error("Native devtools dylib not found: libArgentAudio.dylib");
      return "/fake/libArgentAudio.dylib";
    },
  };
});

let flagOn = true;
let audioDylibMissing = false;
let failAudioDirSetenv = false;
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
    unsetenvCalls.length = 0;
    currentInserted = "";
    currentAudioDir = "";
    fs.rmSync(audioDir(UDID), { recursive: true, force: true });
  });
  afterEach(() => fs.rmSync(audioDir(UDID), { recursive: true, force: true }));

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

  it("goes on without the audio hook when this install has no audio dylib", async () => {
    flagOn = true;
    audioDylibMissing = true;
    try {
      await localIosHost.setupNativeDevtoolsEnv(UDID, {
        transport: "unix",
        socketPath: "/tmp/x.sock",
      });
    } finally {
      audioDylibMissing = false;
    }
    expect(inserted()).toBe("/fake/libArgentInjectionBootstrap.dylib");
    expect(setenvCalls.some((a) => a[0] === "ARGENT_AUDIO_DIR")).toBe(false);
  });

  it("arms without audio when the control directory cannot be created or announced", async () => {
    flagOn = true;
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const arm = () =>
      localIosHost.setupNativeDevtoolsEnv(UDID, { transport: "unix", socketPath: "/tmp/x.sock" });
    try {
      fs.writeFileSync(audioDir(UDID), ""); // a file in the way: mkdir throws
      await expect(arm()).resolves.toBeUndefined();
      expect(setenvCalls.some((a) => a[0] === "ARGENT_AUDIO_DIR")).toBe(false);
      fs.rmSync(audioDir(UDID));

      failAudioDirSetenv = true;
      await expect(arm()).resolves.toBeUndefined();
      expect(inserted()).toBe("/fake/libArgentInjectionBootstrap.dylib:/fake/libArgentAudio.dylib");
      expect(stderr).toHaveBeenCalledTimes(2);
      expect(String(stderr.mock.calls[0][0])).toContain("audio setup failed");
    } finally {
      failAudioDirSetenv = false;
      stderr.mockRestore();
    }
  });

  it("clears what a killed tool-server left, flag or not, and keeps a live one's", async () => {
    const dead = spawnSync("true").pid!;
    for (const on of [true, false]) {
      flagOn = on;
      const dir = audioDir(UDID);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "input"),
        `source=stream\nring=${dir}/in-${dead}-a.ring\nhost=${dead}\n`
      );
      fs.writeFileSync(path.join(dir, `in-${dead}-a.ring`), "");
      fs.writeFileSync(path.join(dir, `clip-${process.pid}-1.wav`), "");
      await localIosHost.setupNativeDevtoolsEnv(UDID, {
        transport: "unix",
        socketPath: "/tmp/x.sock",
      });
      expect(fs.readdirSync(dir)).toEqual([`clip-${process.pid}-1.wav`]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("handing the simulator back", () => {
    const endpoint = { transport: "unix", socketPath: "/tmp/x.sock" } as const;

    it("removes the audio hook and its control directory variable with the bootstrap", async () => {
      currentInserted = "/fake/libArgentInjectionBootstrap.dylib:/fake/libArgentAudio.dylib";
      currentAudioDir = audioDir(UDID);
      await localIosHost.withdrawNativeDevtoolsEnv(UDID, endpoint);
      expect(unsetenvCalls).toEqual(["DYLD_INSERT_LIBRARIES", "ARGENT_AUDIO_DIR"]);
      expect(setenvCalls).toEqual([]);
    });

    it("keeps a foreign entry and a control directory variable that is not ours", async () => {
      // On disk, so it counts as a third party's live dylib rather than a stale path.
      const foreign = fs.realpathSync(process.execPath);
      currentInserted = `${foreign}:/fake/libArgentInjectionBootstrap.dylib:/fake/libArgentAudio.dylib`;
      currentAudioDir = "/tmp/someone-elses-audio";
      await localIosHost.withdrawNativeDevtoolsEnv(UDID, endpoint);
      expect(inserted()).toBe(foreign);
      expect(unsetenvCalls).toEqual([]);
    });

    it("leaves a simulator that never had the audio hook as before", async () => {
      currentInserted = "/fake/libArgentInjectionBootstrap.dylib";
      await localIosHost.withdrawNativeDevtoolsEnv(UDID, endpoint);
      expect(unsetenvCalls).toEqual(["DYLD_INSERT_LIBRARIES"]);
    });
  });
});
