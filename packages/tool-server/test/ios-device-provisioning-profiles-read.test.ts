import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { teamsCoveringDevice } from "../src/utils/ios-device/provisioning-profiles";

const UDID = "00008120-001668913A05A01E";

const { state } = vi.hoisted(() => ({ state: { home: "", decoded: [] as string[] } }));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => state.home,
}));

// `security cms -D -i <file>` decodes a profile; these fixtures are the plist already.
vi.mock("node:child_process", async (importOriginal) => {
  const { readFile } = await import("node:fs/promises");
  return {
    ...(await importOriginal<typeof import("node:child_process")>()),
    execFile: (
      _command: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, result?: { stdout: string }) => void
    ) => {
      const file = args[args.length - 1]!;
      state.decoded.push(path.basename(file));
      void readFile(file, "utf8").then((stdout) =>
        stdout === "corrupt" ? callback(new Error("decode failed")) : callback(null, { stdout })
      );
    },
  };
});

function profile(team: string): string {
  return `<plist><dict>
    <key>ExpirationDate</key><date>2999-01-01T00:00:00Z</date>
    <key>ProvisionedDevices</key><array><string>${UDID}</string></array>
    <key>TeamIdentifier</key><array><string>${team}</string></array>
  </dict></plist>`;
}

async function install(directory: string, name: string, content: string): Promise<void> {
  const absolute = path.join(state.home, directory);
  await fs.mkdir(absolute, { recursive: true });
  await fs.writeFile(path.join(absolute, name), content);
}

const XCODE_16 = path.join("Library", "Developer", "Xcode", "UserData", "Provisioning Profiles");
const BEFORE_XCODE_16 = path.join("Library", "MobileDevice", "Provisioning Profiles");

describe("reading the installed provisioning profiles", () => {
  beforeEach(async () => {
    state.home = await fs.mkdtemp(path.join(tmpdir(), "argent-profiles-"));
    state.decoded = [];
  });

  afterEach(async () => {
    await fs.rm(state.home, { recursive: true, force: true });
  });

  it("reads both profile directories", async () => {
    await install(XCODE_16, "new.mobileprovision", profile("TEAMAAAAAA"));
    await install(BEFORE_XCODE_16, "old.mobileprovision", profile("TEAMBBBBBB"));

    expect([...(await teamsCoveringDevice(UDID))].sort()).toEqual(["TEAMAAAAAA", "TEAMBBBBBB"]);
  });

  it("decodes only .mobileprovision files", async () => {
    await install(XCODE_16, "team.mobileprovision", profile("TEAMAAAAAA"));
    await install(XCODE_16, "notes.txt", profile("TEAMBBBBBB"));

    expect([...(await teamsCoveringDevice(UDID))]).toEqual(["TEAMAAAAAA"]);
    expect(state.decoded).toEqual(["team.mobileprovision"]);
  });

  it("skips a profile that fails to decode and keeps the rest", async () => {
    await install(XCODE_16, "bad.mobileprovision", "corrupt");
    await install(XCODE_16, "good.mobileprovision", profile("TEAMAAAAAA"));

    expect([...(await teamsCoveringDevice(UDID))]).toEqual(["TEAMAAAAAA"]);
    expect(state.decoded.sort()).toEqual(["bad.mobileprovision", "good.mobileprovision"]);
  });

  it("knows of no team when neither directory exists", async () => {
    expect((await teamsCoveringDevice(UDID)).size).toBe(0);
  });
});
