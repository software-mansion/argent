import { once, type EventEmitter } from "node:events";
import net from "node:net";
import {
  buildUsbmuxPlistMessage,
  decodeUsbmuxPacket,
  encodeUsbmuxPacket,
  hostToNetworkPort,
  IosDeviceTransportError,
  readUsbmuxDeviceIdForSerial,
  readUsbmuxResultCode,
} from "./usbmux-protocol";

export {
  IosDeviceTransportError,
  isIosDeviceTransportError,
  type IosDeviceTransportErrorKind,
} from "./usbmux-protocol";

/**
 * usbmuxd client. Opens a raw pipe to a TCP port on a physical device.
 */

const USBMUXD_SOCKET_PATH = "/var/run/usbmuxd";
const USBMUX_DEFAULT_TIMEOUT_MS = 5_000;

/**
 * usbmuxd `Connect` result codes. BAD_DEVICE means the DeviceID is unknown.
 * CONNECTION_REFUSED means the device is attached but the port is closed.
 */
const USBMUX_RESULT_OK = 0;
const USBMUX_RESULT_BAD_DEVICE = 2;
const USBMUX_RESULT_CONNECTION_REFUSED = 3;

/** Recovery hints. The `IosDeviceTransportError` constructor folds the hint into `.message`. */
const DEVICE_UNATTACHED_HINT =
  "Connect the device by cable, trust this Mac, keep it unlocked, and retry.";
const RUNNER_NOT_LISTENING_HINT =
  "The device is reachable but the runner has not bound its port yet; wait a few seconds and retry.";
const USBMUXD_UNREACHABLE_HINT =
  "Physical iOS devices require macOS; if this is a Mac, check that no sandbox blocks /var/run.";

interface OpenUsbmuxRunnerSocketOptions {
  /** Dashed hardware UDID (e.g. 00008110-000978540290401E). */
  udid: string;
  /** Device-side TCP port the XCUITest runner listens on. */
  port: number;
  /** Budget for the whole lookup + connect exchange. Default 5s. */
  timeoutMs?: number;
  /** Test seam: a fake usbmuxd can listen on an alternative unix socket. */
  socketPath?: string;
}

/**
 * Open a paused socket that is a raw pipe to `device:port` on the given device.
 */
export async function openUsbmuxRunnerSocket(
  options: OpenUsbmuxRunnerSocketOptions
): Promise<net.Socket> {
  const socketPath = options.socketPath ?? USBMUXD_SOCKET_PATH;
  const deadline = createDeadline(options.timeoutMs ?? USBMUX_DEFAULT_TIMEOUT_MS);

  // ListDevices on a throwaway socket resolves the mux DeviceID.
  const deviceId = await resolveUsbmuxDeviceId(socketPath, options.udid, deadline);

  // Connect on a fresh socket becomes the raw byte pipe to the runner.
  return await connectToDevicePort(socketPath, options.udid, deviceId, options.port, deadline);
}

/**
 * Map a non-zero usbmuxd `Connect` result to a typed transport error.
 */
export function buildUsbmuxConnectError(
  result: number | undefined,
  context: { udid: string; port: number }
): IosDeviceTransportError {
  if (result === USBMUX_RESULT_BAD_DEVICE) {
    // Device is gone. Same verdict as a missing ListDevices entry.
    return new IosDeviceTransportError(
      "device-unattached",
      `iOS device ${context.udid} is no longer available through usbmux`,
      { retryable: false, hint: DEVICE_UNATTACHED_HINT }
    );
  }

  if (result === USBMUX_RESULT_CONNECTION_REFUSED) {
    // Device is attached. Only the runner port is closed. Retryable.
    return new IosDeviceTransportError(
      "runner-not-listening",
      `XCUITest runner is not listening on device port ${context.port}`,
      { retryable: true, hint: RUNNER_NOT_LISTENING_HINT }
    );
  }

  return new IosDeviceTransportError(
    "protocol",
    `Failed to connect to XCUITest runner through usbmux (result ${result ?? "missing"})`,
    { retryable: false, hint: DEVICE_UNATTACHED_HINT }
  );
}

/**
 * Resolve the mux DeviceID that `Connect` requires for the given UDID.
 * Throws `device-unattached` when the device is missing from `ListDevices`.
 */
async function resolveUsbmuxDeviceId(
  socketPath: string,
  udid: string,
  deadline: Deadline
): Promise<number> {
  const socket = await connectToUsbmuxd(socketPath, deadline);

  try {
    await writePacket(socket, buildUsbmuxPlistMessage("ListDevices"), 1, deadline);
    const payload = await readOnePacket(socket, deadline);
    const deviceId = readUsbmuxDeviceIdForSerial(payload.toString("utf8"), udid);

    if (deviceId !== undefined) {
      return deviceId;
    }

    throw new IosDeviceTransportError(
      "device-unattached",
      `iOS device ${udid} is not available through usbmux`,
      { retryable: false, hint: DEVICE_UNATTACHED_HINT }
    );
  } finally {
    // Lookup sockets are single-purpose. Connect needs a fresh socket.
    socket.destroy();
  }
}

/**
 * Run the `Connect` exchange. On success the same socket stops speaking the
 * plist protocol and becomes the raw byte pipe to `device:port`.
 */
async function connectToDevicePort(
  socketPath: string,
  udid: string,
  deviceId: number,
  port: number,
  deadline: Deadline
): Promise<net.Socket> {
  const socket = await connectToUsbmuxd(socketPath, deadline);

  try {
    const message = buildUsbmuxPlistMessage("Connect", {
      DeviceID: deviceId,
      PortNumber: hostToNetworkPort(port),
    });

    await writePacket(socket, message, 2, deadline);

    const payload = await readOnePacket(socket, deadline);
    const result = readUsbmuxResultCode(payload.toString("utf8"));

    if (result !== USBMUX_RESULT_OK) {
      throw buildUsbmuxConnectError(result, { udid, port });
    }

    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

/** Open a unix socket to the usbmuxd daemon within the remaining deadline. */
async function connectToUsbmuxd(socketPath: string, deadline: Deadline): Promise<net.Socket> {
  const timeoutMs = deadline.remainingMs();

  requireTimeRemaining(timeoutMs, "connect to usbmuxd");

  // `once` attaches its `connect` and `error` listeners synchronously, before
  // the first await, so an early socket error settles the wait rather than
  // surfacing as an unhandled `error` event.
  const socket = net.createConnection(socketPath);
  const abort = new AbortController();
  const timer = setTimeout(() => {
    abort.abort(
      new IosDeviceTransportError("timeout", `Timed out connecting to usbmuxd at ${socketPath}`, {
        retryable: true,
      })
    );
  }, timeoutMs);

  try {
    await once(socket, "connect", { signal: abort.signal });

    return socket;
  } catch (error) {
    socket.destroy();

    throw (
      abortReason(error) ??
      new IosDeviceTransportError("protocol", `Cannot reach usbmuxd at ${socketPath}`, {
        retryable: false,
        hint: USBMUXD_UNREACHABLE_HINT,
        cause: error,
      })
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The slice of net.Socket the packet writer touches: a writable that emits
 * `drain`, `error` and `close`.
 */
interface UsbmuxWritableSocket extends EventEmitter {
  write(data: Buffer): boolean;
}

/**
 * Write one framed packet. Bounds any backpressure wait by the deadline.
 *
 * @param tag request identifier echoed in the reply.
 */
export async function writePacket(
  socket: UsbmuxWritableSocket,
  payloadXml: string,
  tag: number,
  deadline: Deadline
): Promise<void> {
  const timeoutMs = deadline.remainingMs();
  requireTimeRemaining(timeoutMs, "write usbmuxd request");

  if (socket.write(encodeUsbmuxPacket(tag, payloadXml))) {
    return;
  }

  // The timer and a close both settle the drain wait through the abort signal,
  // carrying the typed error as the reason. `once` detaches its own `drain` and
  // `error` listeners however the wait settles, and the close listener goes in
  // `finally`: this socket becomes the raw device pipe, so nothing may linger.
  const abort = new AbortController();
  const timer = setTimeout(() => {
    abort.abort(
      new IosDeviceTransportError("timeout", "Timed out writing usbmuxd request", {
        retryable: true,
      })
    );
  }, timeoutMs);
  const onClose = () => {
    abort.abort(
      new IosDeviceTransportError("protocol", "usbmuxd closed the connection unexpectedly", {
        retryable: false,
      })
    );
  };

  socket.once("close", onClose);

  try {
    await once(socket, "drain", { signal: abort.signal });
  } catch (error) {
    throw abortReason(error) ?? error;
  } finally {
    clearTimeout(timer);
    socket.off("close", onClose);
  }
}

/**
 * The typed error an aborted `once` wait was settled with, when `error` is that
 * abort; undefined for anything else, such as the socket's own `error`.
 */
function abortReason(error: unknown): IosDeviceTransportError | undefined {
  const cause = error instanceof Error && error.name === "AbortError" ? error.cause : undefined;

  return cause instanceof IosDeviceTransportError ? cause : undefined;
}

/**
 * Read exactly one framed packet, then pause the socket.
 */
async function readOnePacket(socket: net.Socket, deadline: Deadline): Promise<Buffer> {
  const timeoutMs = deadline.remainingMs();
  requireTimeRemaining(timeoutMs, "read usbmuxd response");

  return await new Promise<Buffer>((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;

    const timer = setTimeout(() => {
      finish(
        new IosDeviceTransportError("timeout", "Timed out reading usbmuxd response", {
          retryable: true,
        })
      );
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      let packet;

      try {
        packet = decodeUsbmuxPacket(buffer);
      } catch (error) {
        finish(error as Error);
        return;
      }

      if (!packet) {
        return;
      }

      const remainder = buffer.subarray(packet.bytesConsumed);

      finish(undefined, packet.payload, remainder.length > 0 ? remainder : undefined);
    };

    const onError = (error: Error) => finish(error);

    const onClose = () =>
      finish(
        new IosDeviceTransportError("protocol", "usbmuxd closed the connection unexpectedly", {
          retryable: false,
        })
      );

    const finish = (error?: Error, payload?: Buffer, remainder?: Buffer) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);

      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      socket.pause();

      // Leftover bytes belong to the raw device pipe. Unshift them for the HTTP layer.
      if (remainder) {
        socket.unshift(remainder);
      }

      if (error) {
        reject(error);
      } else {
        resolve(payload as Buffer);
      }
    };

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.resume();
  });
}

/**
 * Decreasing time budget shared by every stage of one operation.
 */
export interface Deadline {
  remainingMs(): number;
}

/** Create a decreasing timeout budget. */
export function createDeadline(timeoutMs: number): Deadline {
  const expiresAt = Date.now() + timeoutMs;

  return {
    remainingMs: () => expiresAt - Date.now(),
  };
}

/**
 * Throw a retryable timeout when the budget is already spent.
 *
 * @param action name of the stage that ran out of time.
 */
export function requireTimeRemaining(timeoutMs: number, action: string): void {
  if (timeoutMs > 0) return;

  throw new IosDeviceTransportError("timeout", `No time remaining to ${action}`, {
    retryable: true,
  });
}
