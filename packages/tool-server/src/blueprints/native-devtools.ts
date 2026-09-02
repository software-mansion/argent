import * as net from "node:net";
import * as fs from "node:fs";
import { attachNdjsonReader, reportDroppedFrameToStderr } from "../utils/ndjson-socket";
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

// Re-exported for native-devtools-env.test.ts, which imports it from here.
export { buildDyldInsertLibraries };

type NativeDevtoolsTransport = "unix" | "tcp";

export const NATIVE_DEVTOOLS_NAMESPACE = "NativeDevtools";

/**
 * Whether an app is a supported target for the Argent native devtools.
 *
 * Apple system apps (bundle ids under `com.apple.`) are not: they are never the
 * app under test, and the ones seen connected are background-launched processes
 * that may never service their main queue, so a read hangs or describes UI
 * nobody is looking at — and whether one connects at all is
 * runtime-dependent anyway (#453 recorded `connected: false` for
 * `com.apple.Preferences` on iOS 26.5, an E2E run `connected: true` on 18.5).
 * Answering "not injectable" for both gives the native-* tools a terminal
 * signal instead of an unbounded restart-app → retry loop; an app that MIGHT
 * connect is no basis for a retry either.
 *
 * Matched case-insensitively: iOS treats bundle ids case-insensitively and
 * Apple reserves the namespace in every casing, so a re-cased prefix must not
 * slip through as injectable and restart-loop.
 */
export function isInjectableBundleId(bundleId: string): boolean {
  return !bundleId.toLowerCase().startsWith("com.apple.");
}

/**
 * Every app-scoped native-devtools feature tool. The dead-end warnings below and
 * {@link NATIVE_DEVTOOLS_BLOCKING_STATUSES} both derive from this one list: a
 * seventh tool named in prose but missing from the map would report every
 * precheck block as a successful read.
 */
const NATIVE_FEATURE_TOOL_IDS = [
  "native-describe-screen",
  "native-find-views",
  "native-full-hierarchy",
  "native-network-logs",
  "native-view-at-point",
  "native-user-interactable-view-at-point",
] as const;

const NATIVE_FEATURE_TOOLS = NATIVE_FEATURE_TOOL_IDS.join(", ");

/**
 * The invariant half of the non-injectable recovery guidance: which tools NOT
 * to fall back to. Shared VERBATIM by the precheck throw, the `describe` iOS
 * fallback hint and the `native-devtools-status` description, so none of them
 * can drift into recommending a dead-end. The flow tree source reports the same
 * terminal state without this text: its reader is authoring a flow, so it names
 * the flow-level remedy (drive by coordinate) instead.
 *
 * Every native-* *feature* tool re-throws this identical error from the same
 * 3-arg precheck, so pointing an agent at another one just loops it back here.
 * `native-devtools-status` is the exception: it runs the 2-arg precheck and
 * *reports* `injectable: false` rather than throwing.
 */
export const NON_INJECTABLE_NATIVE_WARNING =
  `Do not fall back to the native-devtools feature tools (${NATIVE_FEATURE_TOOLS}) — ` +
  "they run the same injection precheck and fail with the same non-injectable error.";

/**
 * The same dead-end warning for the terminal state that is *measured* rather
 * than read off the bundle id ({@link buildInjectionFailedDiagnosis}). The tool
 * list is shared with {@link NON_INJECTABLE_NATIVE_WARNING} so neither can drift,
 * but the tail differs because the outcome does: these tools reach the same
 * measurement through the precheck and report `injection_failed` rather than
 * throwing NATIVE_DEVTOOLS_NOT_INJECTABLE.
 */
export const UNINJECTED_NATIVE_WARNING =
  `Do not fall back to the native-devtools feature tools (${NATIVE_FEATURE_TOOLS}) — ` +
  "they read the same connection state and return the same injection_failed status.";

/**
 * The two readers that work with no injection at all. Shared by
 * {@link NON_INJECTABLE_RECOVERY} and {@link INJECTION_FAILED_RECOVERY}; the
 * trailing space is included so either can append its own dead-end warning.
 */
const INJECTION_FREE_READERS =
  "Use the standard `describe` tool (its accessibility path reads the screen without injection) " +
  "or `screenshot` (then interact by coordinate). ";

/**
 * Recovery guidance for the measured terminal state, for a reader that is
 * choosing an inspection tool and has not yet tried `describe` — the shared
 * precheck's callers and `native-devtools-status`. The `describe` iOS fallback
 * and the flow tree reader pass their own, for the same reasons they already
 * carry their own non-injectable text: `describe` is reached only after its own
 * accessibility path returned empty, so recommending it there is circular, and a
 * flow author needs the flow-level remedy rather than a choice of inspection
 * tool.
 */
export const INJECTION_FAILED_RECOVERY = INJECTION_FREE_READERS + UNINJECTED_NATIVE_WARNING;

/**
 * Full recovery guidance for surfaces reached BEFORE `describe` has been tried
 * (the native-* precheck throw, and the `native-devtools-status` description):
 * `describe` reads these apps via the ax-service without injection, and
 * `screenshot` is always available.
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
 * {@link NON_INJECTABLE_NATIVE_WARNING}.
 */
export const NON_INJECTABLE_RECOVERY = INJECTION_FREE_READERS + NON_INJECTABLE_NATIVE_WARNING;

// Max consecutive init failures per service instance before it stops retrying.
export const MAX_NATIVE_DEVTOOLS_INIT_ATTEMPTS = 3;

/**
 * What a peer may call itself on the devtools socket. A superset of the
 * `/^[A-Za-z_][A-Za-z0-9._-]*$/` that launch-app, restart-app, reinstall-app and
 * settings-permissions validate their `bundleId` param against: an id this
 * refuses never registers, and the injection-failed diagnosis then reads that
 * silence as a dylib dyld never loaded. Digits lead here because a real bundle
 * id may (`9gag.app`), where those four still reject one.
 */
const HANDSHAKE_BUNDLE_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9.\-_]*$/;

/**
 * Why an app has no live devtools connection — and so what, if anything,
 * restarting it would change.
 *
 * `restart-app` relaunches into the simulator's *current* launchd environment,
 * so it only helps a process launched under terms a fresh launch would not
 * repeat: no bootstrap dylib, a stale endpoint, or a listener since rebound —
 * `stale_process`.
 *
 * `unregistered` is the opposite, and the reason this is measured rather than
 * assumed: the process already carries this service's injection and started
 * after the listener came up, so the launch a restart would perform has already
 * happened and left us unconnected. Advising a restart there is the unbounded
 * restart-app loop. A tool-server restart rebinds the listener, which re-reads
 * the same never-dialing process as `stale_process`, from where the states
 * cycle back here — only the second-landing escape in that state's message
 * terminates.
 *
 * `connecting` is that same process within {@link
 * NATIVE_DEVTOOLS_CONNECT_BUDGET_MS} of exec, so its silence is not yet
 * evidence. Kept apart from `indeterminate` because a relaunch resets the age
 * this verdict reads, so obeying "restart" never terminates.
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
 * after it: the whole-second resolution of `ps -o etime` plus the round-trips
 * between the two clock readings the comparison subtracts. Leans towards
 * `stale_process`, so an uncertain read costs a wasted relaunch rather than a
 * pointless tool-server restart.
 */
const NATIVE_DEVTOOLS_AGE_SLOP_MS = 3000;

/**
 * How long a process may have been alive before its silence counts as evidence
 * it will never register — the dylib's dial and handshake after exec.
 *
 * A heavy first-ever cold start on a loaded host delays that handshake well past
 * 8s, so the budget is the 15s the `getFullHierarchy` RPC already allows — this
 * codebase's figure for riding out one such stall, shared with the Android
 * client's long-RPC tier.
 *
 * The flow launch gate waits out the same quantity and the two must agree:
 * below it the verdict is `connecting`, whose remedy is to wait; at it
 * `unregistered`, whose remedy is a tool-server restart that drops every
 * service on every device. A shorter budget hands that remedy to an app the
 * gate would still be waiting for — and a cold start can outlast even this one,
 * which is why `unregistered` carries a second-landing escape.
 */
export const NATIVE_DEVTOOLS_CONNECT_BUDGET_MS = 15_000;

/**
 * The agent-facing remedy for each measured state. `connected` is excluded at
 * the type level so an unhandled future state is a compile error rather than a
 * silent fall-through to the least specific advice.
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
      // fails outright.
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
      // The escape is what stops the remedies closing into a ring: a
      // tool-server restart rebinds the listener, so the same never-dialing
      // process reads `stale_process` next (it now predates the listener), whose
      // remedy is a relaunch, which makes it `connecting`, which becomes this
      // state again. Nothing distinguishes the first landing from the second, so
      // the message has to hand the reader the test.
      return (
        `${bundleId} is running with argent's native devtools injected and pointed at this ` +
        `simulator's devtools endpoint, but the service never registered its connection. ` +
        `Restarting the app cannot change that — it already launched under exactly the terms a ` +
        `restart would recreate. Restart the tool-server ` +
        `(\`argent server stop && argent server start --detach\`) and retry. If you have already ` +
        `restarted the tool-server for this app and it reads this way again, stop: the process carries ` +
        `argent's dylib but never dials, which no further restart on either side fixes. ` +
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

/**
 * Terminal diagnosis for an app whose relaunch has been prescribed, performed,
 * and made no difference.
 *
 * Reached only from `unregistered` after a `stale_process` hand-out for the same
 * bundle, and the pid change in between is what makes the opening claim safe.
 * `ps -o etime` is whole-second, so the stale/unregistered boundary alone cannot
 * separate a relaunch from one process re-read across a second boundary — but a
 * pid is stable for a process's lifetime and changes exactly when it is
 * replaced. The `stale_process` hand-out records the pid it was addressed to,
 * and `unregistered` is only treated as terminal once the inspected pid differs,
 * so the process being measured genuinely is the relaunch's result.
 *
 * `connectedPeers` localises what is left. `DYLD_INSERT_LIBRARIES` is set
 * simulator-wide and this service holds one listener, so any other app connected
 * on it proves the launchd env, the dylib and the listener all work and narrows
 * the fault to this app's binary. No peer at all leaves all three in scope —
 * that is the closest thing to a load confirmation available here, since the
 * process table can show the insertion but never the load.
 *
 * The verdict has exactly one false positive, and the message discloses it
 * rather than claiming it away: an app whose first devtools connection lands
 * past NATIVE_DEVTOOLS_CONNECT_BUDGET_MS reads `unregistered` identically while
 * still warming up (#778 was such a cold start). The prescribed disambiguator
 * is one passive re-probe after a wait — it prescribes no restart, so it cannot
 * reopen the cycle this verdict exists to close.
 *
 * That re-probe is spelled as a test on what the surfaces actually emit. Once
 * the verdict turns terminal the record clears only on a handshake, so a still
 * running, still silent app reads either connected (the verdict is gone,
 * `status` with it) or this same block again — never `unregistered`, which
 * carries a `state` these surfaces stop returning. A repeat is therefore also
 * the second-landing test `unregistered`'s own message has to spell out by
 * hand. A quit app or an unreadable `ps` answer neither, and both fall back to
 * the measured state's own remedy; the record outlives them, so the next
 * readable process restores the verdict.
 */
function buildInjectionFailedDiagnosis(
  bundleId: string,
  connectedPeers: string[],
  connectBudgetMs: number
): string {
  const localisation =
    connectedPeers.length > 0
      ? `Other apps on this simulator are connected (${connectedPeers.join(", ")}), so the launchd environment, the dylib and this service's listener all work — the fault is specific to this app's binary: check that it is a simulator build for this platform and that it does not enforce library validation. `
      : `No app on this simulator is connected to this tool-server, so a dylib dyld never loads and a listener nothing can reach still read the same. If the re-probe repeats this diagnosis, re-boot the simulator (boot-device with force=true) and confirm argent's native binaries are installed. A tool-server restart does not help here either: this service still owns this simulator's devtools socket, so a fresh listener on it would see exactly what this one sees. `;

  return (
    `${bundleId} was told to relaunch, and the process now running is a different one, so the relaunch happened — and it still never connected. ` +
    `It carries argent's bootstrap dylib pointed at this simulator's devtools endpoint and it started after this service's listener bound, so the launchd environment reached it. That proves the dylib was handed to the process, not that dyld loaded it: dyld skips an inserted library silently when its slice does not match the simulator's platform, when it is unsigned, or when one of its dependencies is missing. Relaunching it again reproduces exactly this reading. ` +
    `One reading can mimic this with nothing wrong: a cold start that takes longer than ${Math.round(connectBudgetMs / 1000)} seconds to make its first connection. Before treating this as final, wait about ${Math.round((connectBudgetMs * 2) / 1000)} seconds — twice the budget this verdict already allowed, so a cold start half this speed still clears it — and probe native-devtools-status once more. An app that has connected by then reports connected and this verdict is gone; if it repeats this diagnosis instead, the wait was not the answer. ` +
    localisation
  );
}

/**
 * What `unregistered` means when this service no longer owns the socket the app
 * was told to dial. Both of the terminal verdict's premises fail here: the app
 * may be connected, to a listener this service cannot see, and a tool-server
 * restart is then the fix rather than the futile step the diagnosis calls it.
 */
function buildEndpointLostMessage(bundleId: string, socketPath: string): string {
  return (
    `${bundleId} is running with argent's native devtools injected, but this tool-server no longer ` +
    `owns this simulator's devtools socket: ${socketPath} is not the endpoint this service bound. ` +
    `That path carries no owner and the last binder takes it, so a second argent tool-server on this ` +
    `simulator is the usual cause. A connection the app made to that listener is invisible here, so ` +
    `this reading is not evidence about the app. Restart this tool-server ` +
    `(\`argent server stop && argent server start --detach\`) to take the socket back, then call ` +
    `restart-app once so the app re-dials it. If a second tool-server is running against this ` +
    `simulator on purpose, read the app there instead — stopping one of them is what keeps the ` +
    `socket stable.`
  );
}

/**
 * What to tell an agent about an app that has no live devtools connection: the
 * measured state's own remedy, or the terminal diagnosis once that remedy has
 * been prescribed and demonstrably not converged.
 */
interface NativeDevtoolsUninjectedAdvice {
  /**
   * True when the guidance prescribes no further action on the app or the
   * tool-server. Surfaces with a `status` channel report `injection_failed` for
   * it; the rest carry the message alone, as they already do for every other
   * state.
   */
  terminal: boolean;
  message: string;
}

/**
 * Turn a measured state into the guidance every surface shares, recording the
 * one hand-out that lets a later reading tell a spent remedy from a fresh one.
 * Side-effecting on that record, so `recordAdvice` exists for the reader whose
 * message an agent may never see: `describeIos` doubles as the per-poll tree
 * read behind the wait tools, which discard every hint on a wait that succeeds.
 * A record written for a hint nobody read would let any later process
 * replacement — a crash, a Metro reload, another agent — satisfy a relaunch
 * nobody was asked to perform. Withholding it only ever delays the verdict, so
 * a caller that cannot promise the hint is rendered should not record.
 *
 * Only `stale_process` and `unregistered` take part. Their remedies are the two
 * halves of a cycle: `stale_process` prescribes restart-app, which leaves the
 * app younger than the listener and so reads `unregistered`; `unregistered`
 * prescribes a tool-server restart, whose new listener is younger than the app
 * and so reads `stale_process`. An app whose dylib dyld silently skips satisfies
 * both readings forever, so the second half has to stop being prescribed — and
 * it is the half that must go, because obeying it discards this record along
 * with the service instance holding it.
 *
 * The other three states are left alone because their remedies do converge.
 * `connecting` resolves itself: the process ages out of the grace within seconds
 * and the next reading is a verdict. `not_running` asks for a launch, and an app
 * that will not stay running is a crash rather than a load failure — nothing
 * here has seen its process to diagnose. `indeterminate` is the absence of a
 * reading, so there is no injection to claim anything about, and its message
 * already bounds itself to one restart; on ios-remote it is the only state a
 * running app ever reaches, and stranding that host would leave it no reading at
 * all.
 *
 * `indeterminate` also prescribes a relaunch, and it deliberately does NOT
 * record one: only a pid change between the `stale_process` hand-out and a later
 * `unregistered` reading proves the process was replaced. `indeterminate` says
 * the process could not be read at all, so an `unregistered` after it may be the
 * same process finally becoming readable — and the terminal diagnosis opens by
 * asserting a relaunch took place.
 *
 * `terminalRecovery` is the caller's own dead-end guidance, appended only when
 * the advice turns terminal — see {@link INJECTION_FAILED_RECOVERY} for the
 * inspection-tool wording and why two surfaces need their own.
 */
export function adviseOnUninjectedApp(
  api: NativeDevtoolsApi,
  bundleId: string,
  state: Exclude<NativeDevtoolsAppState, "connected">,
  terminalRecovery: string,
  options: { recordAdvice?: boolean } = {}
): NativeDevtoolsUninjectedAdvice {
  if (state === "stale_process") {
    if (options.recordAdvice ?? true) api.noteRelaunchAdvice(bundleId);
  } else if (state === "unregistered" && api.wasAdvisedToRelaunch(bundleId)) {
    // The diagnosis reasons from "nothing dialed the listener this service
    // holds". If it no longer holds one, that premise is about the socket, not
    // the app — and the tool-server restart the diagnosis forecloses is what
    // takes it back. Non-terminal, so each surface keeps its own non-terminal
    // spelling (`service_stale` from the precheck), whose remedy is that
    // restart.
    if (!api.holdsEndpoint()) {
      return { terminal: false, message: buildEndpointLostMessage(bundleId, api.socketPath) };
    }
    return {
      terminal: true,
      message:
        buildInjectionFailedDiagnosis(
          bundleId,
          api.listConnectedBundleIds(),
          NATIVE_DEVTOOLS_CONNECT_BUDGET_MS
        ) + terminalRecovery,
    };
  }
  return { terminal: false, message: buildAppStateMessage(bundleId, state) };
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

/**
 * The measured terminal state, reported by the surfaces that measure it and
 * have a `status` channel: the six feature tools through the 3-arg precheck,
 * and `native-devtools-status`, which measures it for itself. Carries no
 * `state`: the remedies for the state it was measured in are exactly what this
 * block exists to withhold.
 */
export interface NativeDevtoolsInjectionFailedResult {
  status: "injection_failed";
  message: string;
}

export type NativeDevtoolsPrecheckBlock =
  | NativeDevtoolsInitFailedResult
  | NativeDevtoolsInjectionFailedResult
  | { status: "restart_required"; message: string }
  | { status: "service_stale"; message: string }
  | { status: "connect_pending"; message: string };

/**
 * Which statuses mean a given tool's handler answered a blocked precheck
 * INSTEAD of doing its work — keyed per tool, because the same status is not the
 * same event on every one. The six feature tools run the 3-arg overload, where
 * all five come back before the tool's work begins. `launch-app` and
 * `restart-app` run the 2-arg overload, which blocks on `init_failed` alone.
 * `native-devtools-status` runs it too, and `injection_failed` is its own
 * measured answer, produced after the precheck let it through — reporting the
 * state IS its work, so that status is not a block for it.
 */
const NATIVE_DEVTOOLS_BLOCKING_STATUSES = new Map<
  string,
  ReadonlySet<NativeDevtoolsPrecheckBlock["status"]>
>([
  ...NATIVE_FEATURE_TOOL_IDS.map(
    (id) =>
      [
        id,
        new Set<NativeDevtoolsPrecheckBlock["status"]>([
          "init_failed",
          "injection_failed",
          "restart_required",
          "service_stale",
          "connect_pending",
        ]),
      ] as const
  ),
  ...(["native-devtools-status", "launch-app", "restart-app"] as const).map(
    (id) => [id, new Set<NativeDevtoolsPrecheckBlock["status"]>(["init_failed"])] as const
  ),
]);

/**
 * Flow integration: a blocked precheck is a RESOLVED tool result, so a recorded
 * step that runs one of these tools would otherwise report `pass` for a call
 * that never reached its work. Mirrors `isDebuggerNotConnectedResult` and
 * `isUnmetUiWaitResult`.
 *
 * Keyed on the tool id as well as the shape: the five status strings are
 * unremarkable words, and an unrelated tool that happens to answer
 * `{status: "..."}` must not fail a step it passed. The step's failure reason
 * says the tool "did not run", so a status a tool produces AS its work must not
 * be listed for it.
 */
export function isNativeDevtoolsBlockResult(
  toolId: string,
  result: unknown
): result is NativeDevtoolsPrecheckBlock {
  const blocking = NATIVE_DEVTOOLS_BLOCKING_STATUSES.get(toolId);
  if (blocking === undefined) return false;
  if (typeof result !== "object" || result === null) return false;
  const status = (result as { status?: unknown }).status;
  return (
    typeof status === "string" && blocking.has(status as NativeDevtoolsPrecheckBlock["status"])
  );
}

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
  // Terminal case first: injectability is a static property of the bundle id,
  // knowable without any env state, so this fires before the env plumbing below
  // — a given-up sim or a transient ensureEnvReady failure must not mask the
  // terminal signal behind init_failed's "re-boot the simulator" guidance (a
  // reboot cannot make a system app a supported target), and no env-setup work
  // is spent on an app the gate refuses. Throwing (rather than returning a
  // restart-required block) makes the native-* feature tools surface a hard
  // error instead of an unbounded restart→retry loop. The 2-arg overload
  // (bundleId undefined) must NOT throw: native-devtools-status reports the
  // state instead, and launch-app / restart-app run it too — launching or
  // restarting a system app is legitimate, it just is not a target.
  if (bundleId !== undefined && !isInjectableBundleId(bundleId)) {
    throw new FailureError(
      `${bundleId} is an Apple system app: it is never the app under test, so Argent native devtools refuse to read one — treat it as unavailable rather than retrying. ` +
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
  // sim that goes away after `ensureEnvReady` rejects here. Degrade like every
  // other consumer rather than letting a raw `Invalid device: <udid>` out: a
  // failure recorded by that re-apply means the sim itself is gone
  // (init_failed's case), anything else leaves the connection unmeasured.
  const state = await api.appConnectionState(bundleId).catch(() => {
    const failure = api.getInitFailure();
    return failure ? buildInitFailedResult(udid, failure) : ("indeterminate" as const);
  });
  if (typeof state !== "string") return state;
  if (state === "connected") return null;
  const advice = adviseOnUninjectedApp(api, bundleId, state, INJECTION_FAILED_RECOVERY);
  if (advice.terminal) return { status: "injection_failed", message: advice.message };
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
    message: advice.message,
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
  isEnvSetup(): boolean;
  readonly socketPath: string;
  ensureEnvReady(): Promise<void>;
  /**
   * Force a fresh `ensureEnv` pass, bypassing the one-shot `ensureEnvReady`
   * latch, which caches success and so cannot notice that an out-of-band
   * simulator reboot wiped `DYLD_INSERT_LIBRARIES` from launchd. `ensureEnv` is
   * idempotent, so this is a cheap no-op when the env is already correct.
   */
  reverifyEnv(): Promise<void>;
  getInitFailure(): NativeDevtoolsInitFailure | null;

  isConnected(bundleId: string): boolean;
  isAppRunning(bundleId: string): Promise<boolean>;
  listConnectedBundleIds(): string[];
  /**
   * Whether the endpoint this service bound is still the one an app dialing this
   * simulator reaches. The per-UDID socket path carries no server identity and
   * the last binder owns it, so a second tool-server on the same simulator
   * silently takes every future dial — leaving this service unable to see a
   * connection that exists. Consulted for the one reading that would otherwise
   * turn terminal: false withdraws that verdict, because it would be a
   * statement about the socket rather than about the app.
   */
  holdsEndpoint(): boolean;
  /**
   * Why this app has no live devtools connection, and so what would fix it —
   * see {@link NativeDevtoolsAppState}. When not connected it first re-applies
   * the launchd env, covering the simulator reboot that silently cleared
   * DYLD_INSERT_LIBRARIES.
   */
  appConnectionState(bundleId: string): Promise<NativeDevtoolsAppState>;
  /**
   * Record that `bundleId` has been handed `stale_process`'s relaunch remedy,
   * keyed by the pid of the process it was handed to, so a later reading can
   * tell whether the process it is looking at is the result of that relaunch.
   * Prefer {@link adviseOnUninjectedApp}, which pairs this with the reading that
   * consumes it.
   */
  noteRelaunchAdvice(bundleId: string): void;
  /**
   * Whether a relaunch demonstrably happened since the remedy was prescribed:
   * the pid the remedy was addressed at differs from the pid last inspected.
   * Connecting clears the record: the remedy worked, and the next failure is a
   * fresh problem rather than the continuation of an old one.
   */
  wasAdvisedToRelaunch(bundleId: string): boolean;
  /**
   * Activates NSURLProtocol network interception for a specific app. Idempotent,
   * and sticky: re-enabled automatically when the app reconnects after a
   * relaunch.
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
  // Deterministic and short: 28 chars, well under the 104-char macOS Unix
  // socket limit.
  return `/tmp/argent-nd-${udid.slice(0, 8)}.sock`;
}

/** The inode behind a path, or null if it cannot be read. */
function socketInode(socketPath: string): number | null {
  try {
    return fs.statSync(socketPath).ino;
  } catch {
    return null;
  }
}

/**
 * Bind the per-UDID unix socket with the same guarded, self-healing treatment
 * the TCP branch gets. Exported for testing.
 *
 * Without an "error" listener a bind failure — EADDRINUSE from a live/concurrent
 * per-UDID server, or EEXIST from a socket a concurrent server re-created in the
 * window after the caller's pre-unlink — fires an unhandled "error" event, which
 * Node throws as an uncaught exception and crashes the whole tool-server at
 * startup. Here that becomes a rejected promise carrying a coded FailureError,
 * so the factory's retry + failure-telemetry path handles it and only this one
 * service fails.
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
          /* best-effort */
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
    // Remote sims can't use unix sockets: the sim-remote tunnel only bridges
    // TCP streams.
    const transport: NativeDevtoolsTransport = host.requiresTcp
      ? "tcp"
      : (opts.transport ?? "unix");

    const udid = device.id;
    const socketPath = getNativeDevtoolsSocketPath(udid);
    // For TCP, `port` starts undefined (ephemeral) and is populated by the
    // listen block below, before ensureEnvReady and dispose read it.
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
    // Bundles handed the relaunch remedy with no connection since, keyed by the
    // pid of the process that was handed it. A relaunch is proven by a pid
    // change at the later reading, not by the stale→unregistered flip alone:
    // `ps -o etime` is whole-second, so one unchanged process can read both
    // states as its quantised age crosses the slop band. The record is bounded
    // by the set of apps ever advised on this simulator, and each entry is
    // dropped the moment that app completes its handshake.
    const relaunchAdvised = new Map<string, number | null>();
    // The pid of the process `appConnectionState` last inspected for a bundle —
    // the current process when `adviseOnUninjectedApp` runs right after it.
    const lastSeenPid = new Map<string, number | null>();
    const events = new TypedEventEmitter<ServiceEvents>();

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

    // No latch check. Overlapping callers collapse onto one in-flight promise,
    // so the watcher's 10s poll cannot spawn an attempt per poll and inflate
    // `attempts`.
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
    // successfully (or we've given up).
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
      // A heavy cold start can stall the app for several seconds, and the flow
      // runner re-reads the hierarchy through exactly that window. Give the
      // flows' workhorse read time to ride the stall out instead of failing the
      // step — mirroring the Android devtools client's 5s default / 15s
      // getHierarchy tiers. Everything else (including the per-read
      // Application.getState probe and the interactive point queries) keeps the
      // 5s ceiling so one-shot agent tools stay snappy on a wedged app.
      const timeoutMs = method === "ViewHierarchy.getFullHierarchy" ? 15_000 : 5_000;
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
        }, timeoutMs);
      });
    }

    // Stale socket file from a crashed previous run (unix-only).
    if (transport === "unix") {
      try {
        fs.unlinkSync(socketPath);
      } catch {
        /* best-effort */
      }
    }

    const server = net.createServer((socket) => {
      let bundleId: string | null = null;
      // `destroy()` does not interrupt the frame loop: the reader splits a whole
      // chunk and delivers every line in it, so without this latch a peer whose
      // handshake was refused is admitted on the next line of the same write.
      let refused = false;
      attachNdjsonReader(socket, {
        onDropped: reportDroppedFrameToStderr(`native-devtools ${udid.slice(0, 8)}`),
        onMessage: (parsed) => {
          if (refused) return;
          const msg = parsed as { type: string; payload: any };

          // Handshake: must be the first message.
          if (bundleId === null) {
            if (msg.type !== "Control") return;
            // The socket is local and unauthenticated, but a peer id is not inert:
            // it becomes a map key, can supersede another app's live socket, and —
            // since the injection-failed diagnosis cites connected peers as
            // evidence — is interpolated verbatim into agent-facing prose. Only a
            // plain bundle identifier (letters, digits, dot, hyphen, underscore;
            // no whitespace, separators or control characters) is admitted.
            const requested = msg.payload?.bundleId;
            if (
              typeof requested !== "string" ||
              requested.length === 0 ||
              requested.length > 256 ||
              !HANDSHAKE_BUNDLE_ID_PATTERN.test(requested)
            ) {
              // Audible, because the diagnosis three functions away reads a
              // missing registration as a dylib dyld never loaded. Bounded after
              // stringifying, not before: the id is whatever the peer sent, and
              // only the string branch has a length the guard above caps.
              process.stderr.write(
                `[native-devtools] refused a handshake whose bundle id is not a plain identifier: ${(
                  JSON.stringify(requested) ?? "undefined"
                ).slice(0, 80)}\n`
              );
              refused = true;
              socket.destroy();
              return;
            }
            bundleId = requested;

            // The same app reconnecting (fast restart) supersedes the old socket.
            const existing = connections.get(bundleId);
            if (existing) {
              existing.socket.destroy();
            }

            connections.set(bundleId, { socket, networkLog: [] });
            // The handshake is the success signal for the relaunch remedy, and the
            // only moment it is observable — an app can connect and drop again
            // between two readings, and clearing on a `connected` reading would
            // miss that and hold a verdict against a process that did register.
            relaunchAdvised.delete(bundleId);

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

          // Both branches below dereference the payload, and a frame without one
          // is a TypeError the process-level handler turns into an exit.
          const p = msg.payload;
          if (p === null || typeof p !== "object") return;

          if (msg.type === "CDP") {
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

          if (msg.type === "ViewInspector") {
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
        },
      });

      socket.on("close", () => {
        if (bundleId !== null) {
          // A fast reconnect may have already replaced this socket.
          if (connections.get(bundleId)?.socket === socket) {
            connections.delete(bundleId);
          }
        }
      });

      socket.on("error", () => {
        // handled via the close event
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
      // Wire the reverse tunnel (no-op on local) before ensureEnv, so the
      // dylib's first dial — which can happen as soon as the env is written —
      // lands on our listener.
      await host.startProxy(udid, endpoint.port!);
    } else {
      await bindNativeDevtoolsUnixSocket(server, socketPath);
    }
    // A process older than this dialed a listener we no longer hold, so it needs
    // relaunching however well-injected it looks. Stamped after the bind, so no
    // dial can land before it.
    const listeningSince = Date.now();
    // Identity for the unix socket we just bound. Another tool-server binding
    // the same per-UDID path unlinks it and creates a new one, so an inode that
    // has moved (or gone) is proof the path no longer routes to us. A TCP
    // endpoint is per-instance and cannot be taken over this way.
    const boundSocketIno = transport === "unix" ? socketInode(socketPath) : null;

    // Tolerate ensureEnv failure: throwing here would leak `server` — the
    // registry's `_teardown` skips dispose when `node.instance` is never set.
    // The watcher retries on subsequent polls.
    await ensureEnvReady().catch(() => {});

    const api: NativeDevtoolsApi = {
      isEnvSetup: () => envSetup,
      socketPath,
      ensureEnvReady,
      reverifyEnv,
      getInitFailure: () => initFailure,

      isConnected: (bundleId) => connections.has(bundleId),
      isAppRunning,
      listConnectedBundleIds: () => [...connections.keys()],
      // Unknowable inode at bind time reads as "ours": the check exists to
      // withdraw a verdict, and guessing that it has been taken would withdraw
      // one on every read.
      holdsEndpoint: () =>
        boundSocketIno === null ? true : socketInode(socketPath) === boundSocketIno,

      async appConnectionState(bundleId) {
        if (connections.has(bundleId)) return "connected";
        // Re-apply the env in case a sim reboot cleared DYLD_INSERT_LIBRARIES.
        // Must be reverifyEnv, not ensureEnvReady: the latter latches after the
        // first success and would skip the wiped env. Runs before the probe:
        // it costs several simctl round-trips, and the age comparison below
        // subtracts two clock readings taken either side of the probe, so
        // running it after would read a process that predates the listener as
        // one that never registered.
        await reverifyEnv();

        // Logged, not fatal: a broken probe degrades every app to
        // `indeterminate`, indistinguishable at the tool surface from a
        // genuinely uninspectable one.
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

        // The current process for this bundle, so a later `unregistered` reading
        // can tell a genuinely replaced process from the same one re-read.
        lastSeenPid.set(bundleId, inspection.process.pid);

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
        // Inside the grace the dial is plausibly still in flight; past it, it
        // had its chance.
        if (processAgeMs < NATIVE_DEVTOOLS_CONNECT_BUDGET_MS) return "connecting";
        return "unregistered";
      },

      noteRelaunchAdvice: (bundleId) => {
        // Snapshot the pid the hand-out was addressed at. A later `unregistered`
        // reading is only evidence of a relaunch if the pid has since changed.
        //
        // Only the first hand-out is kept. The entry is retired on a handshake
        // and on dispose, so a surviving one already means "told to relaunch,
        // has not connected since"; re-stamping it at each later reading would
        // move the anchor onto the replacement process and erase the very pid
        // change that proves the relaunch happened. A polling surface — the flow
        // tree reads a few times a second — would otherwise withhold the verdict
        // for as long as it kept reading.
        if (relaunchAdvised.has(bundleId)) return;
        relaunchAdvised.set(bundleId, lastSeenPid.get(bundleId) ?? null);
      },
      wasAdvisedToRelaunch: (bundleId) => {
        if (!relaunchAdvised.has(bundleId)) return false;
        return relaunchAdvised.get(bundleId) !== (lastSeenPid.get(bundleId) ?? null);
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
        relaunchAdvised.clear();
        lastSeenPid.clear();
        server.close();
        if (transport === "unix") {
          try {
            fs.unlinkSync(socketPath);
          } catch {
            /* best-effort */
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
