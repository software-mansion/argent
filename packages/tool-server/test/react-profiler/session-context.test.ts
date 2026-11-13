import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { detectSessionContext } from "../../src/utils/react-profiler/pipeline/session-context";
import type { RawProfilingInput, RnPlatform } from "../../src/utils/react-profiler/types/input";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "session-context-"));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return root;
}

/** The architecture analyze reports when the recording did not detect one. */
async function architecture(
  projectRoot: string,
  platform: RnPlatform,
  rnVersion: string
): Promise<string> {
  const input: RawProfilingInput = {
    commitTree: { commits: [] },
    sessionMeta: { recordingDurationMs: 1000, deviceId: "d", platform, rnVersion, projectRoot },
  };
  return (await detectSessionContext(input)).rnArchitecture;
}

const OPT_OUT = "ENV['RCT_NEW_ARCH_ENABLED'] = '0'\n";
const OPT_IN = "use_react_native!(:fabric_enabled => true)\n";

describe("the Podfile detectSessionContext reads", () => {
  it("is macos/Podfile for a Mac app, where react-native-macos keeps its pods", async () => {
    // ios/Podfile says the opposite each time, so reading it would flip the answer.
    const optedOut = project({ "macos/Podfile": OPT_OUT, "ios/Podfile": "" });
    expect(await architecture(optedOut, "macos", "0.79.2")).toBe("bridge");
    const optedIn = project({ "macos/Podfile": OPT_IN, "ios/Podfile": "" });
    expect(await architecture(optedIn, "macos", "0.74.0")).toBe("bridgeless");
  });

  it("is not ios/Podfile for a Mac app", async () => {
    const root = project({ "ios/Podfile": OPT_OUT });
    expect(await architecture(root, "macos", "0.79.2")).toBe("bridgeless");
  });

  it("is still ios/Podfile for an iOS app, whatever macos/Podfile says", async () => {
    const root = project({ "ios/Podfile": OPT_OUT, "macos/Podfile": OPT_IN });
    expect(await architecture(root, "ios", "0.79.2")).toBe("bridge");
    const onlyMacos = project({ "macos/Podfile": OPT_OUT });
    expect(await architecture(onlyMacos, "ios", "0.79.2")).toBe("bridgeless");
  });

  it("is not read when the recording detected the architecture", async () => {
    const root = project({ "macos/Podfile": OPT_OUT });
    const input: RawProfilingInput = {
      commitTree: { commits: [] },
      sessionMeta: {
        recordingDurationMs: 1000,
        deviceId: "d",
        platform: "macos",
        rnVersion: "0.79.2",
        projectRoot: root,
        detectedArchitecture: "bridgeless",
      },
    };
    const context = await detectSessionContext(input);
    expect(context.rnArchitecture).toBe("bridgeless");
    expect(context.platform).toBe("macos");
  });
});
