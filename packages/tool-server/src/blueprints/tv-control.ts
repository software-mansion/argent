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
import { listIosSimulators } from "../utils/ios-devices";

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

// ── AX read-path types (mirror the tvos_ax_service JSON shapes) ──

export interface TvElement {
  label?: string;
  frame?: { x: number; y: number; width: number; height: number };
  tapPoint?: { x: number; y: number };
  traits?: string[];
  value?: string;
  isFocused?: boolean;
}

export interface TvDescribeResponse {
  bundleId?: string;
  focused: TvElement | null;
  focusable: TvElement[];
  screenFrame?: { width: number; height: number };
}

export type TvDirection =
  | "up"
  | "down"
  | "left"
  | "right"
  | "select"
  | "menu"
  | "home"
  | "playpause";

export interface TvControlApi {
  /** Read the currently focused element plus all focusable elements. */
  describe(): Promise<TvDescribeResponse>;
  /** Read the full accessibility tree. */
  hierarchy(): Promise<unknown>;
  /** Jump focus directly to the element with the given label (requires AutomationEnabled). */
  setFocus(label: string): Promise<{ ok: boolean; message: string }>;
  /** Send a Siri-remote directional / button event via the host HID daemon. */
  navigate(direction: TvDirection): Promise<void>;
  /** Type a string via the HID keyboard. */
  type(text: string): Promise<void>;
  /** Liveness check across both daemons. */
  ping(): Promise<boolean>;
  /**
   * Force a fresh ax daemon even if the current one is still alive. The daemon
   * caches AXRuntime's `primaryApp`, which can keep pointing at a killed app
   * after launch-app / restart-app — so describe returns an empty focus set on
   * a fully-rendered screen. Recycling re-binds to the current foreground app.
   * Programmatic equivalent of `pkill -f tvos-ax-service`.
   */
  recycleAx(): Promise<void>;
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
  const proc = execFile(
    "xcrun",
    ["simctl", "spawn", udid, tvosAxServiceBinaryPath(), "--socket", socketPath, "--timeout", "3600"],
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
async function waitForSocket(socketPath: string, proc: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let exited: number | null | undefined;
  proc.once("exit", (code) => (exited = code));
  while (Date.now() < deadline) {
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
    if (match.runtimeKind !== "tv") {
      throw new Error(
        `${TV_CONTROL_NAMESPACE} is tvOS-only. '${match.name}' (${match.runtime}) is not a tvOS simulator — use the iOS tools for it.`
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
    const onAxExit = (code: number | null) => {
      if (disposed) return;
      axExited = true;
    };
    axProc.on("exit", onAxExit);

    const onProcExit = (which: string) => (code: number | null) => {
      if (disposed) return;
      // HID daemon exit is fatal for the service — no reconnect path there.
      const err = new Error(`tvOS ${which} daemon exited with code ${code}`);
      events.emit("terminated", err);
    };
    hidProc.on("exit", onProcExit("hid-daemon"));

    try {
      await Promise.all([
        waitForSocket(axSock, axProc, 15_000),
        waitForSocket(hidSock, hidProc, 15_000),
      ]);
    } catch (err) {
      if (!axProc.killed) axProc.kill("SIGTERM");
      if (!hidProc.killed) hidProc.kill("SIGTERM");
      throw err;
    }

    // Kill any current ax daemon, clear its socket, spawn a fresh one and wait
    // until it accepts connections. Serialized via `axRespawn` so concurrent
    // ax commands can't race a half-spawned daemon or double-spawn.
    let axRespawn: Promise<void> | null = null;
    async function spawnFreshAx(): Promise<void> {
      if (axProc && !axProc.killed) {
        axProc.removeListener("exit", onAxExit);
        axProc.kill("SIGKILL");
      }
      axExited = false;
      try { fs.unlinkSync(axSock); } catch {}
      axProc = spawnAxDaemon(udid, axSock);
      axProc.on("exit", onAxExit);
      await waitForSocket(axSock, axProc, 15_000);
    }

    // Respawn only if the daemon process actually exited (rare — it normally
    // outlives the app). Stale-cache recovery goes through `recycleAx` instead.
    async function ensureAxAlive(): Promise<void> {
      if (!axExited || disposed) return;
      if (!axRespawn) axRespawn = spawnFreshAx().finally(() => { axRespawn = null; });
      await axRespawn;
    }

    // Force a fresh daemon regardless of liveness — drops a stale primaryApp
    // cache. Coalesces concurrent callers onto a single respawn.
    async function recycleAx(): Promise<void> {
      if (disposed) return;
      if (!axRespawn) axRespawn = spawnFreshAx().finally(() => { axRespawn = null; });
      await axRespawn;
    }

    const api: TvControlApi = {
      async describe(): Promise<TvDescribeResponse> {
        await ensureAxAlive();
        const r = (await sendJson(axSock, "describe", 10_000)) as Partial<TvDescribeResponse>;
        return {
          bundleId: r.bundleId,
          focused: r.focused ?? null,
          focusable: r.focusable ?? [],
          screenFrame: r.screenFrame,
        };
      },

      async hierarchy(): Promise<unknown> {
        await ensureAxAlive();
        return sendJson(axSock, "hierarchy", 15_000);
      },

      async setFocus(label: string): Promise<{ ok: boolean; message: string }> {
        await ensureAxAlive();
        const r = (await sendJson(axSock, `setfocus ${label}`)) as {
          ok?: boolean;
          message?: string;
        };
        if (r.ok) return { ok: true, message: r.message ?? "Focus set successfully" };
        // The native setNativeFocus returns NO when the element is already focused
        // (the focus engine refuses a no-op move). Treat that as success so callers
        // don't need to handle "already focused" as a special case.
        const state = await api.describe();
        const focused = state.focused;
        const normalise = (s: string) => s.toLowerCase().trim();
        const labelNorm = normalise(label);
        const focusedLabel = focused?.label ? normalise(focused.label.split("\n")[0] ?? "") : null;
        if (focusedLabel === labelNorm) {
          return { ok: true, message: "Already focused" };
        }
        return { ok: false, message: r.message ?? "" };
      },

      async navigate(direction: TvDirection): Promise<void> {
        await sendJson(hidSock, `navigate ${direction}`);
      },

      async type(text: string): Promise<void> {
        await sendJson(hidSock, `type ${text}`);
      },

      async ping(): Promise<boolean> {
        try {
          const [ax, hid] = await Promise.all([
            sendJson(axSock, "ping", 3000) as Promise<{ status?: string }>,
            sendJson(hidSock, "ping", 3000) as Promise<{ ok?: boolean }>,
          ]);
          return ax.status === "ok" && hid.ok === true;
        } catch {
          return false;
        }
      },

      async recycleAx(): Promise<void> {
        await recycleAx();
      },
    };

    const instance: ServiceInstance<TvControlApi> = {
      api,
      dispose: async () => {
        disposed = true;
        if (!axProc.killed) axProc.kill("SIGTERM"); // axProc may be a respawned instance
        if (!hidProc.killed) hidProc.kill("SIGTERM");
        for (const p of [axSock, hidSock]) {
          try {
            fs.unlinkSync(p);
          } catch {}
        }
      },
      events,
    };

    return instance;
  },
};
