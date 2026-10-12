import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import net, { type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildUsbmuxPlistMessage,
  decodeUsbmuxPacket,
  encodeUsbmuxPacket,
  hostToNetworkPort,
  IosDeviceTransportError,
  parsePlist,
  readUsbmuxDeviceIdForSerial,
  readUsbmuxResultCode,
  type PlistDict,
  type PlistValue,
  type UsbmuxPacket,
  USBMUX_HEADER_BYTES,
  USBMUX_MAX_PACKET_BYTES,
  USBMUX_MESSAGE_TYPE_PLIST,
  USBMUX_PROTOCOL_VERSION,
} from "../src/utils/ios-device/usbmux-protocol";
import { postRunnerCommand } from "../src/utils/ios-device/runner-http";
import {
  buildUsbmuxConnectError,
  createDeadline,
  openUsbmuxRunnerSocket,
  writePacket,
} from "../src/utils/ios-device/usbmux";

const DEVICE_UDID = "00008110-000978540290401E";
const RUNNER_PORT = 51_234;

describe("usbmux packet framing", () => {
  it("round-trips header fields and payload through encode/decode", () => {
    const xml = buildUsbmuxPlistMessage("ListDevices");
    const packet = encodeUsbmuxPacket(7, xml);

    const decoded: UsbmuxPacket | null = decodeUsbmuxPacket(packet);

    expect(decoded).not.toBeNull();
    expect(decoded?.version).toBe(USBMUX_PROTOCOL_VERSION);
    expect(decoded?.messageType).toBe(USBMUX_MESSAGE_TYPE_PLIST);
    expect(decoded?.tag).toBe(7);
    expect(decoded?.payload.toString("utf8")).toBe(xml);
    expect(decoded?.bytesConsumed).toBe(packet.length);
  });

  it("returns null while the buffer holds only a partial packet", () => {
    const packet = encodeUsbmuxPacket(1, buildUsbmuxPlistMessage("ListDevices"));

    expect(decodeUsbmuxPacket(packet.subarray(0, USBMUX_HEADER_BYTES - 1))).toBeNull();
    expect(decodeUsbmuxPacket(packet.subarray(0, packet.length - 1))).toBeNull();
  });

  it("rejects a length prefix below the header size", () => {
    const packet = Buffer.alloc(USBMUX_HEADER_BYTES);
    packet.writeUInt32LE(USBMUX_HEADER_BYTES - 1, 0);

    expect(() => decodeUsbmuxPacket(packet)).toThrow(IosDeviceTransportError);
    expect(() => decodeUsbmuxPacket(packet)).toThrow(/Invalid usbmuxd packet length/);
  });

  it("rejects a length prefix above the 4 MiB cap without waiting for the bytes", () => {
    const packet = Buffer.alloc(USBMUX_HEADER_BYTES);
    packet.writeUInt32LE(USBMUX_MAX_PACKET_BYTES + 1, 0);

    let thrown: unknown;
    try {
      decodeUsbmuxPacket(packet);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(IosDeviceTransportError);
    expect((thrown as IosDeviceTransportError).kind).toBe("protocol");
    expect((thrown as IosDeviceTransportError).retryable).toBe(false);
  });

  it("keeps bytes past the packet boundary out of the payload", () => {
    const packet = encodeUsbmuxPacket(1, "<plist/>");
    const stream = Buffer.concat([packet, Buffer.from("HTTP/1.1 200 OK")]);

    const decoded = decodeUsbmuxPacket(stream);

    expect(decoded?.payload.toString("utf8")).toBe("<plist/>");
    expect(decoded?.bytesConsumed).toBe(packet.length);
  });
});

describe("hostToNetworkPort", () => {
  it("swaps the byte order of a 16-bit port (htons)", () => {
    expect(hostToNetworkPort(0x1234)).toBe(0x3412);
    expect(hostToNetworkPort(RUNNER_PORT)).toBe(((RUNNER_PORT & 0xff) << 8) | (RUNNER_PORT >>> 8));
    expect(hostToNetworkPort(0)).toBe(0);
    expect(hostToNetworkPort(0xffff)).toBe(0xffff);
  });

  it("rejects out-of-range ports", () => {
    expect(() => hostToNetworkPort(-1)).toThrow(IosDeviceTransportError);
    expect(() => hostToNetworkPort(0x1_0000)).toThrow(IosDeviceTransportError);
    expect(() => hostToNetworkPort(1.5)).toThrow(IosDeviceTransportError);
  });
});

describe("plist build/parse", () => {
  it("escapes XML metacharacters in message fields", () => {
    const xml = buildUsbmuxPlistMessage("Connect", { Weird: `<&>"'` });

    expect(xml).toContain("<key>Weird</key><string>&lt;&amp;&gt;&quot;&apos;</string>");
    expect(parsePlist(xml)).toMatchObject({ MessageType: "Connect", Weird: `<&>"'` });
  });

  it("parses the shapes usbmuxd emits: dicts, arrays, integers, booleans", () => {
    const xml = `<?xml version="1.0"?><plist version="1.0"><dict>
      <key>Number</key><integer>3</integer>
      <key>Attached</key><true/>
      <key>List</key><array><string>a</string><integer>2</integer></array>
    </dict></plist>`;

    const parsed: PlistValue = parsePlist(xml);
    expect(parsed).toEqual({ Number: 3, Attached: true, List: ["a", 2] } satisfies PlistDict);
  });

  it("reads the Result code usbmuxd answers Connect with", () => {
    const xml =
      "<plist><dict><key>MessageType</key><string>Result</string><key>Number</key><integer>3</integer></dict></plist>";

    expect(readUsbmuxResultCode(xml)).toBe(3);
    expect(readUsbmuxResultCode("<plist><dict/></plist>")).toBeUndefined();
  });
});

describe("readUsbmuxDeviceIdForSerial", () => {
  const deviceListXml = (
    devices: Array<{ id: number; serial: string; connection?: "USB" | "Network" }>
  ): string => {
    const entries = devices
      .map(
        (device) =>
          `<dict><key>DeviceID</key><integer>${device.id}</integer>` +
          `<key>Properties</key><dict>` +
          `<key>ConnectionType</key><string>${device.connection ?? "USB"}</string>` +
          `<key>SerialNumber</key><string>${device.serial}</string>` +
          `</dict></dict>`
      )
      .join("");
    return `<plist><dict><key>DeviceList</key><array>${entries}</array></dict></plist>`;
  };

  it("resolves the DeviceID by exact serial match regardless of list position", () => {
    const xml = deviceListXml([
      { id: 11, serial: "00008030-000000000000AAAA" },
      { id: 77, serial: DEVICE_UDID },
      { id: 22, serial: "00008040-000000000000BBBB" },
    ]);

    expect(readUsbmuxDeviceIdForSerial(xml, DEVICE_UDID)).toBe(77);
  });

  it("never matches a near-miss serial that merely shares a prefix or suffix", () => {
    // Hardware UDIDs share long prefixes across a model generation; a fuzzy
    // match here would tap commands into the wrong phone.
    const xml = deviceListXml([
      { id: 5, serial: `${DEVICE_UDID}0` },
      { id: 6, serial: DEVICE_UDID.slice(0, -1) },
    ]);

    expect(readUsbmuxDeviceIdForSerial(xml, DEVICE_UDID)).toBeUndefined();
  });

  it("ignores malformed entries instead of failing the whole list", () => {
    const xml =
      "<plist><dict><key>DeviceList</key><array>" +
      "<dict><key>DeviceID</key><string>not-a-number</string></dict>" +
      `<dict><key>DeviceID</key><integer>9</integer><key>Properties</key><dict><key>SerialNumber</key><string>${DEVICE_UDID}</string></dict></dict>` +
      "</array></dict></plist>";

    expect(readUsbmuxDeviceIdForSerial(xml, DEVICE_UDID)).toBe(9);
  });

  it("prefers the USB entry when Wi-Fi sync lists the same phone twice, Network first", () => {
    // A phone paired for Wi-Fi sync shows up once per transport, and usbmuxd
    // may list the Network entry first. Taking the first exact match would
    // route every runner command over Wi-Fi on a feature that promises the
    // cable, so the USB entry must win wherever it sits in the list.
    const xml = deviceListXml([
      { id: 12, serial: DEVICE_UDID, connection: "Network" },
      { id: 13, serial: DEVICE_UDID, connection: "USB" },
    ]);

    expect(readUsbmuxDeviceIdForSerial(xml, DEVICE_UDID)).toBe(13);
  });

  it("falls back to the only exact match when no USB entry carries the serial", () => {
    const xml = deviceListXml([
      { id: 12, serial: DEVICE_UDID, connection: "Network" },
      { id: 13, serial: "00008030-000000000000AAAA", connection: "USB" },
    ]);

    expect(readUsbmuxDeviceIdForSerial(xml, DEVICE_UDID)).toBe(12);
  });
});

describe("buildUsbmuxConnectError result-code mapping", () => {
  const context = { udid: DEVICE_UDID, port: RUNNER_PORT };

  it("maps result 2 (device gone mid-connect) to the unattached verdict", () => {
    const error = buildUsbmuxConnectError(2, context);

    expect(error.kind).toBe("device-unattached");
    expect(error.retryable).toBe(false);
    expect(error.hint).toMatch(/cable/);
    // The hint is folded into the message: agent-facing rendering surfaces
    // only .message, so the guidance must live there.
    expect(error.message).toContain(error.hint as string);
  });

  it("maps result 3 (port closed on a live device) to a retryable runner-not-listening", () => {
    const error = buildUsbmuxConnectError(3, context);

    expect(error.kind).toBe("runner-not-listening");
    expect(error.retryable).toBe(true);
    expect(error.hint).not.toMatch(/cable/);
    expect(error.message).toContain(error.hint as string);
  });

  it("maps unknown results to a generic failure with the cable/trust/unlock hint", () => {
    const error = buildUsbmuxConnectError(6, context);

    expect(error.kind).toBe("protocol");
    expect(error.retryable).toBe(false);
    expect(error.hint).toMatch(/cable/);
    expect(error.message).toContain(error.hint as string);
  });
});

describe("writePacket backpressure", () => {
  class BackpressureSocket extends EventEmitter {
    write(_data: Buffer): boolean {
      return false;
    }
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("bounds a drain wait that never resolves with a typed timeout instead of hanging", async () => {
    vi.useFakeTimers();
    const socket = new BackpressureSocket();

    const pending = writePacket(socket, "<plist/>", 1, createDeadline(5_000)).catch(
      (caught: unknown) => caught
    );
    await vi.advanceTimersByTimeAsync(5_000);
    const error = await pending;

    expect(error).toBeInstanceOf(IosDeviceTransportError);
    expect((error as IosDeviceTransportError).kind).toBe("timeout");
    expect((error as IosDeviceTransportError).retryable).toBe(true);
    // Nothing may linger on a socket that goes on to become the raw device pipe.
    expect(socket.listenerCount("drain")).toBe(0);
    expect(socket.listenerCount("error")).toBe(0);
    expect(socket.listenerCount("close")).toBe(0);
  });

  it("detaches every listener and the timer once drain settles the wait", async () => {
    vi.useFakeTimers();
    const socket = new BackpressureSocket();

    const pending = writePacket(socket, "<plist/>", 1, createDeadline(5_000));
    expect(socket.listenerCount("error")).toBe(1);
    socket.emit("drain");
    await pending;

    expect(vi.getTimerCount()).toBe(0);
    expect(socket.listenerCount("drain")).toBe(0);
    expect(socket.listenerCount("error")).toBe(0);
    expect(socket.listenerCount("close")).toBe(0);
  });

  it("treats the socket closing mid-drain-wait as a typed protocol failure", async () => {
    const socket = new BackpressureSocket();

    const pending = writePacket(socket, "<plist/>", 1, createDeadline(5_000)).catch(
      (caught: unknown) => caught
    );
    socket.emit("close");
    const error = await pending;

    expect(error).toBeInstanceOf(IosDeviceTransportError);
    expect((error as IosDeviceTransportError).kind).toBe("protocol");
    expect(socket.listenerCount("error")).toBe(0);
  });

  it("skips the wait machinery entirely when the kernel buffer accepts the packet", async () => {
    const socket = new BackpressureSocket();
    socket.write = () => true;

    await writePacket(socket, "<plist/>", 1, createDeadline(5_000));

    expect(socket.listenerCount("drain")).toBe(0);
    expect(socket.listenerCount("error")).toBe(0);
  });
});

describe("openUsbmuxRunnerSocket against a fake usbmuxd", () => {
  const openServers: Server[] = [];
  const socketDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      openServers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
    );
    await Promise.all(
      socketDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true }))
    );
  });

  const createSocketPath = async (): Promise<string> => {
    // os.tmpdir rather than the test scratchpad: unix socket paths are capped
    // at ~104 bytes on macOS and deep scratch paths exceed that.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-usbmux-"));
    socketDirs.push(dir);
    return path.join(dir, "usbmuxd.sock");
  };

  const readPacket = (socket: Socket): Promise<string> =>
    new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length < 16) return;
        const length = buffer.readUInt32LE(0);
        if (buffer.length < length) return;
        socket.off("data", onData);
        resolve(buffer.subarray(16, length).toString("utf8"));
      };
      socket.on("data", onData);
      socket.once("error", reject);
    });

  const startFakeUsbmuxd = async (
    socketPath: string,
    devices: Array<{ id: number; serial: string }>,
    connectResult: number,
    options: { listDevicesDelayMs?: number } = {}
  ): Promise<{ connectRequests: string[] }> => {
    const connectRequests: string[] = [];
    let connectionIndex = 0;
    const server = net.createServer((socket) => {
      const index = connectionIndex;
      connectionIndex += 1;
      void readPacket(socket).then((request) => {
        if (index === 0) {
          const entries = devices
            .map(
              (device) =>
                `<dict><key>DeviceID</key><integer>${device.id}</integer>` +
                `<key>Properties</key><dict><key>SerialNumber</key><string>${device.serial}</string></dict></dict>`
            )
            .join("");
          const reply = () =>
            socket.end(
              encodeUsbmuxPacket(
                1,
                `<plist><dict><key>DeviceList</key><array>${entries}</array></dict></plist>`
              )
            );
          if (options.listDevicesDelayMs) setTimeout(reply, options.listDevicesDelayMs);
          else reply();
          return;
        }
        connectRequests.push(request);
        socket.write(
          encodeUsbmuxPacket(
            2,
            `<plist><dict><key>MessageType</key><string>Result</string><key>Number</key><integer>${connectResult}</integer></dict></plist>`
          )
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    openServers.push(server);
    return { connectRequests };
  };

  it("resolves the mux DeviceID and connects with the port in network byte order", async () => {
    const socketPath = await createSocketPath();
    const fake = await startFakeUsbmuxd(socketPath, [{ id: 42, serial: DEVICE_UDID }], 0);

    const socket = await openUsbmuxRunnerSocket({
      udid: DEVICE_UDID,
      port: RUNNER_PORT,
      timeoutMs: 2_000,
      socketPath,
    });
    socket.destroy();

    expect(fake.connectRequests).toHaveLength(1);
    expect(fake.connectRequests[0]).toContain("<key>DeviceID</key><integer>42</integer>");
    expect(fake.connectRequests[0]).toContain(
      `<key>PortNumber</key><integer>${hostToNetworkPort(RUNNER_PORT)}</integer>`
    );
  });

  it("reports a device missing from ListDevices as unattached", async () => {
    const socketPath = await createSocketPath();
    await startFakeUsbmuxd(socketPath, [{ id: 42, serial: "00008030-000000000000AAAA" }], 0);

    const error = await openUsbmuxRunnerSocket({
      udid: DEVICE_UDID,
      port: RUNNER_PORT,
      timeoutMs: 2_000,
      socketPath,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(IosDeviceTransportError);
    expect((error as IosDeviceTransportError).kind).toBe("device-unattached");
    expect((error as IosDeviceTransportError).message).toMatch(/cable/);
  });

  it("folds the usbmuxd-unreachable hint into the message when the socket is missing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-usbmux-"));
    socketDirs.push(dir);
    const socketPath = path.join(dir, "missing.sock");

    const error = await openUsbmuxRunnerSocket({
      udid: DEVICE_UDID,
      port: RUNNER_PORT,
      timeoutMs: 2_000,
      socketPath,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(IosDeviceTransportError);
    expect((error as IosDeviceTransportError).kind).toBe("protocol");
    expect((error as IosDeviceTransportError).message).toMatch(
      /check that no sandbox blocks \/var\/run/
    );
  });

  it("reads the Connect result code off the wire: 3 is runner-not-listening, 2 is unattached", async () => {
    const socketPath = await createSocketPath();
    await startFakeUsbmuxd(socketPath, [{ id: 42, serial: DEVICE_UDID }], 3);

    const notListening = await openUsbmuxRunnerSocket({
      udid: DEVICE_UDID,
      port: RUNNER_PORT,
      timeoutMs: 2_000,
      socketPath,
    }).catch((caught: unknown) => caught);

    expect((notListening as IosDeviceTransportError).kind).toBe("runner-not-listening");
    expect((notListening as IosDeviceTransportError).retryable).toBe(true);

    const unpluggedPath = await createSocketPath();
    await startFakeUsbmuxd(unpluggedPath, [{ id: 42, serial: DEVICE_UDID }], 2);

    const unattached = await openUsbmuxRunnerSocket({
      udid: DEVICE_UDID,
      port: RUNNER_PORT,
      timeoutMs: 2_000,
      socketPath: unpluggedPath,
    }).catch((caught: unknown) => caught);

    expect((unattached as IosDeviceTransportError).kind).toBe("device-unattached");
  });

  it("charges the usbmux handshake and the HTTP exchange to one shared budget", async () => {
    const socketPath = await createSocketPath();
    await startFakeUsbmuxd(socketPath, [{ id: 42, serial: DEVICE_UDID }], 0, {
      listDevicesDelayMs: 600,
    });
    const deadline = createDeadline(1_200);
    const startedAt = Date.now();

    const error = await postRunnerCommand({
      socketFactory: () =>
        openUsbmuxRunnerSocket({
          udid: DEVICE_UDID,
          port: RUNNER_PORT,
          timeoutMs: deadline.remainingMs(),
          socketPath,
        }),
      body: { command: "status" },
      deadline,
    }).catch((caught: unknown) => caught);

    const elapsedMs = Date.now() - startedAt;
    expect(error).toBeInstanceOf(IosDeviceTransportError);
    expect((error as IosDeviceTransportError).kind).toBe("timeout");
    // The HTTP stage got only what the delayed handshake left over (~600ms of
    // the 1200), never a fresh full budget.
    const reportedMs = Number(/after (\d+)ms/.exec((error as Error).message)?.[1]);
    expect(reportedMs).toBeGreaterThan(0);
    expect(reportedMs).toBeLessThanOrEqual(650);
    // Double-spending the budget (handshake 1200 + HTTP 1200) would run ~1800ms.
    expect(elapsedMs).toBeLessThan(1_700);
  });
});
