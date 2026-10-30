import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import net, { type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { ensureDeviceReady } from "../src/utils/ios-device/devicectl";
import { goIosErrorSummary } from "../src/utils/ios-device/go-ios";
import { iosRelayFor, parseUsbmuxEndpoint } from "../src/utils/ios-device/relay";
import {
  runnerAppsFromXctestrun,
  writeXctestrunWithRunnerPort,
} from "../src/utils/ios-device/runner-launch";
import { killStaleRunnersForDevice } from "../src/utils/ios-device/runner-sweep";
import { listUsbmuxSerials } from "../src/utils/ios-device/usbmux";
import { encodeUsbmuxPacket, readUsbmuxSerials } from "../src/utils/ios-device/usbmux-protocol";

const execFileAsync = promisify(execFile);

const UDID = "00008120-000154913A05A01E";
const OTHER_UDID = "00008030-000D4856146B802E";

const openServers: Server[] = [];
const tempDirs: string[] = [];

// The suite-wide setup disables provider discovery; each test that publishes a
// descriptor re-enables it and the env is restored here, as the guard expects.
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of openServers.splice(0)) await new Promise((r) => server.close(() => r(null)));
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  delete process.env.ARGENT_DEVICE_PROVIDERS;
  process.env.ARGENT_DISABLE_DEVICE_PROVIDERS = "1";
});

async function tempDir(): Promise<string> {
  // A short prefix: unix socket paths are limited to 104 bytes on macOS.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-relay-"));
  tempDirs.push(dir);
  return dir;
}

/** Point provider discovery at one descriptor offering `devices`. */
async function publish(devices: unknown[]): Promise<void> {
  const dir = await tempDir();
  const file = path.join(dir, "acme.json");
  await fs.writeFile(
    file,
    JSON.stringify({ schemaVersion: 1, id: "acme-15038", name: "Acme Relay", devices })
  );
  process.env.ARGENT_DEVICE_PROVIDERS = file;
  delete process.env.ARGENT_DISABLE_DEVICE_PROVIDERS;
}

function relayedIphone(usbmuxd: string, overrides: Record<string, unknown> = {}) {
  return {
    capabilities: ["usbmuxd"],
    kind: "device",
    name: "iPhone 15 (desk 2)",
    nativeId: UDID,
    platform: "ios",
    state: "connected",
    usbmuxd,
    ...overrides,
  };
}

/** A usbmuxd that answers ListDevices with `serials` over USB, then hangs up. */
async function startFakeUsbmuxd(socketPath: string, serials: string[]): Promise<void> {
  const server = net.createServer((socket) => {
    socket.once("data", () => {
      const entries = serials
        .map(
          (serial, index) =>
            `<dict><key>DeviceID</key><integer>${index + 1}</integer><key>Properties</key><dict>` +
            `<key>ConnectionType</key><string>USB</string>` +
            `<key>SerialNumber</key><string>${serial}</string></dict></dict>`
        )
        .join("");
      socket.end(
        encodeUsbmuxPacket(
          1,
          `<plist><dict><key>DeviceList</key><array>${entries}</array></dict></plist>`
        )
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  openServers.push(server);
}

describe("parseUsbmuxEndpoint", () => {
  it("reads host:port, bracketed IPv6 and a socket path", () => {
    expect(parseUsbmuxEndpoint("127.0.0.1:15038")).toEqual({ host: "127.0.0.1", port: 15038 });
    expect(parseUsbmuxEndpoint("[::1]:15038")).toEqual({ host: "::1", port: 15038 });
    expect(parseUsbmuxEndpoint("/var/run/usbmuxd")).toEqual({ path: "/var/run/usbmuxd" });
  });
});

describe("readUsbmuxSerials", () => {
  it("lists USB entries only, in order", () => {
    const xml =
      "<plist><dict><key>DeviceList</key><array>" +
      `<dict><key>DeviceID</key><integer>1</integer><key>Properties</key><dict><key>ConnectionType</key><string>USB</string><key>SerialNumber</key><string>${UDID}</string></dict></dict>` +
      `<dict><key>DeviceID</key><integer>2</integer><key>Properties</key><dict><key>ConnectionType</key><string>Network</string><key>SerialNumber</key><string>${OTHER_UDID}</string></dict></dict>` +
      "</array></dict></plist>";

    expect(readUsbmuxSerials(xml)).toEqual([UDID]);
    expect(readUsbmuxSerials("not a plist")).toEqual([]);
  });
});

describe("iosRelayFor", () => {
  it("finds the relay under the ext: id and the raw udid", async () => {
    await publish([relayedIphone("127.0.0.1:15038")]);

    const expected = { udid: UDID, endpoint: "127.0.0.1:15038", providerName: "Acme Relay" };
    expect(iosRelayFor(`ext:acme-15038:${UDID}`)).toEqual(expected);
    expect(iosRelayFor(UDID)).toEqual(expected);
    expect(iosRelayFor(OTHER_UDID)).toBeUndefined();
  });

  it("is undefined for a phone on this Mac's own usbmuxd", async () => {
    await publish([]);
    expect(iosRelayFor(UDID)).toBeUndefined();
  });
});

describe("a relayed phone's readiness", () => {
  it("lists the relay's serials and passes ensureDeviceReady while the phone is listed", async () => {
    const socketPath = path.join(await tempDir(), "mux.sock");
    await startFakeUsbmuxd(socketPath, [UDID]);
    await publish([relayedIphone(socketPath)]);

    expect(await listUsbmuxSerials(socketPath)).toEqual([UDID]);
    await expect(ensureDeviceReady(`ext:acme-15038:${UDID}`)).resolves.toBeUndefined();
  });

  it("names the provider when the relay no longer lists the phone", async () => {
    const socketPath = path.join(await tempDir(), "mux.sock");
    await startFakeUsbmuxd(socketPath, [OTHER_UDID]);
    // A distinct udid: ensureDeviceReady memoizes a pass for 5s per id.
    const udid = "00008120-00015491FFFFFFFF";
    await publish([relayedIphone(socketPath, { nativeId: udid })]);

    const error = await ensureDeviceReady(udid).catch((caught: unknown) => caught);

    expect((error as Error).message).toContain("no longer lists");
    expect((error as Error).message).toContain("Acme Relay");
    expect(getFailureSignal(error)?.error_kind).toBe("not_found");
  });

  it("says the relay did not answer when nothing listens at the endpoint", async () => {
    const socketPath = path.join(await tempDir(), "gone.sock");
    const udid = "00008120-00015491EEEEEEEE";
    await publish([relayedIphone(socketPath, { nativeId: udid })]);

    const error = await ensureDeviceReady(udid).catch((caught: unknown) => caught);

    expect((error as Error).message).toContain("did not answer");
    expect(getFailureSignal(error)?.error_code).toBe(FAILURE_CODES.IOS_DEVICECTL_COMMAND_FAILED);
  });
});

describe("writeXctestrunWithRunnerPort", () => {
  it("pins ARGENT_RUNNER_PORT in the runner's environment and leaves the rest intact", async () => {
    const dir = await tempDir();
    const source = path.join(dir, "ArgentRunner_iphoneos18.0-arm64.xctestrun");
    const target = path.join(dir, "pinned.xctestrun");
    const json = path.join(dir, "source.json");
    await fs.writeFile(
      json,
      JSON.stringify({
        __xctestrun_metadata__: { FormatVersion: 1 },
        ArgentRunnerUITests: {
          BlueprintName: "ArgentRunnerUITests",
          EnvironmentVariables: { OS_ACTIVITY_DT_MODE: "YES" },
          TestHostPath: "__TESTROOT__/Debug-iphoneos/ArgentRunnerUITests-Runner.app",
        },
      })
    );
    await execFileAsync("plutil", ["-convert", "xml1", "-o", source, json]);

    await writeXctestrunWithRunnerPort(source, target, 27042);

    const { stdout } = await execFileAsync("plutil", ["-convert", "json", "-o", "-", target]);
    const written = JSON.parse(stdout) as Record<string, Record<string, unknown>>;
    expect(written.ArgentRunnerUITests!.EnvironmentVariables).toEqual({
      OS_ACTIVITY_DT_MODE: "YES",
      ARGENT_RUNNER_PORT: "27042",
    });
    expect(written.ArgentRunnerUITests!.TestingEnvironmentVariables).toEqual({
      ARGENT_RUNNER_PORT: "27042",
    });
    expect(written.ArgentRunnerUITests!.TestHostPath).toContain("ArgentRunnerUITests-Runner.app");
    expect(written.__xctestrun_metadata__).toEqual({ FormatVersion: 1 });
  });
});

describe("runnerAppsFromXctestrun", () => {
  it("names the runner app with its bundle id and the UI target by path", () => {
    const apps = runnerAppsFromXctestrun(
      {
        __xctestrun_metadata__: { FormatVersion: 1 },
        ArgentRunnerUITests: {
          TestHostBundleIdentifier: "com.argent.runner.tteam.uitests.xctrunner",
          TestHostPath: "__TESTROOT__/Debug-iphoneos/ArgentRunnerUITests-Runner.app",
          UITargetAppPath: "__TESTROOT__/Debug-iphoneos/ArgentRunner.app",
        },
      },
      "/Users/dev/.argent/ios-device-runner/derived/Build/Products"
    );

    expect(apps).toEqual([
      {
        path: "/Users/dev/.argent/ios-device-runner/derived/Build/Products/Debug-iphoneos/ArgentRunnerUITests-Runner.app",
        bundleId: "com.argent.runner.tteam.uitests.xctrunner",
      },
      {
        path: "/Users/dev/.argent/ios-device-runner/derived/Build/Products/Debug-iphoneos/ArgentRunner.app",
      },
    ]);
  });
});

describe("goIosErrorSummary", () => {
  it("reads the last error line go-ios logged as JSON", () => {
    const output = [
      JSON.stringify({ level: "INFO", msg: "installing" }),
      JSON.stringify({
        level: "ERROR",
        msg: "failed writing",
        err: "ApplicationVerificationFailed",
      }),
      JSON.stringify({ level: "INFO", msg: "done" }),
    ].join("\n");

    expect(goIosErrorSummary(output)).toBe("failed writing: ApplicationVerificationFailed");
    expect(goIosErrorSummary("plain text\nlast line")).toBe("last line");
  });
});

describe("the stale-runner sweep on relayed launches", () => {
  const RELAY_XCTESTRUN = `/Users/dev/.argent/ios-device-runner/relay/${UDID}.xctestrun`;

  function goIosPsLine(pid: number, ppid: number, udid = UDID): string {
    return [
      String(pid).padStart(5),
      String(ppid).padStart(5),
      "/usr/local/bin/ios",
      "runxctest",
      `--xctestrun-file-path=${RELAY_XCTESTRUN}`,
      "--udid",
      udid,
      "--tunnel-info-port",
      "60105",
    ].join(" ");
  }

  it("kills an orphaned go-ios runner for the device, named by its ext: id", async () => {
    const kills: number[] = [];
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (signal === 0) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      kills.push(pid);
      return true;
    });

    const killed = await killStaleRunnersForDevice(`ext:acme-15038:${UDID}`, async () =>
      [goIosPsLine(501, 1), goIosPsLine(502, 1, OTHER_UDID)].join("\n")
    );

    expect(killed).toBe(1);
    expect(kills).toContain(-501);
    expect(kills).not.toContain(-502);
  });
});
