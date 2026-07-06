import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  TypedEventEmitter,
  FAILURE_CODES,
  FailureError,
  type DeviceInfo,
  type ServiceBlueprint,
  type ServiceInstance,
  type ServiceEvents,
} from "@argent/registry";
import { isFlagEnabled } from "@argent/configuration-core";
import { deviceAuthHelperPath, argentIconPath } from "@argent/native-devtools-ios";
import {
  CoreDeviceAgent,
  CoreDeviceAgentError,
  materializeAgentScript,
  resolvePmd3Python,
} from "./coredevice-agent";

const execFileAsync = promisify(execFile);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const CORE_DEVICE_NAMESPACE = "CoreDevice";

// Opt-in flag (also gates discovery in list-devices). The privileged tunnel
// start must not be reachable unless the user enabled the experimental feature.
const PHYSICAL_IOS_FLAG = "physical-ios-devices";

/**
 * Throw the standard "enable the flag" error unless physical-iOS support is on.
 * The single gate for every physical-iOS operation — the CoreDevice factory and
 * tunnel start funnel through it, and `launch-app` (which drives a real device
 * via `devicectl` rather than the CoreDevice backend) calls it directly so it
 * can't bypass the opt-in.
 */
export function assertPhysicalIosEnabled(): void {
  if (!isFlagEnabled(PHYSICAL_IOS_FLAG)) {
    throw new FailureError(
      `Physical iOS support is disabled. Enable it with: argent enable ${PHYSICAL_IOS_FLAG}`,
      {
        error_code: FAILURE_CODES.CORE_DEVICE_FLAG_DISABLED,
        failure_stage: "core_device_flag_gate",
        failure_area: "tool_server",
        error_kind: "unsupported",
      }
    );
  }
}

// The registry's `ServiceRef.options` is typed as `Record<string, unknown>`;
// the intersection adds the implicit string index signature an interface lacks.
type CoreDeviceFactoryOptions = Record<string, unknown> & { device: DeviceInfo };

/**
 * Backend for a physical iOS device, driven over Apple's CoreDevice "remote
 * control" services via the `pymobiledevice3` CLI — no app installed on the
 * device. This is a separate blueprint from the simulator-server because real
 * iPhones speak an entirely different transport (the iOS-17+ RemoteXPC tunnel),
 * mirroring how physical Android uses its own `android_device` controller.
 *
 * Requirements (all surfaced as actionable errors): iOS 27+ (Apple gates the
 * touch/"remote control" services to 27.0+), `pymobiledevice3` installed, and a
 * running CoreDevice tunnel (`sudo pymobiledevice3 remote tunneld`, which needs
 * root to create the tunnel interface — every command here then runs unprivileged).
 */
export interface CoreDeviceHomescreen {
  /** SpringBoard `getIconState` — the home-screen app/folder/widget layout. */
  iconState: unknown;
  /** SpringBoard icon-grid geometry (columns/rows/icon size/screen points). */
  metrics: Record<string, number>;
}

export interface CoreDeviceApi {
  /** Capture a PNG to a temp file and return its path. */
  screenshot(): Promise<{ path: string }>;
  /** Tap at normalized (x, y) in 0..1. */
  tap(x: number, y: number): Promise<void>;
  /** Swipe/drag from (fromX, fromY) to (toX, toY), all normalized 0..1. */
  swipe(fromX: number, fromY: number, toX: number, toY: number, durationMs: number): Promise<void>;
  /** Press a hardware button by its pymobiledevice3 name (home/lock/volume-up/volume-down/...). */
  button(name: string): Promise<void>;
  /**
   * The SpringBoard home-screen layout — the only app-free *structured* screen
   * data reachable on a physical iPhone (in-app accessibility is Apple-gated;
   * see describe/platforms/ios). Backs `describe` for the home screen.
   */
  homescreen(): Promise<CoreDeviceHomescreen>;
}

export function coreDeviceRef(device: DeviceInfo): {
  urn: string;
  options: CoreDeviceFactoryOptions;
} {
  return {
    urn: `${CORE_DEVICE_NAMESPACE}:${device.id}`,
    options: { device },
  };
}

interface Rsd {
  address: string;
  port: number;
}

function tunneldPort(): number {
  const raw = process.env.ARGENT_PMD3_TUNNELD_PORT;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : 49151;
}

/** Resolve the pymobiledevice3 executable: env override, common install dirs, then PATH. */
function resolvePmd3(): string {
  const override = process.env.ARGENT_PYMOBILEDEVICE3;
  if (override) return override;
  const candidates = [
    join(homedir(), ".local", "bin", "pymobiledevice3"),
    "/opt/homebrew/bin/pymobiledevice3",
    "/usr/local/bin/pymobiledevice3",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return "pymobiledevice3";
}

/**
 * Fail fast with an install hint when pymobiledevice3 is missing, rather than
 * surfacing a raw `spawn ENOENT` from the first interaction. Runs `version` (a
 * cheap subcommand); a missing binary throws ENOENT, anything else is tolerated.
 */
async function verifyPmd3Available(pmd3: string): Promise<void> {
  try {
    await execFileAsync(pmd3, ["version"], { timeout: 10_000 });
  } catch (err) {
    if ((err as { code?: string })?.code === "ENOENT") {
      throw new FailureError(
        `pymobiledevice3 was not found (tried "${pmd3}"). Physical iOS control needs it — ` +
          `install it (e.g. \`pipx install pymobiledevice3\`) or set ARGENT_PYMOBILEDEVICE3 to its path.`,
        {
          error_code: FAILURE_CODES.CORE_DEVICE_PMD3_NOT_FOUND,
          failure_stage: "core_device_verify_pmd3",
          failure_area: "tool_server",
          error_kind: "dependency_missing",
          failure_command: "pymobiledevice3",
        },
        { cause: err instanceof Error ? err : new Error(String(err)) }
      );
    }
    // Non-ENOENT (odd `version` failure): don't block; a real command will report.
  }
}

/** Resolve pymobiledevice3 to an absolute path — the privileged root shell does
 * not inherit the user's PATH (so `~/.local/bin` is invisible to it). */
async function resolvePmd3Absolute(): Promise<string> {
  const p = resolvePmd3();
  if (p.startsWith("/")) return p;
  try {
    const { stdout } = await execFileAsync("/usr/bin/which", [p], { timeout: 5_000 });
    const abs = stdout.trim();
    if (abs.startsWith("/")) return abs;
  } catch {
    // fall through to the install hint
  }
  throw new FailureError(
    `pymobiledevice3 was not found on PATH. Install it (e.g. \`pipx install pymobiledevice3\`) ` +
      `or set ARGENT_PYMOBILEDEVICE3 to its absolute path.`,
    {
      error_code: FAILURE_CODES.CORE_DEVICE_PMD3_NOT_FOUND,
      failure_stage: "core_device_resolve_pmd3_absolute",
      failure_area: "tool_server",
      error_kind: "dependency_missing",
      failure_command: "pymobiledevice3",
    }
  );
}

/** Single-quote a string for safe use as one /bin/sh word. */
function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Escape a /bin/sh command string for embedding inside an AppleScript double-quoted literal. */
export function appleScriptQuote(cmd: string): string {
  return cmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * The /bin/sh command (run as root) that starts a daemonized tunneld on `port`.
 * HOME is pinned to root's home so pymobiledevice3 finds its RemoteXPC pairing
 * records: the privileged-exec environment (Authorization Services) doesn't
 * inherit a usable HOME, which otherwise leaves tunneld unable to form the
 * device tunnel (it starts but never registers one). sudo set HOME=/var/root
 * implicitly; here we set it explicitly.
 *
 * The log goes under /var/root (root's home, mode 0700) rather than a predictable
 * path in world-writable /tmp: this command runs as root, and a root `>` redirect
 * to a /tmp path a non-root user can pre-symlink is a classic privileged-tmp
 * clobber (CWE-59).
 */
export function tunneldStartCommand(pmd3Abs: string, port: number): string {
  return `HOME=/var/root ${shellSingleQuote(pmd3Abs)} remote tunneld --port ${port} -d > /var/root/argent-coredevice-tunneld.log 2>&1`;
}

/**
 * Start `pymobiledevice3 remote tunneld` as root via the standard macOS
 * authorization dialog (password / Touch ID where the OS offers it) — so users
 * never run sudo by hand. AppleScript's `with administrator privileges` routes
 * through Authorization Services and shows the system modal in the active GUI
 * session; `-d` daemonizes so the privileged shell returns immediately, leaving
 * tunneld running as root for the rest of the session. Throws if the user
 * cancels or no GUI session is available (headless) — callers fall back to the
 * manual `sudo` instructions.
 */
async function startTunneldWithPrivilege(pmd3Abs: string, port: number): Promise<void> {
  const shellCmd = tunneldStartCommand(pmd3Abs, port);
  // Generous timeout: the user has to see and approve the modal.
  const timeout = 120_000;

  // Preferred: the signed host helper, which shows the modal branded as
  // "Argent" with the Argent icon + a clear message via Authorization Services.
  const helper = deviceAuthHelperPath();
  if (helper) {
    const icon = argentIconPath() ?? "";
    const prompt = "Argent needs administrator access to connect to a physical iOS device.";
    try {
      await execFileAsync(helper, [icon, prompt, "/bin/sh", "-c", shellCmd], { timeout });
      return;
    } catch (err) {
      // Exit 3 = the user explicitly cancelled the prompt — respect that and
      // don't pop a second (osascript) prompt. Any other failure (a broken,
      // unsigned, quarantined, or 0-byte helper binary) degrades to the
      // osascript admin prompt below rather than hard-failing.
      if ((err as { code?: unknown }).code === 3) throw err;
    }
  }

  // Fallback when the helper isn't installed (e.g. a dev tree without the signed
  // binary), is unusable, or there's no GUI: the generic osascript admin prompt.
  // Functional but unbranded ("osascript wants to make changes").
  const appleScript = `do shell script "${appleScriptQuote(shellCmd)}" with administrator privileges`;
  await execFileAsync("osascript", ["-e", appleScript], { timeout });
}

// Dedupe concurrent escalation prompts: parallel interactions share one modal.
// Cleared after settle so a later call can retry if the user cancelled.
let tunnelStartInFlight: Promise<void> | null = null;

function tunnelHelp(udid: string, reason: string): string {
  const port = tunneldPort();
  // Echo the custom port in the manual command — otherwise a user who set
  // ARGENT_PMD3_TUNNELD_PORT would start tunneld on pmd3's default (49151) and
  // discovery, which probes the custom port, would never find it.
  const portFlag = port === 49151 ? "" : ` --port ${port}`;
  return (
    `Physical iOS control needs a CoreDevice tunnel for ${udid}, but ${reason} ` +
    `(checked tunneld at 127.0.0.1:${port}). Argent tries to start it automatically via the macOS ` +
    `authorization prompt; if that was declined or no GUI session is available, start it manually ` +
    `and leave it running:\n  sudo pymobiledevice3 remote tunneld${portFlag}\n` +
    `Also ensure the iPhone is on iOS 27+, unlocked, and trusted. ` +
    `(Override the port with ARGENT_PMD3_TUNNELD_PORT.)`
  );
}

/**
 * Look up the device's RSD endpoint from a running `pymobiledevice3 remote
 * tunneld` (its local REST API at 127.0.0.1:<port>). Re-resolved per command so
 * a tunneld restart mid-session is picked up without re-creating the service.
 */
async function resolveTunnel(udid: string): Promise<Rsd> {
  const port = tunneldPort();
  let payload: Record<string, Array<{ "tunnel-address"?: string; "tunnel-port"?: number }>>;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(4000) });
    // Something other than tunneld could be bound to the port; don't parse an
    // error page as a tunnel list.
    if (!res.ok) throw new Error(`tunneld responded HTTP ${res.status}`);
    payload = (await res.json()) as typeof payload;
  } catch (err) {
    throw new FailureError(
      tunnelHelp(udid, "tunneld is not running"),
      {
        error_code: FAILURE_CODES.CORE_DEVICE_TUNNEL_UNREACHABLE,
        failure_stage: "core_device_resolve_tunnel",
        failure_area: "tool_server",
        error_kind: "network",
        failure_command: "pymobiledevice3",
      },
      { cause: err instanceof Error ? err : new Error(String(err)) }
    );
  }
  const entry = payload?.[udid];
  const t = Array.isArray(entry) ? entry[0] : undefined;
  // `!t["tunnel-port"]` (not `== null`) deliberately also rejects 0 — tunneld
  // never assigns port 0 to a real tunnel, so treat it the same as missing,
  // consistent with the tunnel-address check on the left.
  if (!t?.["tunnel-address"] || !t["tunnel-port"]) {
    throw new FailureError(tunnelHelp(udid, "no active tunnel is registered for it"), {
      error_code: FAILURE_CODES.CORE_DEVICE_TUNNEL_NOT_REGISTERED,
      failure_stage: "core_device_resolve_tunnel",
      failure_area: "tool_server",
      error_kind: "not_found",
      failure_command: "pymobiledevice3",
    });
  }
  return { address: String(t["tunnel-address"]), port: Number(t["tunnel-port"]) };
}

/**
 * Whether anything is serving on the tunneld port (any HTTP response counts).
 * Distinguishes "tunneld not running → start it" from "tunneld running but this
 * device's tunnel hasn't formed yet → just wait", so we don't pop a second,
 * pointless root prompt (or fail trying to bind an already-used port).
 */
async function isTunneldReachable(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(4000) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the device's RSD endpoint, auto-starting tunneld via the macOS auth
 * modal when it isn't running — so the user never types sudo. Gated behind the
 * physical-ios-devices flag (the privileged escalation is opt-in). If tunneld is
 * already running but this device's tunnel hasn't registered (e.g. the iPhone is
 * locked), it waits rather than popping a second, pointless prompt.
 */
export async function ensureCoreDeviceTunnel(udid: string): Promise<Rsd> {
  assertPhysicalIosEnabled();
  try {
    return await resolveTunnel(udid);
  } catch (notRunning) {
    if (process.platform !== "darwin") throw notRunning;
    const port = tunneldPort();

    // Only escalate (root prompt) when tunneld isn't running at all. If it IS
    // running, the device just needs to be unlocked/trusted for the handshake —
    // don't re-prompt, just poll.
    const reachable = await isTunneldReachable(port);
    if (!reachable) {
      if (!tunnelStartInFlight) {
        tunnelStartInFlight = (async () => {
          const pmd3Abs = await resolvePmd3Absolute();
          await startTunneldWithPrivilege(pmd3Abs, port);
        })();
      }
      try {
        await tunnelStartInFlight;
      } catch (escalationErr) {
        tunnelStartInFlight = null; // allow a later retry
        throw new FailureError(
          tunnelHelp(udid, "the authorization prompt was cancelled or unavailable"),
          {
            error_code: FAILURE_CODES.CORE_DEVICE_TUNNEL_AUTH_DECLINED,
            failure_stage: "core_device_ensure_tunnel_escalation",
            failure_area: "tool_server",
            error_kind: "subprocess",
            failure_command: "pymobiledevice3",
          },
          {
            cause:
              escalationErr instanceof Error ? escalationErr : new Error(String(escalationErr)),
          }
        );
      }
      tunnelStartInFlight = null;
    }

    // Poll for this device's tunnel to register (handshake needs it unlocked & trusted).
    for (let i = 0; i < 15; i++) {
      await sleep(2_000);
      try {
        return await resolveTunnel(udid);
      } catch {
        // keep polling
      }
    }
    throw new FailureError(
      tunnelHelp(
        udid,
        reachable
          ? "tunneld is running but the device tunnel did not form — is the iPhone unlocked and trusted?"
          : "the tunnel did not come up after starting tunneld"
      ),
      {
        error_code: FAILURE_CODES.CORE_DEVICE_TUNNEL_TIMEOUT,
        failure_stage: "core_device_ensure_tunnel_poll",
        failure_area: "tool_server",
        error_kind: "timeout",
        failure_command: "pymobiledevice3",
      },
      { cause: notRunning instanceof Error ? notRunning : new Error(String(notRunning)) }
    );
  }
}

/**
 * Map a CoreDevice agent failure to a FailureError. The agent flags Apple's
 * host-input gate (CoreDeviceError 9021) explicitly via `gated9021`: on iOS
 * 18-26 the "remote control" services exist but reject touch input, while
 * `screen-capture` and hardware buttons (`hid button`) keep working — so this
 * message is scoped to tap/swipe, hardware-verified on an iPhone 15
 * (iOS 18.7.8 vs 27.0).
 */
export function agentError(label: string, err: unknown): FailureError {
  const cause = err instanceof Error ? err : new Error(String(err));
  if (err instanceof CoreDeviceAgentError && err.gated9021) {
    return new FailureError(
      `CoreDevice ${label} failed: this iPhone is on an iOS below 27; host-driven touch input ` +
        `(tap/swipe) requires iOS 27+. Screenshot and hardware buttons work on earlier iOS ` +
        `versions (Apple CoreDeviceError 9021).`,
      {
        error_code: FAILURE_CODES.CORE_DEVICE_IOS_VERSION_TOO_OLD,
        failure_stage: "core_device_command",
        failure_area: "tool_server",
        error_kind: "unsupported",
        failure_command: "pymobiledevice3",
      },
      { cause }
    );
  }
  return new FailureError(
    `CoreDevice ${label} failed: ${cause.message.slice(0, 240)}`,
    {
      error_code: FAILURE_CODES.CORE_DEVICE_COMMAND_FAILED,
      failure_stage: "core_device_command",
      failure_area: "tool_server",
      error_kind: "subprocess",
      failure_command: "pymobiledevice3",
    },
    { cause }
  );
}

/** Normalized 0..1 → the device's 0..65535 HID coordinate space. */
export function toHid(v: number): number {
  return Math.max(0, Math.min(65535, Math.round(v * 65535)));
}

/**
 * Derive the pmd3 `drag` parameters for a swipe of `durationMs`. A drag must
 * dwell to register, so degenerate inputs are clamped: 0ms is dropped by iOS
 * like a zero-dwell tap, and a negative value would reach pmd3 as a flag-like
 * "-0.100" arg; both floor to 50ms. A pathological value is capped at 60s so it
 * can't pin the device for minutes. The command timeout scales with the drag so
 * a long swipe isn't SIGTERM-killed mid-gesture (pmd3 runs for ~`dur` ms; the
 * +15s buffer covers the interpreter's startup).
 */
export function swipeDragParams(durationMs: number): {
  steps: number;
  seconds: string;
  timeoutMs: number;
} {
  const dur = Math.max(50, Math.min(60_000, Math.round(durationMs)));
  const steps = Math.max(2, Math.min(60, Math.round(dur / 16)));
  return { steps, seconds: (dur / 1000).toFixed(3), timeoutMs: dur + 15_000 };
}

/**
 * Ensure the personalized DeveloperDiskImage is mounted (the CoreDevice services
 * live in it). Idempotent: when already mounted, pymobiledevice3 exits non-zero
 * with "already mounted", which we treat as success. CoreDevice usually mounts
 * it automatically when the device connects, so this is a best-effort fallback —
 * a genuine mount failure surfaces later as an actionable per-command error.
 */
async function ensureMounted(pmd3: string, rsd: Rsd): Promise<void> {
  try {
    await execFileAsync(pmd3, ["mounter", "auto-mount", "--rsd", rsd.address, String(rsd.port)], {
      timeout: 60_000,
    });
  } catch {
    // Best-effort: when the DDI is already mounted pymobiledevice3 exits non-zero
    // with "already mounted"; a genuine mount failure surfaces later as an
    // actionable per-command error. Either way, don't fail service creation here.
  }
}

export const coreDeviceBlueprint: ServiceBlueprint<CoreDeviceApi, DeviceInfo> = {
  namespace: CORE_DEVICE_NAMESPACE,
  getURN(device: DeviceInfo) {
    return `${CORE_DEVICE_NAMESPACE}:${device.id}`;
  },
  async factory(_deps, _payload, options) {
    const opts = options as unknown as CoreDeviceFactoryOptions | undefined;
    const device = opts?.device;
    if (!device?.id) {
      throw new FailureError(
        `${CORE_DEVICE_NAMESPACE}.factory requires a resolved DeviceInfo via options.device. ` +
          `Use coreDeviceRef(device) when registering the service ref.`,
        {
          error_code: FAILURE_CODES.CORE_DEVICE_FACTORY_OPTIONS_MISSING,
          failure_stage: "core_device_factory_options",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }
    if (device.platform !== "ios" || device.kind !== "device") {
      throw new FailureError(
        `${CORE_DEVICE_NAMESPACE} only drives physical iOS devices; got ${device.platform}/${device.kind}.`,
        {
          error_code: FAILURE_CODES.CORE_DEVICE_WRONG_DEVICE,
          failure_stage: "core_device_factory_platform",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }
    // Gate first — before any setup probe — so a flag-disabled user gets the
    // "enable the flag" message rather than an incidental "install pymobiledevice3"
    // (ensureCoreDeviceTunnel re-checks this; the duplicate keeps the message
    // correct regardless of whether pmd3 happens to be installed).
    assertPhysicalIosEnabled();

    const pmd3 = resolvePmd3();
    const udid = device.id;

    // Surface setup problems up front, in the order a user fixes them: install
    // pymobiledevice3, then ensure the tunnel (auto-started via the macOS auth
    // modal if needed — no manual sudo), then mount the DDI.
    await verifyPmd3Available(pmd3);
    const rsd = await ensureCoreDeviceTunnel(udid);
    await ensureMounted(pmd3, rsd);

    // Resolve the interpreter that has pymobiledevice3 importable (the CLI's own
    // venv python) and materialize the agent program, then start ONE long-lived
    // process for this device: it connects the RSD tunnel and opens the HID /
    // screenshot services once, so each interaction is a socket write instead of
    // a fresh ~0.8s Python cold-start (~0.5s of which is just the pmd3 import).
    const python = await resolvePmd3Python(await resolvePmd3Absolute());
    const scriptPath = await materializeAgentScript();
    const agent = new CoreDeviceAgent(python, scriptPath, udid, tunneldPort());
    await agent.start();

    const call = async (
      label: string,
      op: string,
      args: Record<string, unknown> = {},
      timeoutMs = 30_000
    ): Promise<Record<string, unknown>> => {
      try {
        return (await agent.request(op, args, timeoutMs)) as Record<string, unknown>;
      } catch (err) {
        throw agentError(label, err);
      }
    };

    const events = new TypedEventEmitter<ServiceEvents>();

    const api: CoreDeviceApi = {
      async screenshot() {
        const res = await call("screenshot", "screenshot", {}, 30_000);
        const b64 = typeof res.image_b64 === "string" ? res.image_b64 : "";
        const path = join(tmpdir(), `argent-ios-shot-${randomUUID()}.png`);
        await writeFile(path, Buffer.from(b64, "base64"));
        return { path };
      },
      async tap(x, y) {
        // A zero-duration tap is dropped by iOS; the agent emits a short held
        // dwell-drag. We hand it the 0..65535 HID coordinate.
        await call("tap", "tap", { x: toHid(x), y: toHid(y) }, 15_000);
      },
      async swipe(fromX, fromY, toX, toY, durationMs) {
        const { steps, seconds, timeoutMs } = swipeDragParams(durationMs);
        await call(
          "swipe",
          "swipe",
          {
            x1: toHid(fromX),
            y1: toHid(fromY),
            x2: toHid(toX),
            y2: toHid(toY),
            steps,
            duration: Number(seconds),
          },
          timeoutMs
        );
      },
      async button(name) {
        await call("button", "button", { name }, 15_000);
      },
      async homescreen() {
        const res = await call("homescreen", "homescreen", {}, 20_000);
        return {
          iconState: res.icon_state,
          metrics: (res.metrics as Record<string, number>) ?? {},
        };
      },
    };

    const instance: ServiceInstance<CoreDeviceApi> = {
      api,
      // One persistent pymobiledevice3 process per device — tear it down.
      dispose: async () => {
        agent.dispose();
      },
      events,
    };
    return instance;
  },
};
