import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Vega Virtual Device (VVD) discovery.
 *
 * The VVD is an Android-emulator-derived QEMU. It writes a QMP control socket
 * under /tmp named for its emulator console port (`/tmp/qmp-socket-<port>.sock`).
 * argent never speaks the QMP protocol — input, screen capture, describe, and
 * the toolkit flag all go through `adb` (`inputd-cli`, `emu screenrecord`,
 * `forward` + JSON-RPC). We only parse that socket's *filename* to recover the
 * console port, which yields the `emulator-<port>` serial the whole adb stack
 * targets. So this module is filename parsing, not a network client.
 */

/**
 * Thrown when more than one Vega Virtual Device is running. v1 cannot
 * disambiguate which one a tool call targets (see `discoverQmpSocket`), so tools
 * surface this rather than acting on an arbitrary device. Typed so callers that
 * normally swallow discovery failures (e.g. `describe`) can still let it through.
 */
export class MultipleVegaDevicesError extends Error {
  constructor(sockets: string[]) {
    super(
      `Multiple Vega Virtual Devices detected (${sockets.length} QMP sockets: ` +
        `${sockets.join(", ")}). argent v1 targets a single running VVD and cannot ` +
        "tell which one a tool call refers to — stop all but one VVD and retry."
    );
    this.name = "MultipleVegaDevicesError";
  }
}

/**
 * Locate the running VVD's QMP socket file.
 *
 * v1 supports a single running VVD. If more than one socket is present we throw
 * rather than silently pick one (`matches.sort()[0]` used to): every Vega tool
 * resolves its target through here (→ `discoverVegaConsolePort` →
 * `emulator-<port>`), so picking blindly would route a call to whichever device
 * sorts first — a stale entry, or simply the wrong VVD. The caller-supplied
 * `udid` can't be mapped back to a specific socket (the Vega CLI serial does not
 * match the console port), so "exactly one" is the only target we can resolve
 * unambiguously. Erroring keeps multi-VVD honest until per-device targeting
 * exists.
 */
export async function discoverQmpSocket(): Promise<string> {
  const isQmp = (name: string) => name.startsWith("qmp-socket-") && name.endsWith(".sock");
  // The socket lives in the OS temp dir; on macOS `tmpdir()` is /var/folders/…
  // but the VVD writes to the canonical /tmp, so probe both. Dedupe by socket
  // *filename* (which encodes the console port = one device), not full path, so
  // the same socket seen under two probed dirs counts once rather than tripping
  // the multi-device guard below.
  const dirs = Array.from(new Set([tmpdir(), "/tmp"]));
  const byName = new Map<string, string>();
  for (const dir of dirs) {
    const entries = await readdir(dir).catch(() => [] as string[]);
    for (const name of entries) {
      if (isQmp(name) && !byName.has(name)) byName.set(name, join(dir, name));
    }
  }
  const names = [...byName.keys()].sort();
  if (names.length === 0) {
    throw new Error(
      "No Vega Virtual Device QMP socket found (looked for /tmp/qmp-socket-*.sock). " +
        "Start the VVD with `vega virtual-device start` and retry."
    );
  }
  if (names.length > 1) {
    throw new MultipleVegaDevicesError(names);
  }
  return byName.get(names[0]!)!;
}

/**
 * Derive the VVD's emulator console port from its QMP socket name
 * (`qmp-socket-<consolePort>.sock`). The VVD is an Android-emulator-derived
 * QEMU, so this port is the standard emulator console (5554, 5556, …) and the
 * device appears to adb as `emulator-<consolePort>` — the serial every Vega tool
 * (input, screen capture, describe, toolkit flag) drives over `adb`.
 */
export async function discoverVegaConsolePort(): Promise<number> {
  const socket = await discoverQmpSocket();
  const m = socket.match(/qmp-socket-(\d+)\.sock$/);
  if (!m) {
    throw new Error(`Could not derive emulator console port from QMP socket name: ${socket}`);
  }
  return parseInt(m[1]!, 10);
}
