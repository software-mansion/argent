import * as net from "node:net";
import * as fs from "node:fs";
import { execFile, ChildProcess } from "node:child_process";
import {
  TypedEventEmitter,
  type DeviceInfo,
  type ServiceBlueprint,
  type ServiceInstance,
  type ServiceEvents,
} from "@argent/registry";
import { tvosAxServiceBinaryPath, tvosHidDaemonBinaryPath } from "@argent/native-devtools-ios";
import { ensureAutomationEnabled } from "./ax-service";
import { listIosSimulators, cacheSimulatorRuntimeKind } from "../utils/ios-devices";
import { cachedDeviceSetForUdid, simctlPrefix } from "../utils/ios-device-sets";
import { UnsupportedOperationError } from "../utils/capability";
import type { TvControlApi, TvDescribeResponse, TvDirection, TvElement } from "./tv-control-types";

// Re-exported so existing importers of `tv-control` keep working.
export type { TvControlApi, TvDescribeResponse, TvDirection, TvElement };

export const TV_CONTROL_NAMESPACE = "TvControl";

// DeviceInfo-via-options pattern, matching the other Apple blueprints.
type TvControlFactoryOptions = Record<string, unknown> & {
  device: DeviceInfo;
};

/**
 * `ServiceRef` for the tvOS control service, keyed by a resolved `DeviceInfo`.
 * The factory re-checks the runtime kind before spawning: `resolveDevice`
 * classifies by UDID shape and cannot tell tvOS from iOS.
 */
export function tvControlRef(device: DeviceInfo): {
  urn: string;
  options: TvControlFactoryOptions;
} {
  return {
    urn: `${TV_CONTROL_NAMESPACE}:${device.id}`,
    options: { device },
  };
}

function axSocketPath(udid: string): string {
  return `/tmp/argent-tv-ax-${udid.slice(0, 8)}.sock`;
}

function hidSocketPath(udid: string): string {
  return `/tmp/argent-tv-hid-${udid.slice(0, 8)}.sock`;
}

/**
 * The tvOS daemons are themselves the socket *server* (bind → accept → read one
 * line → write JSON → close), the inverse of the iOS ax-service where the host
 * listens — so every command is its own short-lived client connection.
 */
function sendLine(socketPath: string, line: string, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const chunks: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`tv-control request timed out: ${line.trim()}`));
    }, timeoutMs);

    const done = (err: Error | null, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value ?? "");
    };

    socket.on("connect", () => socket.write(line.endsWith("\n") ? line : line + "\n"));
    socket.on("data", (d: Buffer) => chunks.push(d));
    socket.on("end", () => done(null, Buffer.concat(chunks).toString("utf8")));
    socket.on("close", () => done(null, Buffer.concat(chunks).toString("utf8")));
    socket.on("error", (err) => done(err));
  });
}

// The HID daemon types ~1 keypress every ~40ms and only replies once the WHOLE
// string is entered, so a fixed 10s timeout would fire mid-type on a long input
// and report a hard failure for text that was largely entered. The per-char
// budget is generous over the observed cadence, plus connect/setup overhead.
const TYPE_MS_PER_CHAR = 60;
const TYPE_BASE_MS = 10_000;
export function typeTimeoutMs(textLength: number): number {
  return TYPE_BASE_MS + textLength * TYPE_MS_PER_CHAR;
}

async function sendJson(socketPath: string, command: string, timeoutMs?: number): Promise<unknown> {
  const raw = (await sendLine(socketPath, command, timeoutMs)).trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`tv-control got non-JSON reply to "${command}": ${raw.slice(0, 200)}`);
  }
}

// Spawn the AX reader *inside* the simulator. It binds its own unix socket on
// the host-shared /tmp, so the host connects to that path directly.
function spawnAxDaemon(udid: string, socketPath: string): ChildProcess {
  // The factory's device-list validation already learned this UDID's device
  // set, so the synchronous cached lookup is warm here.
  const proc = execFile(
    "xcrun",
    [
      ...simctlPrefix(cachedDeviceSetForUdid(udid)),
      "spawn",
      udid,
      tvosAxServiceBinaryPath(),
      "--socket",
      socketPath,
      "--timeout",
      "3600",
    ],
    { encoding: "utf8" }
  ) as ChildProcess;
  const tag = udid.slice(0, 8);
  proc.stderr?.on("data", (data: string) => process.stderr.write(`[tvos-ax ${tag}] ${data}`));
  return proc;
}

// Run the HID injector on the host. It loads SimulatorKit and holds one
// SimDeviceLegacyClient open against the UDID for its lifetime.
function spawnHidDaemon(udid: string, socketPath: string): ChildProcess {
  const proc = execFile(
    tvosHidDaemonBinaryPath(),
    ["--udid", udid, "--socket", socketPath, "--timeout", "3600"],
    { encoding: "utf8" }
  ) as ChildProcess;
  const tag = udid.slice(0, 8);
  proc.stderr?.on("data", (data: string) => process.stderr.write(`[tvos-hid ${tag}] ${data}`));
  return proc;
}

// Readiness is probed on the socket itself, so one wait covers both the in-sim
// and the host daemon.
async function waitForSocket(
  socketPath: string,
  proc: ChildProcess,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let exited: number | null | undefined;
  // A daemon that fails to *spawn* (missing binary, missing `xcrun`) emits
  // `error`, not `exit`; unwatched, the wait polls to the full timeout and
  // hides the real cause.
  let spawnError: Error | undefined;
  // Removed on every exit path so they don't accumulate on a daemon that
  // lives ~1h.
  const onExit = (code: number | null) => (exited = code);
  const onError = (err: Error) => (spawnError = err);
  proc.once("exit", onExit);
  proc.once("error", onError);
  try {
    while (Date.now() < deadline) {
      if (spawnError) {
        throw new Error(
          `tv daemon failed to spawn before its socket was ready: ${spawnError.message}`
        );
      }
      if (exited !== undefined) {
        throw new Error(`tv daemon exited with code ${exited} before its socket was ready`);
      }
      if (fs.existsSync(socketPath)) {
        // Confirm it actually accepts, not just that the file exists.
        const ok = await new Promise<boolean>((resolve) => {
          const s = net.createConnection(socketPath);
          s.on("connect", () => {
            s.destroy();
            resolve(true);
          });
          s.on("error", () => resolve(false));
        });
        if (ok) return;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`Timed out waiting for tv daemon socket ${socketPath}`);
  } finally {
    proc.removeListener("exit", onExit);
    proc.removeListener("error", onError);
  }
}

export const tvControlBlueprint: ServiceBlueprint<TvControlApi, DeviceInfo> = {
  namespace: TV_CONTROL_NAMESPACE,

  getURN(device: DeviceInfo) {
    return `${TV_CONTROL_NAMESPACE}:${device.id}`;
  },

  async factory(_deps, _payload, options) {
    const opts = options as unknown as TvControlFactoryOptions | undefined;
    if (!opts?.device) {
      throw new Error(
        `${TV_CONTROL_NAMESPACE}.factory requires a resolved DeviceInfo via options.device. ` +
          `Use tvControlRef(device) when registering the service ref.`
      );
    }

    const { device } = opts;
    if (typeof device.id !== "string" || device.id.length === 0) {
      throw new Error(
        `${TV_CONTROL_NAMESPACE}.factory requires a non-empty device.id; got ${JSON.stringify(device.id)}.`
      );
    }
    const udid = device.id;

    // Shape-based classification can't tell tvOS from iOS, so confirm the
    // runtime via simctl before spawning the tv daemons.
    const sims = await listIosSimulators();
    const match = sims.find((s) => s.udid === udid);
    if (!match) {
      throw new Error(
        `${TV_CONTROL_NAMESPACE}: no available simulator with udid '${udid}'. Run list-devices to find a booted Apple TV.`
      );
    }
    // Warm the synchronous runtime-kind cache the telemetry hot path reads:
    // a tv-remote-only session never touches describe/screenshot/streaming and
    // would otherwise stay attributed to the coarse `ios` platform, unlike
    // Android TV whose factory warms its cache too.
    cacheSimulatorRuntimeKind(udid, match.runtimeKind);
    if (match.runtimeKind !== "tv") {
      // UnsupportedOperationError so http.ts maps it to 400, not 500 — a 500
      // reads as a transient fault and invites retries of a wrong target.
      throw new UnsupportedOperationError(
        "tv-remote",
        device,
        `${TV_CONTROL_NAMESPACE} is tvOS-only — '${match.name}' (${match.runtime}) is not a tvOS ` +
          `simulator; use the iOS tools for it`
      );
    }
    if (match.state !== "Booted") {
      throw new Error(
        `${TV_CONTROL_NAMESPACE}: Apple TV '${match.name}' is ${match.state}. Boot it first with boot-device.`
      );
    }

    const events = new TypedEventEmitter<ServiceEvents>();
    const axSock = axSocketPath(udid);
    const hidSock = hidSocketPath(udid);
    let disposed = false;

    await ensureAutomationEnabled(udid);

    let axProc = spawnAxDaemon(udid, axSock);
    const hidProc = spawnHidDaemon(udid, hidSock);

    // Spawned via `simctl spawn`, not as a child of the app, so it survives
    // launch-app / restart-app — but AXRuntime's `primaryApp` cache can keep
    // pointing at the dead app and make describe report an empty focus set on a
    // rendered screen. Hence two recovery paths: respawn on a (rare) process
    // exit, and on-demand `recycleAx()` to drop a stale cache.
    let axExited = false;
    const onAxExit = (_code: number | null) => {
      if (disposed) return;
      axExited = true;
    };
    axProc.on("exit", onAxExit);
    // Handle a post-init `error` (unhandled, it crashes Node); treat it like an
    // exit so the next `ensureAxAlive` respawns.
    const onAxError = (_err: Error) => {
      if (disposed) return;
      axExited = true;
    };
    axProc.on("error", onAxError);

    const onHidExit = (code: number | null) => {
      if (disposed) return;
      // HID daemon exit is fatal for the service — no reconnect path there.
      const err = new Error(`tvOS hid-daemon exited with code ${code}`);
      events.emit("terminated", err);
    };
    hidProc.on("exit", onHidExit);
    // Fatal like exit, and handled so the error event doesn't crash the process.
    const onHidError = (err: Error) => {
      if (disposed) return;
      events.emit("terminated", new Error(`tvOS hid-daemon error: ${err.message}`));
    };
    hidProc.on("error", onHidError);

    try {
      await Promise.all([
        waitForSocket(axSock, axProc, 15_000),
        waitForSocket(hidSock, hidProc, 15_000),
      ]);
    } catch (err) {
      // The factory is about to throw, so this instance is never handed to the
      // registry. Detach before killing, so the kill doesn't fire `terminated`
      // on an instance nobody subscribed to.
      axProc.removeListener("exit", onAxExit);
      axProc.removeListener("error", onAxError);
      hidProc.removeListener("exit", onHidExit);
      hidProc.removeListener("error", onHidError);
      // SIGKILL the ax daemon: under `simctl spawn` SIGTERM doesn't reliably
      // reach the in-sim process, which would orphan it. The hid daemon is a
      // direct host process, so SIGTERM reaps it.
      if (!axProc.killed) axProc.kill("SIGKILL");
      if (!hidProc.killed) hidProc.kill("SIGTERM");
      // Drop any socket a daemon already bound, so a stale file can't make the
      // next factory's accept-probe read as "ready" against a dead socket.
      for (const p of [axSock, hidSock]) {
        try {
          fs.unlinkSync(p);
        } catch {
          /* socket never bound or already gone */
        }
      }
      throw err;
    }

    // Serialized via `axRespawn` so concurrent ax commands can't race a
    // half-spawned daemon or double-spawn.
    let axRespawn: Promise<void> | null = null;
    async function spawnFreshAx(): Promise<void> {
      if (axProc && !axProc.killed) {
        axProc.removeListener("exit", onAxExit);
        axProc.removeListener("error", onAxError);
        axProc.kill("SIGKILL");
      }
      axExited = false;
      try {
        fs.unlinkSync(axSock);
      } catch {
        /* no stale socket to remove */
      }
      axProc = spawnAxDaemon(udid, axSock);
      axProc.on("exit", onAxExit);
      axProc.on("error", onAxError);
      try {
        await waitForSocket(axSock, axProc, 15_000);
      } catch (err) {
        // The socket never came up (a bind that timed out, not a clean exit —
        // `onAxExit` only fires for the latter). Mark the daemon dead so the
        // next `ensureAxAlive` respawns instead of connecting to a socket that
        // was unlinked and never rebound, and reap the half-spawned process.
        axExited = true;
        if (!axProc.killed) {
          axProc.removeListener("exit", onAxExit);
          axProc.removeListener("error", onAxError);
          axProc.kill("SIGKILL");
        }
        throw err;
      }
      // dispose() may have run while we awaited the new socket: it kills only
      // the axProc current at *its* moment and doesn't wait for an in-flight
      // respawn, so reap what we spawned or it outlives teardown.
      if (disposed) {
        if (!axProc.killed) {
          axProc.removeListener("exit", onAxExit);
          axProc.removeListener("error", onAxError);
          axProc.kill("SIGKILL");
        }
        try {
          fs.unlinkSync(axSock);
        } catch {
          /* socket already gone */
        }
      }
    }

    // Respawn only if the daemon process actually exited (rare — it normally
    // outlives the app). Stale-cache recovery goes through `recycleAx`.
    async function ensureAxAlive(): Promise<void> {
      if (disposed) return;
      // A respawn in flight (e.g. a concurrent `recycleAx`) means the socket is
      // unlinked and not yet rebound: `axExited` is false, yet connecting now
      // would hit a missing socket. Wait it out before the liveness check.
      if (axRespawn) {
        await axRespawn;
        return;
      }
      if (!axExited) return;
      axRespawn = spawnFreshAx().finally(() => {
        axRespawn = null;
      });
      await axRespawn;
    }

    // Force a fresh daemon regardless of liveness — drops a stale primaryApp
    // cache. Coalesces concurrent callers onto a single respawn.
    async function recycleAx(): Promise<void> {
      if (disposed) return;
      if (!axRespawn)
        axRespawn = spawnFreshAx().finally(() => {
          axRespawn = null;
        });
      await axRespawn;
    }

    // Tolerates the unlink→rebind window of a *concurrent* recycle: the service
    // instance is shared per device, so once `ensureAxAlive` drops its
    // single-flight guard another in-flight call can unlink the socket before
    // this connect lands, surfacing as ECONNREFUSED/ENOENT on a socket that is
    // merely mid-respawn. Bounded, so a genuinely dead daemon (no respawn
    // pending) still propagates immediately.
    async function sendAx(command: string, timeoutMs: number): Promise<unknown> {
      for (let attempt = 0; ; attempt++) {
        await ensureAxAlive();
        try {
          return await sendJson(axSock, command, timeoutMs);
        } catch (err) {
          // `axRespawn` is set synchronously (kill + unlink precede
          // spawnFreshAx's first await), so it is non-null here exactly when a
          // respawn pulled the socket out from under us; otherwise it's real.
          if (axRespawn && attempt < 2) {
            await axRespawn.catch(() => {});
            continue;
          }
          throw err;
        }
      }
    }

    const api: TvControlApi = {
      async describe(): Promise<TvDescribeResponse> {
        const r = (await sendAx("describe", 10_000)) as Partial<TvDescribeResponse>;
        return {
          bundleId: r.bundleId,
          focused: r.focused ?? null,
          focusable: r.focusable ?? [],
        };
      },

      async navigate(direction: TvDirection): Promise<void> {
        await sendJson(hidSock, `navigate ${direction}`);
      },

      async type(text: string): Promise<void> {
        // The daemon reads one line per connection, so an embedded newline would
        // type only the first line yet resolve cleanly, reporting the whole
        // string as typed. Reject it, like the Vega `send_text` backend.
        if (/[\n\r]/.test(text)) {
          throw new Error("Apple TV keyboard text must not contain newlines");
        }
        await sendJson(hidSock, `type ${text}`, typeTimeoutMs(text.length));
      },

      async recycleAx(): Promise<void> {
        await recycleAx();
      },
    };

    const instance: ServiceInstance<TvControlApi> = {
      api,
      dispose: async () => {
        disposed = true;
        // Wait out an in-flight respawn so we kill the *final* axProc rather
        // than one spawnFreshAx is about to replace. spawnFreshAx re-checks
        // `disposed` and self-reaps, so either ordering tears the daemon down.
        if (axRespawn) {
          try {
            await axRespawn;
          } catch {
            /* respawn failed — nothing extra to kill beyond the current axProc */
          }
        }
        // SIGKILL for the same reason as spawnFreshAx: under `simctl spawn`
        // SIGTERM doesn't reliably reach the in-sim process, which would leave
        // it orphaned. The hid daemon is a direct host process, so SIGTERM does.
        if (!axProc.killed) axProc.kill("SIGKILL");
        if (!hidProc.killed) hidProc.kill("SIGTERM");
        for (const p of [axSock, hidSock]) {
          try {
            fs.unlinkSync(p);
          } catch {
            /* socket already gone — nothing to clean up */
          }
        }
      },
      events,
    };

    return instance;
  },
};
