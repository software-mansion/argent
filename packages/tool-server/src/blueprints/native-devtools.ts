import * as net from "node:net";
import * as fs from "node:fs";
import * as readline from "node:readline";
import {
  TypedEventEmitter,
  FAILURE_CODES,
  FailureError,
  type DeviceInfo,
  type ServiceBlueprint,
  type ServiceEvents,
} from "@argent/registry";
import {
  pickIosHost,
  buildDyldInsertLibraries,
  processCarriesInjection,
  type IosEndpoint,
} from "../utils/ios-host";

// Re-exported for the env-merging unit test that imports it from this module.
export { buildDyldInsertLibraries };

export type NativeDevtoolsTransport = "unix" | "tcp";

export const NATIVE_DEVTOOLS_NAMESPACE = "NativeDevtools";

/**
 * Whether the Argent native devtools dylib can ever be injected into an app.
 *
 * Apple system / built-in apps (bundle ids under `com.apple.`) are platform
 * binaries shipped with library validation enabled, so the simulator may refuse
 * to honour `DYLD_INSERT_LIBRARIES` for them — and no amount of relaunching
 * changes which way it goes. It is runtime-dependent: #453 recorded
 * `connected: false` for `com.apple.Preferences` on iOS 26.5, an E2E run
 * `connected: true` (both dylibs mapped) on 18.5. The predicate answers "not
 * injectable" for both, because an app that MIGHT connect is no basis for a
 * retry loop either. Third-party apps the user installs carry
 * no such restriction and inject normally. Treating the `com.apple.` prefix as
 * non-injectable gives the native-* tools a terminal signal instead of an
 * unbounded restart-app → retry loop.
 *
 * The prefix is matched case-insensitively: iOS treats bundle ids
 * case-insensitively for launch and uniqueness, and Apple reserves the
 * `com.apple` namespace in every casing, so any casing of `com.apple.` is a
 * system app. Apple's real ids always carry the prefix in lowercase (the
 * segments after it vary in case — e.g. `com.apple.Preferences`), but a stray
 * re-cased prefix must not slip through as injectable and restart-loop.
 */
export function isInjectableBundleId(bundleId: string): boolean {
  return !bundleId.toLowerCase().startsWith("com.apple.");
}

/**
 * The invariant half of the non-injectable recovery guidance: which tools NOT
 * to fall back to. Shared VERBATIM by every surface that reports this terminal
 * state (this precheck's throw, the `describe` iOS fallback hint, and the
 * `native-devtools-status` description) so none of them can drift into
 * recommending a dead-end. The flow tree source reports the same terminal state
 * without this text: its reader is authoring a flow, not choosing an inspection
 * tool, so it names the flow-level remedy (drive by coordinate) instead.
 *
 * Every native-* *feature* tool — notably the two
 * view-at-point tools, which run this same 3-arg precheck — re-throws this
 * identical error, so pointing an agent at any of them just loops it back here.
 * (`native-devtools-status` is the lone exception: it runs the 2-arg precheck
 * and *reports* `injectable: false` rather than throwing — see the precheck.)
 */
export const NON_INJECTABLE_NATIVE_WARNING =
  "Do not fall back to the native-devtools feature tools (native-describe-screen, " +
  "native-find-views, native-full-hierarchy, native-network-logs, native-view-at-point, " +
  "native-user-interactable-view-at-point) — they run the same injection precheck and fail " +
  "with the same non-injectable error.";

/**
 * Full recovery guidance for surfaces reached BEFORE `describe` has been tried
 * (the precheck throw from a native-* tool, and the `native-devtools-status`
 * description). `describe` reads these apps via the ax-service without injection
 * and `screenshot` is always available, so both are safe next steps here.
 *
 * The `native-devtools-status` description INLINES this text rather than
 * interpolating the constant: tool descriptions must be plain literals so
 * scripts/extract-tools.mjs can read them statically for the spidershield scan.
 * The verbatim match is pinned by native-devtools-status.test.ts — edit both
 * together.
 *
 * The `describe` iOS fallback hint (`NON_INJECTABLE_HINT`) deliberately does NOT
 * reuse this string: it is reached only after `describe`'s own ax-service path
 * already returned empty, so re-recommending `describe` there would be circular.
 * That hint leads with `screenshot` and appends
 * {@link NON_INJECTABLE_NATIVE_WARNING}, so the dead-end warning is identical
 * across all three surfaces. (The one runtime exception is that `describeIos`
 * substitutes the sim's re-boot hint for `NON_INJECTABLE_HINT` when the
 * ax-service is degraded — see that call site.)
 */
export const NON_INJECTABLE_RECOVERY =
  "Use the standard `describe` tool (its accessibility path reads the screen without injection) " +
  "or `screenshot` (then interact by coordinate). " +
  NON_INJECTABLE_NATIVE_WARNING;

// Max consecutive init failures per service instance before it stops retrying.
export const MAX_NATIVE_DEVTOOLS_INIT_ATTEMPTS = 3;

/**
 * Why an app has no live devtools connection — and so what, if anything,
 * restarting it would change.
 *
 * `restart-app` relaunches into the simulator's *current* launchd environment,
 * so it only helps a process launched under terms a fresh launch would not
 * repeat: no bootstrap dylib, a stale endpoint, or a listener since rebound —
 * `stale_process`. The last of those is injected against this very endpoint, so
 * the state's message speaks of what the process can reach, not what was
 * inserted into it.
 *
 * `unregistered` is the opposite, and the reason this is measured rather than
 * assumed: the process already carries this service's injection and started
 * after the listener came up, so the launch a restart would perform has already
 * happened and left us unconnected. Advising a restart there is the unbounded
 * restart-app loop. A tool-server restart is the remedy that can fix it, but it
 * is not a way out on its own — it rebinds the listener, which re-reads the same
 * never-dialing process as `stale_process`, from where the states cycle back
 * here. Only the second-landing escape in that state's message terminates.
 *
 * `connecting` is that same process within {@link
 * NATIVE_DEVTOOLS_CONNECT_BUDGET_MS} of exec, so its silence is not yet
 * evidence. Kept apart from `indeterminate` because exec is what starts the
 * dial: a relaunch resets the age this verdict reads, so obeying "restart"
 * never terminates.
 *
 * `indeterminate` is the absence of a reading — the process could not be
 * inspected at all (ios-remote, an unreadable `ps`).
 */
export type NativeDevtoolsAppState =
  | "connected"
  | "not_running"
  | "stale_process"
  | "unregistered"
  | "connecting"
  | "indeterminate";

/**
 * How much younger than the listener a process must be to have plainly started
 * after it. Covers the whole-second resolution of `ps -o etime` plus the
 * round-trips between the two clock readings the comparison subtracts. Leans
 * towards `stale_process`, so an uncertain read costs a wasted relaunch rather
 * than sending an agent off to restart a healthy tool-server.
 */
const NATIVE_DEVTOOLS_AGE_SLOP_MS = 3000;

/**
 * How long a process may have been alive before its silence counts as evidence
 * it will never register — the dylib's dial and handshake after exec.
 *
 * This is the same quantity the flow launch gate waits out, and the two must
 * agree: below it the verdict is `connecting`, whose remedy is to wait; at it
 * the verdict is `unregistered`, whose remedy is a tool-server restart that
 * drops every service on every device. A budget shorter than the gate's hands
 * that remedy to an app the gate would still be patiently waiting for — and a
 * cold start (an RN build fetching its bundle) can outlast even this one, which
 * is why `unregistered` carries a second-landing escape rather than a bare
 * instruction.
 */
export const NATIVE_DEVTOOLS_CONNECT_BUDGET_MS = 8000;

/**
 * The agent-facing remedy for each measured state. `connected` is excluded at
 * the type level so a future state that slips in unhandled is a compile error
 * rather than a silent fall-through to the least specific advice.
 */
export function buildAppStateMessage(
  bundleId: string,
  state: Exclude<NativeDevtoolsAppState, "connected">
): string {
  switch (state) {
    case "not_running":
      // The evidence is a missing `UIKitApplication:<id>` row, which an
      // uninstalled bundle id lacks too — so the message names that second
      // reading, leaving the agent somewhere to go when the launch it prescribes
      // fails outright instead of a state whose only advice was just refused.
      // Telling the two apart would take a `simctl get_app_container`
      // round-trip that ios-remote cannot serve at all.
      return (
        `${bundleId} has no running process on this simulator, so there is no injected process to ` +
        `read. Call launch-app (or restart-app) then retry. If that launch fails rather than ` +
        `starting the app, the bundle id is not installed on this device — this state cannot tell ` +
        `the two apart; install it and no relaunch will be needed.`
      );
    case "stale_process":
      return (
        `The running ${bundleId} process cannot reach this simulator's native-devtools endpoint — ` +
        `it was launched either before argent's instrumentation was in place or against an earlier ` +
        `tool-server's listener. A fresh process picks up the current one: call restart-app then retry.`
      );
    case "unregistered":
      // The escape is what stops the remedies closing into a ring. A tool-server
      // restart rebinds the listener, so the same never-dialing process reads
      // `stale_process` next (it now predates the listener), whose remedy is a
      // relaunch, which makes it `connecting`, which becomes this state again —
      // each verdict correct, the cycle unbounded. Nothing distinguishes the
      // first landing from the second, so the message has to hand the reader the
      // test, exactly as `not_running` and `indeterminate` do.
      return (
        `${bundleId} is running with argent's native devtools injected and pointed at this ` +
        `simulator's devtools endpoint, but the service never registered its connection. ` +
        `Restarting the app cannot change that — it already launched under exactly the terms a ` +
        `restart would recreate. Restart the tool-server ` +
        `(\`argent server stop && argent server start --detach\`) and retry. If you have already ` +
        `restarted the tool-server for this app and it reads this way again, stop: the process is ` +
        `loading argent's dylib but never dialing, which no further restart on either side fixes. ` +
        `Treat native devtools as unavailable — read the screen with describe or screenshot and ` +
        `drive it by coordinate.`
      );
    case "connecting":
      return (
        `${bundleId} is running with argent's native devtools injected and pointed at this ` +
        `simulator's devtools endpoint, and it launched moments ago — its connection has not ` +
        `finished being established. Wait a few seconds and retry the same call. Do NOT restart ` +
        `the app: launching it is what starts the connection, so a relaunch discards the one in ` +
        `progress and returns you to this same state.`
      );
    case "indeterminate":
      return (
        `Native devtools are not connected to ${bundleId}, and its process could not be inspected ` +
        `to tell whether it is injected. Call restart-app then retry. If it is still not connected ` +
        `after that restart, the native-devtools service is stale rather than the app being ` +
        `uninjected — do not keep restarting the app; restart the tool-server ` +
        `(\`argent server stop && argent server start --detach\`) and retry.`
      );
  }
}

export interface NativeDevtoolsInitFailure {
  attempts: number;
  lastError: string;
  givenUp: boolean;
}

export interface NativeDevtoolsInitFailedResult {
  status: "init_failed";
  message: string;
  attempts: number;
}

export function buildInitFailedResult(
  udid: string,
  failure: NativeDevtoolsInitFailure
): NativeDevtoolsInitFailedResult {
  return {
    status: "init_failed",
    message:
      `Native devtools failed to initialize for ${udid} after ${failure.attempts} attempts. ` +
      `Last error: ${failure.lastError}. ` +
      `Try shutting down and re-booting the simulator, or restart CoreSimulatorService.`,
    attempts: failure.attempts,
  };
}

// Overloads for proper return-type inference.
export type NativeDevtoolsPrecheckBlock =
  | NativeDevtoolsInitFailedResult
  | { status: "restart_required"; message: string }
  | { status: "service_stale"; message: string }
  | { status: "connect_pending"; message: string };

export async function precheckNativeDevtools(
  api: NativeDevtoolsApi,
  udid: string
): Promise<NativeDevtoolsInitFailedResult | null>;
export async function precheckNativeDevtools(
  api: NativeDevtoolsApi,
  udid: string,
  bundleId: string
): Promise<NativeDevtoolsPrecheckBlock | null>;
export async function precheckNativeDevtools(
  api: NativeDevtoolsApi,
  udid: string,
  bundleId?: string
): Promise<NativeDevtoolsPrecheckBlock | null> {
  // Terminal case first: an Apple system app, which injection cannot be relied
  // on for. Injectability is a static property of the bundle id, knowable
  // without any env state, so this fires before the env plumbing below — a
  // given-up sim or a transient ensureEnvReady failure must not mask the
  // terminal signal behind init_failed's "re-boot the simulator" guidance (a
  // reboot cannot make a system app injectable), and no env-setup work is spent
  // on an app that may never load the dylib. Throwing (rather than returning a
  // restart-required block) makes the native-* feature tools surface a hard
  // error instead of an unbounded restart→retry loop that can never succeed. The
  // 2-arg overload (bundleId undefined) must NOT throw: native-devtools-status
  // reports the state instead, and launch-app / restart-app run it too —
  // launching or restarting a system app is legitimate, it just may not inject.
  if (bundleId !== undefined && !isInjectableBundleId(bundleId)) {
    throw new FailureError(
      `${bundleId} is an Apple system app: it is a platform binary with library validation, so Argent native devtools cannot be relied on to inject into it — treat it as unavailable rather than retrying. ` +
        NON_INJECTABLE_RECOVERY,
      {
        error_code: FAILURE_CODES.NATIVE_DEVTOOLS_NOT_INJECTABLE,
        failure_stage: "native_devtools_precheck",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }

  const existing = api.getInitFailure();
  if (existing?.givenUp) return buildInitFailedResult(udid, existing);

  try {
    await api.ensureEnvReady();
  } catch {
    const failure = api.getInitFailure();
    if (failure) return buildInitFailedResult(udid, failure);
    return buildInitFailedResult(udid, {
      attempts: 1,
      lastError: "ensureEnvReady threw without recording state",
      givenUp: false,
    });
  }

  if (bundleId === undefined) return null;

  // `appConnectionState` re-applies the launchd env before it can answer, so a
  // sim that goes away after `ensureEnvReady` rejects here — on the path all six
  // native-* feature tools take. Degrade like every other consumer rather than
  // letting a raw `Invalid device: <udid>` out: a failure recorded by that
  // re-apply means the sim itself is gone (init_failed's case), anything else
  // leaves the connection simply unmeasured.
  const state = await api.appConnectionState(bundleId).catch(() => {
    const failure = api.getInitFailure();
    return failure ? buildInitFailedResult(udid, failure) : ("indeterminate" as const);
  });
  if (typeof state !== "string") return state;
  if (state === "connected") return null;
  return {
    // Neither `unregistered` (a relaunch provably cannot fix it) nor
    // `connecting` (a relaunch aborts the handshake and resets the age the
    // verdict reads) may be reported as restart_required — obeying that would
    // return here forever.
    status:
      state === "unregistered"
        ? "service_stale"
        : state === "connecting"
          ? "connect_pending"
          : "restart_required",
    message: buildAppStateMessage(bundleId, state),
  };
}

type NativeDevtoolsFactoryOptions = Record<string, unknown> & {
  device: DeviceInfo;
  transport?: NativeDevtoolsTransport;
};

export function nativeDevtoolsRef(
  device: DeviceInfo,
  { transport = "unix" }: { transport?: NativeDevtoolsTransport } = {}
): {
  urn: string;
  options: NativeDevtoolsFactoryOptions;
} {
  const transportSuffix = transport === "tcp" ? ":tcp" : "";
  return {
    urn: `${NATIVE_DEVTOOLS_NAMESPACE}:${device.id}${transportSuffix}`,
    options: { device, transport },
  };
}

export interface NetworkEvent {
  method: string;
  params: unknown;
  timestamp: number;
}

export type ViewInspectorMethod =
  | "ViewHierarchy.getFullHierarchy"
  | "ViewHierarchy.findViews"
  | "ViewHierarchy.viewAtPoint"
  | "ViewHierarchy.userInteractableViewAtPoint"
  | "ViewHierarchy.describeScreen";

type InspectorMethod = ViewInspectorMethod | "Application.getState";

export type NativeApplicationState = "active" | "inactive" | "background" | "unknown";

export interface NativeAppState {
  bundleId: string;
  applicationState: NativeApplicationState;
  foregroundActiveSceneCount: number;
  foregroundInactiveSceneCount: number;
  backgroundSceneCount: number;
  unattachedSceneCount: number;
  isFrontmostCandidate: boolean;
}

export interface NativeDevtoolsApi {
  // Simulator-level
  isEnvSetup(): boolean;
  readonly socketPath: string;
  ensureEnvReady(): Promise<void>;
  /**
   * Force a fresh `ensureEnv` pass, bypassing the one-shot `ensureEnvReady`
   * latch. `ensureEnvReady` caches success and never runs again, so it cannot
   * notice that an out-of-band simulator reboot wiped `DYLD_INSERT_LIBRARIES`
   * from launchd. Callers that have evidence the env may be stale (e.g. a
   * running app that isn't connected) use this to re-apply it. `ensureEnv` is
   * idempotent, so this is a cheap no-op when the env is already correct.
   */
  reverifyEnv(): Promise<void>;
  getInitFailure(): NativeDevtoolsInitFailure | null;

  // App-level — all keyed by bundleId
  isConnected(bundleId: string): boolean;
  isAppRunning(bundleId: string): Promise<boolean>;
  listConnectedBundleIds(): string[];
  /**
   * Why this app has no live devtools connection, and so what would fix it —
   * see {@link NativeDevtoolsAppState}. When not connected it first re-verifies
   * and re-sets the launchd env, which handles the simulator-reboot case where
   * DYLD_INSERT_LIBRARIES was silently cleared.
   */
  appConnectionState(bundleId: string): Promise<NativeDevtoolsAppState>;
  /**
   * Activates NSURLProtocol network interception for a specific app.
   * Idempotent — safe to call multiple times. Sticky: if the app is killed
   * and relaunched, network inspection is automatically re-enabled on reconnect.
   */
  activateNetworkInspection(bundleId: string): void;
  getNetworkLog(bundleId: string): NetworkEvent[];
  clearNetworkLog(bundleId: string): void;
  getAppState(bundleId: string): Promise<NativeAppState>;
  detectFrontmostBundleId(): Promise<string | null>;
  queryViewHierarchy(
    bundleId: string,
    method: ViewInspectorMethod,
    params?: Record<string, unknown>
  ): Promise<unknown>;
}

interface AppConnection {
  socket: net.Socket;
  networkLog: NetworkEvent[];
}

function getNativeDevtoolsSocketPath(udid: string): string {
  // Deterministic, short — well under the 104-char macOS Unix socket limit
  // /tmp/argent-nd-XXXXXXXX.sock = 28 chars
  return `/tmp/argent-nd-${udid.slice(0, 8)}.sock`;
}

/**
 * Bind the per-UDID unix socket with the same guarded, self-healing treatment
 * the TCP branch gets. Exported for testing.
 *
 * Without an "error" listener a bind failure — EADDRINUSE from a live/concurrent
 * per-UDID server, or EEXIST from a socket a concurrent server re-created in the
 * window after the caller's pre-unlink — fires an unhandled "error" event, which
 * Node throws as an uncaught exception and crashes the whole tool-server at
 * startup. That is the dominant crash source in 0.16.0 telemetry (native-devtools
 * socket bind, EADDRINUSE/EEXIST across ~14 users). Here that becomes a rejected
 * promise carrying a coded FailureError, so the factory's retry + failure-
 * telemetry path handles it and only this one service fails.
 *
 * On EADDRINUSE/EEXIST the stale entry is cleared and the bind retried once — a
 * self-heal for the unlink→listen race with a concurrent same-UDID server.
 */
export function bindNativeDevtoolsUnixSocket(
  server: net.Server,
  socketPath: string
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let retried = false;
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    const onError = (err: NodeJS.ErrnoException) => {
      if ((err.code === "EADDRINUSE" || err.code === "EEXIST") && !retried) {
        retried = true;
        try {
          fs.unlinkSync(socketPath);
        } catch {
          /* nothing to remove */
        }
        server.listen(socketPath);
        return;
      }
      server.off("listening", onListening);
      server.off("error", onError);
      server.close();
      reject(
        new FailureError(
          `native-devtools failed to bind unix socket ${socketPath}: ${err.code ?? err.message}`,
          {
            error_code: FAILURE_CODES.NATIVE_DEVTOOLS_SOCKET_BIND_FAILED,
            failure_stage: "native_devtools_socket_bind",
            failure_area: "tool_server",
            error_kind: "network",
          }
        )
      );
    };
    server.on("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

export const nativeDevtoolsBlueprint: ServiceBlueprint<NativeDevtoolsApi, DeviceInfo> = {
  namespace: NATIVE_DEVTOOLS_NAMESPACE,

  getURN(device: DeviceInfo) {
    return `${NATIVE_DEVTOOLS_NAMESPACE}:${device.id}`;
  },

  async factory(_deps, _payload, options) {
    const opts = options as unknown as NativeDevtoolsFactoryOptions | undefined;
    if (!opts?.device) {
      throw new FailureError(
        `${NATIVE_DEVTOOLS_NAMESPACE}.factory requires a resolved DeviceInfo via options.device. ` +
          `Use nativeDevtoolsRef(device) when registering the service ref, or pass { device } when calling resolveService directly.`,
        {
          error_code: FAILURE_CODES.NATIVE_DEVTOOLS_FACTORY_OPTIONS_MISSING,
          failure_stage: "native_devtools_factory_options",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }

    const { device } = opts;
    if (device.platform !== "ios" && device.platform !== "ios-remote") {
      throw new FailureError(
        `${NATIVE_DEVTOOLS_NAMESPACE} is iOS-only. The target '${device.id}' classifies as ${device.platform} — native-devtools tools (native-describe-screen, native-find-views, etc.) only drive iOS simulators. Pick an iOS udid from list-devices.`,
        {
          error_code: FAILURE_CODES.NATIVE_DEVTOOLS_WRONG_PLATFORM,
          failure_stage: "native_devtools_factory_options",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }
    const host = pickIosHost(device);
    // Remote sims can't use unix sockets because the QUIC reverse tunnel
    // only bridges TCP streams.
    const transport: NativeDevtoolsTransport = host.requiresTcp
      ? "tcp"
      : (opts.transport ?? "unix");

    const udid = device.id;
    const socketPath = getNativeDevtoolsSocketPath(udid);
    // For TCP, `port` starts undefined (ephemeral) and is populated by the
    // listen block below. ensureEnvReady and the dispose path read it after
    // that point.
    const endpoint: IosEndpoint =
      transport === "tcp" ? { transport: "tcp" } : { transport: "unix", socketPath };
    const MAX_LOG_ENTRIES = 1000;
    const connections = new Map<string, AppConnection>();
    const pendingRpc = new Map<
      number,
      { resolve: (v: unknown) => void; reject: (e: Error) => void }
    >();
    let nextRpcId = 1;
    let envSetup = false;
    let initFailure: NativeDevtoolsInitFailure | null = null;
    let inFlight: Promise<void> | null = null;

    const activatedBundleIds = new Set<string>();
    const events = new TypedEventEmitter<ServiceEvents>();

    // Concurrency guard: a single ensureEnv attempt
    // can exceed the watcher's 10s poll interval. Without
    // collapsing overlapping callers onto one in-flight promise, each poll
    // would spawn its own attempt and inflate `attempts`.
    const noteInitFailure = (err: unknown): void => {
      const lastError = err instanceof Error ? err.message : String(err);
      const attempts = (initFailure?.attempts ?? 0) + 1;
      const givenUp = attempts >= MAX_NATIVE_DEVTOOLS_INIT_ATTEMPTS;
      initFailure = { attempts, lastError, givenUp };

      const message = givenUp
        ? `[native-devtools] giving up on ${udid} after ${attempts} attempts: ${lastError}\n`
        : `[native-devtools] init attempt ${attempts}/${MAX_NATIVE_DEVTOOLS_INIT_ATTEMPTS} failed for ${udid}: ${lastError}\n`;
      process.stderr.write(message);
    };

    // Runs `ensureEnv` under the in-flight concurrency guard with no latch
    // check. Overlapping callers collapse onto the same promise.
    const runEnsureEnv = (): Promise<void> => {
      if (inFlight) return inFlight;

      inFlight = Promise.resolve()
        .then(() => host.setupNativeDevtoolsEnv(udid, endpoint))
        .then(() => {
          envSetup = true;
          initFailure = null;
        })
        .catch((err) => {
          noteInitFailure(err);
          throw err;
        })
        .finally(() => {
          inFlight = null;
        });

      return inFlight;
    };

    // Hot path: skip the simctl round-trips once the env has been applied
    // successfully (or we've given up). Most tool calls hit this.
    const ensureEnvReady = (): Promise<void> => {
      if (envSetup || initFailure?.givenUp) return Promise.resolve();
      return runEnsureEnv();
    };

    // Recovery path: re-apply the env even when the latch says it's already
    // set, so a sim reboot that cleared DYLD_INSERT_LIBRARIES is repaired.
    // Still honours the give-up guard so a hard-failed sim doesn't spin.
    const reverifyEnv = (): Promise<void> => {
      if (initFailure?.givenUp) return Promise.resolve();
      return runEnsureEnv();
    };

    const isAppRunning = async (bundleId: string): Promise<boolean> => {
      const runningBundleIds = await host.listRunningBundleIds(udid);
      return runningBundleIds.has(bundleId);
    };

    function sendViewInspectorRpc(
      targetBundleId: string,
      method: InspectorMethod,
      params: Record<string, unknown> = {}
    ): Promise<unknown> {
      const conn = connections.get(targetBundleId);
      if (!conn) {
        return Promise.reject(
          new FailureError("Native devtools not connected for bundleId: " + targetBundleId, {
            error_code: FAILURE_CODES.NATIVE_DEVTOOLS_NOT_CONNECTED,
            failure_stage: "native_devtools_rpc_connection",
            failure_area: "tool_server",
            error_kind: "not_found",
          })
        );
      }
      const id = nextRpcId++;
      return new Promise((resolve, reject) => {
        pendingRpc.set(id, { resolve, reject });
        conn.socket.write(
          JSON.stringify({
            type: "ViewInspector",
            payload: { id, method, params },
          }) + "\n"
        );
        setTimeout(() => {
          if (pendingRpc.has(id)) {
            pendingRpc.delete(id);
            reject(
              new FailureError(`ViewInspector RPC timed out: ${method}`, {
                error_code: FAILURE_CODES.NATIVE_DEVTOOLS_RPC_TIMEOUT,
                failure_stage: "native_devtools_rpc_request",
                failure_area: "tool_server",
                error_kind: "timeout",
              })
            );
          }
        }, 5000);
      });
    }

    // Remove stale socket file from a crashed previous run (unix-only).
    if (transport === "unix") {
      try {
        fs.unlinkSync(socketPath);
      } catch {
        /* no stale socket to remove; ignore */
      }
    }

    // ── Socket server ─────────────────────────────────────────────────────────
    const server = net.createServer((socket) => {
      let bundleId: string | null = null;
      const rl = readline.createInterface({ input: socket });

      rl.on("line", (raw) => {
        let msg: { type: string; payload: any };
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }

        // ── Handshake (must be first message) ──
        if (bundleId === null) {
          if (msg.type !== "Control") return;
          bundleId = msg.payload.bundleId as string;

          // If the same app reconnects (e.g. fast restart), close the old socket
          const existing = connections.get(bundleId);
          if (existing) {
            existing.socket.destroy();
          }

          connections.set(bundleId, { socket, networkLog: [] });

          // Re-activate network inspection if it was previously enabled for this app
          if (activatedBundleIds.has(bundleId)) {
            socket.write(
              JSON.stringify({
                type: "Control",
                payload: { command: "activateNetworkInspection" },
              }) + "\n"
            );
          }
          return;
        }

        // ── CDP Network.* events ──
        if (msg.type === "CDP") {
          const p = msg.payload;
          // Unsolicited events have method but no id
          if (p.method && p.id === undefined) {
            const conn = connections.get(bundleId);
            if (conn) {
              if (conn.networkLog.length >= MAX_LOG_ENTRIES) {
                conn.networkLog.shift();
              }
              conn.networkLog.push({
                method: p.method,
                params: p.params,
                timestamp: Date.now(),
              });
            }
          }
        }

        // ── ViewInspector RPC responses ──
        if (msg.type === "ViewInspector") {
          const p = msg.payload;
          const pending = pendingRpc.get(p.id);
          if (!pending) return;
          pendingRpc.delete(p.id);
          if (p.error) {
            pending.reject(
              new FailureError(p.error.message, {
                error_code: FAILURE_CODES.NATIVE_DEVTOOLS_RPC_ERROR,
                failure_stage: "native_devtools_rpc_response",
                failure_area: "tool_server",
                error_kind: "subprocess",
              })
            );
          } else pending.resolve(p.result);
        }
      });

      socket.on("close", () => {
        rl.close();
        if (bundleId !== null) {
          // Only delete if this socket is still the active one —
          // a fast reconnect may have already replaced it
          if (connections.get(bundleId)?.socket === socket) {
            connections.delete(bundleId);
          }
        }
      });

      socket.on("error", () => {
        // errors are handled via the close event
      });
    });

    if (endpoint.transport === "tcp") {
      // `endpoint.port` is undefined here — bind ephemeral and write the
      // realized port back so each per-device instance gets its own.
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(endpoint.port ?? 0, "127.0.0.1", () => {
          server.off("error", reject);
          const addr = server.address();
          if (addr === null || typeof addr === "string") {
            server.close();
            reject(new Error("native-devtools server failed to bind a TCP port"));
            return;
          }
          endpoint.port = addr.port;
          resolve();
        });
      });
      // Wire the reverse tunnel (no-op on local) before kicking off ensureEnv
      // so the dylib's first dial — which can happen as soon as the env is
      // written — lands on our listener.
      await host.startProxy(udid, endpoint.port!);
    } else {
      await bindNativeDevtoolsUnixSocket(server, socketPath);
    }
    // A process older than this dialed a listener we no longer hold, so it needs
    // relaunching however well-injected it looks. Stamped after the bind, so no
    // dial can land before it.
    const listeningSince = Date.now();

    // Tolerate ensureEnv failure: throwing here would leak `server` — the
    // registry's `_teardown` skips dispose when `node.instance` is never set.
    // The watcher retries on subsequent polls.
    await ensureEnvReady().catch(() => {});

    // ── Public API ────────────────────────────────────────────────────────────
    const api: NativeDevtoolsApi = {
      isEnvSetup: () => envSetup,
      socketPath,
      ensureEnvReady,
      reverifyEnv,
      getInitFailure: () => initFailure,

      isConnected: (bundleId) => connections.has(bundleId),
      isAppRunning,
      listConnectedBundleIds: () => [...connections.keys()],

      async appConnectionState(bundleId) {
        if (connections.has(bundleId)) return "connected";
        // Re-verify and re-set env — handles the case where the simulator was
        // rebooted and launchd cleared DYLD_INSERT_LIBRARIES. Must use
        // reverifyEnv (not ensureEnvReady): the latter latches after the first
        // success and would skip re-applying the wiped env. Order matters: this
        // is several simctl round-trips, and the age comparison below subtracts
        // two clock readings taken either side of it — run after the probe it
        // would spend the whole grace and read a process that predates the
        // listener as one that never registered.
        await reverifyEnv();

        // Logged, like the `ps` probe: a broken probe degrades every app to
        // `indeterminate`, indistinguishable at the tool surface from a
        // genuinely uninspectable one. Never fatal — the diagnosis is advisory.
        const inspection = await host.inspectRunningApp(udid, bundleId).catch((err: unknown) => {
          process.stderr.write(
            `[native-devtools] app inspection failed for ${bundleId}: ${String(err)}\n`
          );
          return null;
        });
        // The entry check was several simctl round-trips ago; a dial landing
        // since would read as `unregistered` and send the agent to restart a
        // tool-server that had just succeeded. Re-read the live map.
        if (connections.has(bundleId)) return "connected";

        if (inspection === null) return "indeterminate";
        if (!inspection.running) return "not_running";
        if (inspection.process === null) return "indeterminate";

        if (!processCarriesInjection(inspection.process.env, endpoint)) return "stale_process";

        // Injected, but against which listener? A process older than this
        // service's socket dialed one that no longer exists (a tool-server
        // restart rebinds the same per-udid path to a new inode); a relaunch
        // re-dials the live one.
        const listenerAgeMs = Date.now() - listeningSince;
        const processAgeMs = inspection.process.ageMs;
        if (processAgeMs + NATIVE_DEVTOOLS_AGE_SLOP_MS >= listenerAgeMs) {
          return "stale_process";
        }
        // Injected against this listener and younger than it. Inside the grace
        // the dial is plausibly still in flight; past it, it had its chance.
        if (processAgeMs < NATIVE_DEVTOOLS_CONNECT_BUDGET_MS) return "connecting";
        return "unregistered";
      },

      activateNetworkInspection(bundleId) {
        activatedBundleIds.add(bundleId);
        const conn = connections.get(bundleId);
        if (conn) {
          conn.socket.write(
            JSON.stringify({
              type: "Control",
              payload: { command: "activateNetworkInspection" },
            }) + "\n"
          );
        }
      },

      getNetworkLog: (bundleId) => [...(connections.get(bundleId)?.networkLog ?? [])],

      clearNetworkLog: (bundleId) => {
        const conn = connections.get(bundleId);
        if (conn) conn.networkLog.length = 0;
      },

      async getAppState(bundleId) {
        const result = (await sendViewInspectorRpc(bundleId, "Application.getState")) as {
          applicationState?: NativeApplicationState;
          foregroundActiveSceneCount?: number;
          foregroundInactiveSceneCount?: number;
          backgroundSceneCount?: number;
          unattachedSceneCount?: number;
          isFrontmostCandidate?: boolean;
        };
        return {
          bundleId,
          applicationState: result.applicationState ?? "unknown",
          foregroundActiveSceneCount: result.foregroundActiveSceneCount ?? 0,
          foregroundInactiveSceneCount: result.foregroundInactiveSceneCount ?? 0,
          backgroundSceneCount: result.backgroundSceneCount ?? 0,
          unattachedSceneCount: result.unattachedSceneCount ?? 0,
          isFrontmostCandidate: result.isFrontmostCandidate ?? false,
        };
      },

      async detectFrontmostBundleId() {
        const bundleIds = [...connections.keys()];
        if (bundleIds.length === 0) return null;

        const states = await Promise.all(
          bundleIds.map(async (bundleId) => {
            try {
              return await api.getAppState(bundleId);
            } catch {
              return null;
            }
          })
        );

        const appStates = states.filter((state): state is NativeAppState => state !== null);
        const strongCandidates = appStates.filter(
          (state) => state.applicationState === "active" || state.foregroundActiveSceneCount > 0
        );
        if (strongCandidates.length === 1) {
          return strongCandidates[0].bundleId;
        }

        const weakCandidates = appStates.filter(
          (state) => state.applicationState === "inactive" || state.foregroundInactiveSceneCount > 0
        );
        if (strongCandidates.length === 0 && weakCandidates.length === 1) {
          return weakCandidates[0].bundleId;
        }

        return null;
      },

      queryViewHierarchy(bundleId, method, params = {}) {
        return sendViewInspectorRpc(bundleId, method, params);
      },
    };

    return {
      api,
      dispose: async () => {
        for (const { socket } of connections.values()) {
          socket.destroy();
        }
        connections.clear();
        activatedBundleIds.clear();
        server.close();
        if (transport === "unix") {
          try {
            fs.unlinkSync(socketPath);
          } catch {
            /* best-effort socket cleanup; ignore errors */
          }
        }
        for (const { reject } of pendingRpc.values()) {
          reject(
            new FailureError("NativeDevtools service disposed", {
              error_code: FAILURE_CODES.NATIVE_DEVTOOLS_SERVICE_DISPOSED,
              failure_stage: "native_devtools_dispose",
              failure_area: "tool_server",
              error_kind: "unknown",
            })
          );
        }
        pendingRpc.clear();
        if (endpoint.transport === "tcp") {
          await host.stopProxy(udid, endpoint.port!);
        }
      },
      events,
    };
  },
};
