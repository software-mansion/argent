import { promises as fs } from "node:fs";
import net, { type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { ensureDeviceReady } from "../src/utils/ios-device/devicectl";
import { iosRelayFor, parseUsbmuxEndpoint } from "../src/utils/ios-device/relay";
import { listUsbmuxSerials } from "../src/utils/ios-device/usbmux";
import { encodeUsbmuxPacket, readUsbmuxSerials } from "../src/utils/ios-device/usbmux-protocol";

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
