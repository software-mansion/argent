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

// Re-export the shared TV contract so existing importers of `tv-control` keep
// working. The Android TV backend implements the same `TvControlApi`.
export type { TvControlApi, TvDescribeResponse, TvDirection, TvElement };

export const TV_CONTROL_NAMESPACE = "TvControl";

// DeviceInfo-via-options pattern, matching the other Apple blueprints.
type TvControlFactoryOptions = Record<string, unknown> & {
  device: DeviceInfo;
};

/**
 * Build the `ServiceRef` for the tvOS control service keyed by a resolved
 * `DeviceInfo`. The factory verifies the target really is a tvOS simulator
 * before spawning anything — `resolveDevice` only classifies by UDID shape and
 * cannot distinguish tvOS from iOS, so the runtime-kind check lives here.
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

// The TV read-path / control types (`TvElement`, `TvDescribeResponse`,
// `TvDirection`, `TvControlApi`) live in `tv-control-types.ts` so the Android TV
// backend can share them without importing the iOS daemon binaries. The tvOS
// daemon JSON shapes mirror `TvDescribeResponse`.

function axSocketPath(udid: string): string {
  return `/tmp/argent-tv-ax-${udid.slice(0, 8)}.sock`;
}

function hidSocketPath(udid: string): string {
  return `/tmp/argent-tv-hid-${udid.slice(0, 8)}.sock`;
}

/**
 * The tvOS daemons are themselves the socket *server* (bind → accept → read one
 * line → write JSON → close), the inverse of the iOS ax-service where the host
 * listens. So a request is one short-lived client connection per command:
 * connect, write the line, read until the daemon closes, parse.
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

// The HID daemon types ~1 keypress every ~40ms and only writes its reply once
// the WHOLE string is entered, so the timeout for a `type` must scale with the
// input length — the fixed 10s default (fine for a single `navigate` press)
// would fire mid-type on a long input, rejecting and destroying the socket while
// the daemon is still typing, so `keyboard` reports a hard failure for text that
// was in fact largely entered. Budget the per-char cost (generous over the ~40ms
// observed) plus fixed overhead (connect + the daemon's own setup) so the reply
// reliably wins the race.
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
  // Sync by contract (returns the ChildProcess); the factory's device-list
  // validation has already learned the UDID's device set, so the cached view
  // is warm here.
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

// Poll until the daemon has bound its socket (it prints a "ready" line on
// stdout, but waiting on the socket file existing + accepting is simpler and
// works identically for both the in-sim and host daemons).
async function waitForSocket(
  socketPath: string,
  proc: ChildProcess,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let exited: number | null | undefined;
  // A daemon that fails to *spawn* (missing binary, missing `xcrun`) emits
  // `error`, not `exit`; without watching for it the wait polls to the full
  // timeout and hides the real cause. ax-service listens for both too.
  let spawnError: Error | undefined;
  // Listeners are scoped to this wait — removed on every exit path so they don't
  // accumulate on a daemon that lives ~1h.
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

    // resolveDevice classifies by UDID shape alone and can't tell tvOS from iOS,
    // so confirm the runtime here via simctl before spawning the tv daemons.
    // This also yields a clear error when someone passes an iPhone udid.
    const sims = await listIosSimulators();
    const match = sims.find((s) => s.udid === udid);
    if (!match) {
      throw new Error(
        `${TV_CONTROL_NAMESPACE}: no available simulator with udid '${udid}'. Run list-devices to find a booted Apple TV.`
      );
    }
    // Warm the synchronous runtime-kind cache the telemetry hot path reads. Without
    // this, a tv-remote-only Apple TV session never touches describe/screenshot/
    // streaming and so stays attributed to the coarse `ios` platform — whereas the
    // Android TV factory warms its cache via getAndroidRuntimeKind. Warming here
    // makes the two TV platforms symmetric (refined from the call after the first).
    cacheSimulatorRuntimeKind(udid, match.runtimeKind);
    if (match.runtimeKind !== "tv") {
      // Wrong device class (an iPhone shape-classifies as iOS and reaches here).
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

    // setfocus needs AutomationEnabled; same pref the iOS ax-service relies on.
    await ensureAutomationEnabled(udid);

    let axProc = spawnAxDaemon(udid, axSock);
    const hidProc = spawnHidDaemon(udid, hidSock);

    // The ax daemon is a standalone process spawned via `simctl spawn` — it is
    // NOT a child of the foreground app, so it survives launch-app / restart-app.
    // What it does NOT survive cleanly is AXRuntime's `primaryApp` cache, which
    // can keep pointing at the now-dead app and make describe report an empty
    // focus set on a fully-rendered screen. Two recovery paths therefore
    // exist: respawn if the process happens to have exited (rare), and an
    // on-demand `recycleAx()` that kills + respawns to drop a stale cache.
    let axExited = false;
    const onAxExit = (_code: number | null) => {
      if (disposed) return;
      axExited = true;
    };
    axProc.on("exit", onAxExit);
    // Handle a post-init `error` (else Node crashes on the unhandled event);
    // treat it like an exit so the next `ensureAxAlive` respawns.
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
      // registry and no one is subscribed to its events. Detach the exit
      // listeners before killing the procs so the kill doesn't fire a
      // `terminated` emit on an instance that was never returned.
      axProc.removeListener("exit", onAxExit);
      axProc.removeListener("error", onAxError);
      hidProc.removeListener("exit", onHidExit);
      hidProc.removeListener("error", onHidError);
      // SIGKILL the ax daemon to match dispose()/spawnFreshAx: it runs via
      // `simctl spawn`, where SIGTERM doesn't reliably propagate to the in-sim
      // process, so a SIGTERM here would orphan the in-sim ax daemon when one
      // socket came up but the other timed out. The hid daemon is a direct host
      // process, so SIGTERM reaps it.
      if (!axProc.killed) axProc.kill("SIGKILL");
      if (!hidProc.killed) hidProc.kill("SIGTERM");
      // Unlink any socket a daemon already bound before the other timed out, so
      // a stale file can't make the next factory's accept-probe see a false
      // "ready" against a dead socket before the fresh daemon rebinds.
      for (const p of [axSock, hidSock]) {
        try {
          fs.unlinkSync(p);
        } catch {
          /* socket never bound or already gone */
        }
      }
      throw err;
    }

    // Kill any current ax daemon, clear its socket, spawn a fresh one and wait
    // until it accepts connections. Serialized via `axRespawn` so concurrent
    // ax commands can't race a half-spawned daemon or double-spawn.
    let axRespawn: Promise<void> | null = null;
    async function spawnFreshAx(): Promise<void> {
      if (axProc && !axProc.killed) {
        axProc.removeListener("exit", onAxExit);
        axProc.removeListener("error", onAxError);
        axProc.kill("SIGKILL");
      }
      axExited = false;
      // Best-effort: the socket file may not exist yet on first spawn.
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
        // The socket never came up (a slow bind that timed out, not a clean
        // process exit — `onAxExit` only fires for the latter). Mark the daemon
        // dead so the next `ensureAxAlive` re-enters the respawn branch instead
        // of returning early and connecting to the socket we just unlinked and
        // never rebound. Best-effort reap the half-spawned process too.
        axExited = true;
        if (!axProc.killed) {
          axProc.removeListener("exit", onAxExit);
          axProc.removeListener("error", onAxError);
          axProc.kill("SIGKILL");
        }
        throw err;
      }
      // dispose() may have run while we were awaiting the new socket. dispose
      // kills only the axProc reference current at *its* moment and doesn't wait
      // for an in-flight respawn, so without this a daemon spawned here would
      // outlive teardown (orphaned in-sim process + a re-created socket file).
      // Reap what we just spawned and re-clear the socket.
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
    // outlives the app). Stale-cache recovery goes through `recycleAx` instead.
    async function ensureAxAlive(): Promise<void> {
      if (disposed) return;
      // A respawn already in flight (e.g. a concurrent `recycleAx`) means the
      // socket has been unlinked and not yet rebound: `axExited` is false but
      // the daemon is mid-rebuild, so connecting now would hit a missing socket.
      // Wait it out before the liveness check rather than racing past it.
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

    // Send a command on the ax socket, tolerating the unlink→rebind window of a
    // *concurrent* recycle. `ensureAxAlive` only holds the single-flight guard
    // for its own duration; once it returns, a recycle on another in-flight call
    // (the service instance is shared per device, so two concurrent describes
    // can race) can set `axRespawn`, unlink the socket, and begin rebinding
    // before this connect lands — surfacing as ECONNREFUSED/ENOENT on a socket
    // that is merely mid-respawn, not dead. When a respawn is in flight at the
    // point of failure, wait it out and retry against the rebound socket rather
    // than reporting a hard failure. Bounded so a genuinely dead daemon (no
    // respawn pending) still propagates immediately.
    async function sendAx(command: string, timeoutMs: number): Promise<unknown> {
      for (let attempt = 0; ; attempt++) {
        await ensureAxAlive();
        try {
          return await sendJson(axSock, command, timeoutMs);
        } catch (err) {
          // Only a respawn racing this connect is recoverable: `axRespawn` is set
          // synchronously (kill + unlink happen before spawnFreshAx's first
          // await), so it is non-null here exactly when the socket was pulled out
          // from under us. No respawn in flight ⇒ a real failure ⇒ rethrow.
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
        // type only the first line while resolving cleanly (reporting the whole
        // string as typed). Reject it, like the Vega `send_text` backend.
        if (/[\n\r]/.test(text)) {
          throw new Error("Apple TV keyboard text must not contain newlines");
        }
        // Scale the socket timeout to the input length (see typeTimeoutMs) so a
        // long string doesn't time out mid-type and report a false failure.
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
        // Wait out an in-flight recycle/respawn so we kill the *final* axProc
        // (and clean its socket) rather than a reference that spawnFreshAx is
        // about to replace. spawnFreshAx also re-checks `disposed` after its
        // await and self-reaps, so the daemon is torn down on either ordering.
        if (axRespawn) {
          try {
            await axRespawn;
          } catch {
            /* respawn failed — nothing extra to kill beyond the current axProc */
          }
        }
        // SIGKILL the ax daemon (axProc may be a respawned instance): it runs
        // via `simctl spawn`, where SIGTERM doesn't reliably propagate to the
        // in-sim process — so spawnFreshAx already uses SIGKILL to reap it, and
        // dispose must match or risk orphaning the in-sim daemon. The hid daemon
        // is a direct host process, so SIGTERM is enough there.
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
