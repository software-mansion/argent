import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  FAILURE_CODES,
  FailureError,
  FLOW_NAME_PATTERN,
  getFailureSignal,
  isLiveServiceState,
  wrapFailure,
} from "@argent/registry";
import type {
  DeviceInfo,
  FailureSignal,
  FileInputSpec,
  Registry,
  ResolvedFileInput,
  ToolContext,
  ToolDefinition,
} from "@argent/registry";
import {
  appIdForPlatform,
  assertSafeFlowName,
  assertValidProjectRoot,
  blockSteps,
  chromiumLaunchSpec,
  classifyOnDiskSpelling,
  describeSelector,
  describeTextExpectation,
  getFlowPath,
  isBlockStep,
  parseFlow,
  runTargetName,
  type BlockStep,
  type FlowFile,
  type FlowSelector,
  type FlowStep,
  type Launch,
  type WhenCondition,
  LAUNCH_PLATFORMS,
  SELECTOR_RELATIONS,
} from "./flow-utils";
import type { TextMatchMode, WaitCondition } from "../../utils/ui-tree-match";
import { sleepOrAbort } from "../../utils/timing";
import { invokeSubTool } from "../../utils/sub-invoke";
import { isUnmetUiWaitResult } from "../await-ui-element";
import { isDebuggerNotConnectedResult } from "../debugger/not-connected";
import {
  resolveFlowDevice,
  bindDeviceArgs,
  flowRequiresDevice,
  flowScopesDevice,
  stepRequiresDevice,
  type FlowPlatform,
} from "./flow-device";
import { isNestedOrchestratorTool, nestedOrchestratorOutcome } from "./flow-nested-outcome";
import {
  runDirective,
  invokeOnDevice,
  ABORTED_OUTCOME,
  probeWhenCondition,
  type ActionEnv,
  type DirectiveOutcome,
} from "./flow-actions";
import {
  buildAppStateMessage,
  isInjectableBundleId,
  isNativeDevtoolsBlockResult,
  nativeDevtoolsRef,
  NATIVE_DEVTOOLS_CONNECT_BUDGET_MS,
  type NativeDevtoolsApi,
  type NativeDevtoolsAppState,
} from "../../blueprints/native-devtools";
import { androidDevtoolsRef, type AndroidDevtoolsApi } from "../../blueprints/android-devtools";
import {
  chromiumCdpRef,
  ensureCdpReachable,
  CHROMIUM_CDP_NAMESPACE,
  type ChromiumCdpApi,
} from "../../blueprints/chromium-cdp";
import { bootElectronApp, killChromiumByPortAndWait } from "../devices/boot-electron";
import { untrackChromiumPort } from "../../utils/chromium-discovery";
import { parseChromiumCdpPort, resolveDevice } from "../../utils/device-info";
import { runSnapshot, DEFAULT_MAX_MISMATCH, type SnapshotArtifacts } from "./flow-visual";
import { describeVega } from "../describe/platforms/vega";
import { pinStatusBar, restoreStatusBar } from "../../utils/status-bar";

const zodSchema = z
  .object({
    name: z
      .string()
      .optional()
      .describe(
        'Name of a saved flow to run from `.argent/flows` (e.g. "settings-explore"). Omit when flow_path is set.'
      ),
    project_root: z
      .string()
      .describe(
        "Absolute path to the calling agent's project root — the cwd it is working in. With name, the saved flow is read from `.argent/flows/<name>.yaml` under this root; with flow_path, the flow, its run: siblings, and baselines all resolve beside the YAML instead, so pass the agent's cwd."
      ),
    flow_file: z
      .string()
      .optional()
      .describe(
        "Path to the flow .yaml as readable by the tool-server. Internal — the argent client derives it from project_root and name automatically; leave unset."
      ),
    flow_path: z
      .string()
      .optional()
      .describe(
        "Omit when name is set. Absolute path to a co-located flow .yaml on the client and tool server's shared filesystem. This must be supplied through the file-input boundary. For remote execution, pass name + project_root instead."
      ),
    device: z
      .string()
      .optional()
      .describe(
        "Device id to run against (iOS UDID, Android/Vega serial, Chromium id) — the id list-devices reports. Auto-detected when omitted, but only when exactly one booted device matches (optionally narrowed by `platform`); with several booted the run fails and lists them, so pass this explicitly whenever more than one device is up."
      ),
    platform: z
      .enum(LAUNCH_PLATFORMS)
      .optional()
      .describe(
        "Restrict auto-detection to this platform when several devices are booted. `chromium` does more than filter: with no `device` it SELECTS the self-boot branch for an e2e flow - the runner boots an Electron instance from the `launch` step's chromium value and tears it down after the run (a single-key `launch: { chromium: … }` map selects it on its own, without this parameter). When it selects that branch it never falls back to device auto-detection (a fragment, or an e2e launch map with no `chromium` key, still does), and the launch value must be a real Electron app path on the tool-server host: a bare-string `launch:` - what the recorder writes - holds an installed-app bundle id, so passing `chromium` for one fails the whole run with `Electron boot: path does not exist`. Edit the launch to `{ chromium: <app path> }` first."
      ),
    updateBaselines: z
      .boolean()
      .optional()
      .describe(
        "Write/refresh screenshot baselines for `snapshot` steps instead of diffing against them."
      ),
    prerequisiteAcknowledged: z
      .boolean()
      .optional()
      .describe(
        "Set to true to confirm the execution prerequisite has been met. Required (LLM path) when a fragment defines an executionPrerequisite."
      ),
  })
  .superRefine((params, ctx) => {
    if ((params.name === undefined) === (params.flow_path === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Pass exactly one flow source: name or flow_path.",
        path: ["flow_path"],
      });
    }
  });

type Params = z.infer<typeof zodSchema>;

// A dual-source call (name + flow_path) must be diagnosed by the schema's
// exactly-one rule, not by whether either unused file happens to exist — in
// each direction the boundary keeps its hands off the wrapper:
// - unwrapWhenSet: flow_path is caller-authored, so alongside name it is
//   handed to zod as its plain client path (dropping it would legitimize the
//   call and silently run the saved flow the caller did not ask for).
// - skipWhenSet: flow_file is client-derived from name, so alongside flow_path
//   it is dropped — the caller never authored it, there is nothing to surface.
const fileInputs: FileInputSpec[] = [
  {
    target: "flow_path",
    path: "${flow_path}",
    kind: "file",
    optional: true,
    unwrapWhenSet: "name",
  },
  {
    target: "flow_file",
    path: "${project_root}/.argent/flows/${name}.yaml",
    kind: "file",
    skipWhenSet: "flow_path",
  },
];

export type StepStatus = "pass" | "fail" | "skip" | "error";

export interface StepReport {
  index: number;
  kind: FlowStep["kind"];
  status: StepStatus;
  /**
   * Machine-readable explanation of the outcome. Always set when the step did
   * not pass; also set on some passing reports whose result is self-narrating —
   * the `when:` guard marker (`condition met (…)`), snapshot passes (diff
   * percentage, baseline written/updated), and a chromium `launch` whose
   * instance the runner booted and owns (naming it; a mid-run boot appends
   * `— run moved off <id>`, or `— retired <id> (same app relaunched)` when the
   * instance it left was the one killed — and `— run moved off <id>, retired
   * <id> (same app relaunched)` when the one killed was an older owned
   * instance instead, so no kill goes unreported) — an attach to an instance
   * the runner does not own reports no reason.
   */
  reason?: string;
  /**
   * The step passed, but the WAY it passed weakens it as proof. Rendered as a
   * "⚠" suffix by the MCP client, and under the step line by the CLI. Raised by
   * `await: { idle: true }`: the screen never settled at all (it waits, then
   * goes ahead); something small on it never stopped, which is what a spinner
   * looks like; it rendered no content to settle; too few reads came back with
   * content for it to judge anything; or its captures never produced a
   * comparable pair, leaving stillness proved on the UI tree alone without the
   * presentation-layer motion the pixel half exists to catch. Raised too by a
   * selector-less gesture (coordinate `tap`/`long-press`, centre-anchored
   * `pinch`/`rotate`) that a tree-source outage left unsettled: it is dispatched
   * regardless, and the warning is the only thing separating it from one that
   * waited.
   */
  warning?: string;
  /** Underlying tool id for `tool` steps. */
  tool?: string;
  /** Tool result for `tool` steps. */
  result?: unknown;
  /** The tool's adapter output hint (e.g. "image"), for clients that render it. */
  outputHint?: string;
  /** The args the tool ran with (device id injected). */
  args?: unknown;
  /** Echo message. */
  message?: string;
  /**
   * The fragment a step belongs to (set on `run` and the steps it expands) —
   * normally the target's basename stem; when that stem collides with the
   * top-level flow's name, the target's as-written path minus the `.yaml`
   * extension (`./<stem>` for a bare spelling). So a fragment-attributed
   * value never equals the report's `flow`: without the collision the stem
   * differs from the root's name by definition, and with it the value
   * contains a `/`, which flow names cannot (FLOW_NAME_PATTERN). Renderers
   * distinguish fragment steps by exactly that inequality.
   */
  flow?: string;
  /**
   * Human-readable "what this step acts on" — the selector for directive
   * steps, the snapshot name — so a report line reads `tap "Clear logs"`,
   * not a bare `tap`. Display-only; derived from the step definition.
   */
  target?: string;
  /**
   * Baseline key stem (`<name>__<platform>-WxH`, plus `-crop-<hash>` for
   * cropOn snapshots) for snapshot steps that carry artifacts — clients
   * exporting them to a durable location (the CLI's `--output`) name files
   * by it.
   */
  snapshotKey?: string;
  /** Snapshot-step artifacts (baseline/current/diff) as materializable handles. */
  artifacts?: SnapshotArtifacts;
  /**
   * Nesting depth for display: omitted at top level, +1 inside each nesting
   * step's expanded steps (a `when:` block's guarded steps, a `run:`
   * fragment's steps). Renderers indent by it without knowing which directives
   * nest — the report is a flat list with no block-end marker, so depth cannot
   * be reconstructed downstream.
   */
  depth?: number;
}

export interface FlowRunResult {
  flow: string;
  device: string;
  executionPrerequisite: string;
  ok: boolean;
  /**
   * The run was cancelled mid-flight — set so a FAIL whose step statuses are
   * all pass/skip is self-explanatory. Absent on completed runs.
   */
  aborted?: boolean;
  passed: number;
  failed: number;
  skipped: number;
  errored: number;
  steps: StepReport[];
}

export interface FlowPrerequisiteNotice {
  flow: string;
  notice: string;
  executionPrerequisite: string;
}

/**
 * Longest `run:` chain a flow may nest. Exported so the boundary tests build
 * their chains from the real limit rather than a literal that silently drifts.
 */
export const MAX_RUN_DEPTH = 20;

/**
 * Grace period to let a freshly (re)launched app settle before the first step
 * runs. A cold start can outlast the first directive's default auto-wait (e.g. a
 * short-grace `assert`, or a `tap` whose budget is eaten by the launch), so we
 * give the app a head start here rather than inflating every step's timeout.
 */
const POST_LAUNCH_SETTLE_MS = 1500;

/**
 * Flows resolve selectors against the native UIView tree, served over the
 * native-devtools connection the injected dylib opens asynchronously after
 * launch. The post-launch settle alone can race a slow cold start, so we
 * additionally poll for the connection before step 1. `fetchFlowTree` treats a
 * missing connection as a hard per-read error (it never degrades to the
 * collapsing AX tree — see flow-tree.ts), so without this gate a slow cold
 * start would fail the first directive with a raw tree-source error; gating
 * the launch step reports the problem where it belongs, with the measured
 * reason the connection never came up.
 *
 * The same budget the measurement allows a dial, and deliberately the same
 * constant: a gate that waited longer than the state machine's window would
 * time out onto `unregistered`, whose remedy is a tool-server restart, for an
 * app it had itself decided was still worth waiting for.
 *
 * Exported so the gate's reason text can be pinned against it rather than a
 * drifting literal.
 */
export const NATIVE_READY_TIMEOUT_MS = NATIVE_DEVTOOLS_CONNECT_BUDGET_MS;
const NATIVE_READY_POLL_MS = 250;

/**
 * How long the launch step has spent on the app by the time the gate takes its
 * verdict: the post-launch settle plus the whole connect wait. The gate's own
 * timeout is only the second half, so quoting it alone understates the age of a
 * process the step launched — the fact the remedies below rest on. Exported so
 * they can be pinned against it rather than a drifting literal.
 */
export const LAUNCH_TO_VERDICT_MS = POST_LAUNCH_SETTLE_MS + NATIVE_READY_TIMEOUT_MS;

/**
 * `tool:` steps that can change or relaunch the foreground app — running one
 * invalidates {@link ActionEnv.launchedNativeApp} and spends
 * {@link ActionEnv.treeOutage}. `button` is included for its `home` case;
 * distinguishing button kinds here would couple this list to that tool's arg
 * schema for little gain.
 *
 * `launch-app` and `restart-app` re-set the id from their own `bundleId` once
 * they return — they name the app they switched to, where the rest leave it
 * unknown.
 */
const FOREGROUND_CHANGING_TOOLS = new Set([
  "launch-app",
  "restart-app",
  "reinstall-app",
  "open-url",
  "button",
]);

/**
 * Poll until native-devtools is connected for `bundleId`. Returns null once
 * connected, on abort (the caller reports the cancellation itself), and for an
 * app whose hierarchy this gate cannot wait for at all. Otherwise the reason the
 * connection never came up: the resolution error when the service is
 * unreachable, else the state measured off the running process, rewritten for
 * the one thing that distinguishes this caller — it has just launched the app.
 *
 * Measured rather than guessed: this gate is reached right after a launch, so
 * "re-run to relaunch" would be the same restart loop `appConnectionState`
 * exists to break, one level up.
 */
async function waitForNativeDevtools(
  registry: Registry,
  device: DeviceInfo,
  bundleId: string,
  signal?: AbortSignal
): Promise<string | null> {
  let api: NativeDevtoolsApi;
  try {
    const ref = nativeDevtoolsRef(device);
    api = await registry.resolveService<NativeDevtoolsApi>(ref.urn, ref.options);
  } catch (err) {
    // Withheld for the same reason as the timeout below: an app that may never
    // load the dylib was never going to be served by this service, so its
    // failure is not what stops the launch.
    if (!isInjectableBundleId(bundleId)) return null;
    return `the native-devtools service is unavailable for ${bundleId} (${errMsg(err)})`;
  }
  const deadline = Date.now() + NATIVE_READY_TIMEOUT_MS;
  for (;;) {
    if (signal?.aborted) return null;
    if (api.isConnected(bundleId)) return null;
    if (Date.now() >= deadline) break;
    if (!(await sleepOrAbort(NATIVE_READY_POLL_MS, signal))) return null;
  }
  // Timed out with no connection. An app that may never load the dylib has no
  // hierarchy to wait for, so that is its expected outcome rather than a launch
  // failure: the step started the app, and a coordinate-driven flow needs
  // nothing more. The impossibility bites only where a selector needs the
  // hierarchy, and `fetchFlowTree` reports it there.
  //
  // The wait itself still runs, deliberately: whether the dylib loads into a
  // simulator system app is unsettled (#453 saw `connected: false` for
  // com.apple.Preferences on iOS 26.5, an E2E run `connected: true` on 18.5),
  // and skipping it would bake that contested claim into behaviour. Only the
  // VERDICT is withheld — before the measurement, which no arm below would
  // consult for such an app and which costs several simctl round-trips the
  // caller cannot interrupt.
  if (!isInjectableBundleId(bundleId)) return null;
  // Measure why — the state may have flipped to connected since the last poll.
  // The loop's abort check covers every exit but this one (`break` follows it
  // synchronously); an abort landing during the measurement's uninterruptible
  // simctl work is caught by the caller, which drops the reason.
  const state = await api.appConnectionState(bundleId).catch(() => "indeterminate" as const);
  if (state === "connected") return null;
  return flowLaunchGateReason(bundleId, state);
}

/**
 * The measured diagnosis, rewritten for the one fact that separates this caller
 * from every other consumer of {@link buildAppStateMessage}: it has just run
 * `restart-app` on this bundle id and spent {@link LAUNCH_TO_VERDICT_MS} on it.
 *
 * Those messages are written for a reader who has not launched anything, so
 * "launch it" / "restart it" is the missing step. Emitted verbatim here they
 * hand back the action this step just took, and an author who obeys re-runs the
 * flow into the identical state. Each state gets the sentence that is true
 * *after* a launch instead; the switch is exhaustive so a state added later
 * cannot inherit a remedy written for a reader who never launched.
 */
export function flowLaunchGateReason(
  bundleId: string,
  state: Exclude<NativeDevtoolsAppState, "connected">
): string {
  const measured = buildAppStateMessage(bundleId, state);
  switch (state) {
    case "not_running":
      // The step launched it and it is gone — the one state a relaunch provably
      // reproduces, since a relaunch is what produced it. The measured remedy is
      // the step's own action, so it reads as advice to change nothing.
      return (
        `${bundleId} was relaunched by this step and is no longer running ${LAUNCH_TO_VERDICT_MS} ms later, ` +
        `so it exited after launch rather than failing to connect. Re-running the flow repeats the same launch: ` +
        `start it by hand (launch-app, then describe or screenshot) to see the crash or early exit first.`
      );
    case "stale_process":
      // The first sentence must not pick between the state's two producers: a
      // process carrying no argent injection at all, or one carrying THIS
      // endpoint and merely older than the listener. Blaming the launchd
      // environment would be false for the second — and the measured text names
      // both. The environment IS right on a SECOND landing: a re-run's process
      // is younger than any long-up listener, which rules that second producer
      // out (it needs `processAge + grace >= listenerAge`).
      return (
        `${measured} This step already relaunched it, so the process it measured predates whatever the ` +
        `relaunch would have given it — re-run the flow to launch again. If it lands here twice, the ` +
        `simulator's launchd environment is not holding argent's instrumentation: re-boot the device ` +
        `(boot-device with force) before re-running.`
      );
    case "unregistered":
      // Everywhere else the window this verdict reads is the app's whole
      // lifetime; here it is only this step's launch plus its wait, which a cold
      // start (an RN build fetching its bundle) can outlast — so the measured
      // remedy would have the author restart a healthy tool-server. The figure
      // is the whole spend: the poll checks the live map once before its first
      // sleep, so a dial during the post-launch settle counts too.
      return (
        `${measured} A cold start slower than the ${LAUNCH_TO_VERDICT_MS} ms this step waited reads the ` +
        `same way — if that is likely, re-run the flow to relaunch and wait again before restarting anything.`
      );
    case "connecting":
      // A process seconds old, though this step launched the app
      // LAUNCH_TO_VERDICT_MS ago — so something relaunched it in between, and
      // the handshake being waited on belongs to that later process. "Wait" is
      // still right; crediting this step with that launch is not.
      return (
        `${measured} This step launched it ${LAUNCH_TO_VERDICT_MS} ms before that reading, so the process ` +
        `being measured started after the step's own launch — something relaunched it in between. Re-run ` +
        `the flow once the app is settled.`
      );
    case "indeterminate":
      // The measured text opens with "Call restart-app then retry", which this
      // step already did once. What survives is the part that terminates.
      return (
        `${measured} This step already performed that one restart, so re-run the flow at most once more ` +
        `before restarting the tool-server rather than the app.`
      );
  }
}

/**
 * Poll until the Vega automation toolkit — the only tree source on Vega —
 * serves a page source. Like iOS's injected dylib, the toolkit attaches
 * asynchronously at app launch, and `describeVega` degrades to an empty tree +
 * relaunch hint until it does; gating the launch on a served page source keeps
 * that window from eating the first directive's auto-wait (or silently
 * confirming a `hidden` assert against a blind read).
 */
async function waitForVegaAutomation(device: DeviceInfo, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + NATIVE_READY_TIMEOUT_MS;
  for (;;) {
    if (signal?.aborted) return false;
    try {
      const data = await describeVega(device.id);
      if (!data.hint) return true;
    } catch {
      // transient adb/forward failure mid-boot — retry until the deadline
    }
    if (Date.now() >= deadline) return false;
    if (!(await sleepOrAbort(NATIVE_READY_POLL_MS, signal))) return false;
  }
}

/**
 * Probe whether the android-devtools helper — the full-hierarchy source flows
 * resolve testIDs against (`flow-android-tree.ts`) — is usable.
 *
 * Unlike iOS's native-devtools (a connection the injected dylib opens
 * asynchronously *after* launch, which `waitForNativeDevtools` must poll for),
 * the Android helper is a separate `am instrument` process the registry spawns
 * synchronously on first `resolveService`. There is no post-launch race to wait
 * out: one resolution either brings the helper up (install + spawn + ping
 * handshake in the factory) or it can't run on this device. So this is a
 * one-shot probe, not a poll.
 */
async function androidDevtoolsReady(registry: Registry, device: DeviceInfo): Promise<boolean> {
  try {
    const ref = androidDevtoolsRef(device);
    const api = await registry.resolveService<AndroidDevtoolsApi>(ref.urn, ref.options);
    return api.isReady();
  } catch {
    return false; // helper can't be installed / spawned on this device
  }
}

/**
 * Gate a launch on the platform's full-hierarchy tree source being ready. If
 * it never comes up, every selector read would fail — `fetchFlowTree` refuses
 * to degrade to the trimmed AX tree (see flow-tree.ts) — so the launch step
 * fails outright with an actionable, platform-specific reason instead of
 * letting the first directive surface a raw tree-source error.
 *
 * Returns null when ready, when the platform needs no gate, when the run was
 * aborted, and for an iOS app whose hierarchy may never be servable at all (see
 * {@link waitForNativeDevtools}) — there the launch is not what failed, and the
 * first selector read reports the impossibility. Otherwise the reason to report.
 */
async function treeSourceGate(
  registry: Registry,
  device: DeviceInfo,
  bundleId: string,
  signal?: AbortSignal
): Promise<string | null> {
  if (device.platform === "ios" && !signal?.aborted) {
    const reason = await waitForNativeDevtools(registry, device, bundleId, signal);
    if (reason !== null && !signal?.aborted) {
      // Every reason names the bundle id, so the prefix must not: doubled, it
      // reads as two separate failures reported back to back.
      return `could not connect to native devtools. ${reason}`;
    }
  }
  if (device.platform === "android" && !signal?.aborted) {
    const ready = await androidDevtoolsReady(registry, device);
    if (!ready && !signal?.aborted) {
      return (
        `could not reach the Android devtools helper (full-hierarchy source for testID selectors). ` +
        `Confirm the device is unlocked and the argent helper can be installed (\`adb install -t\`); a locked device or a blocked install is the usual cause. Re-run once resolved.`
      );
    }
  }
  if (device.platform === "vega" && !signal?.aborted) {
    const ready = await waitForVegaAutomation(device, signal);
    if (!ready && !signal?.aborted) {
      return (
        `the Vega automation toolkit never served a page source for ${bundleId} (the flow tree source). ` +
        `The toolkit attaches at app launch — re-run to relaunch; if it keeps failing, confirm the app was built with automation support and the VVD is reachable over adb.`
      );
    }
  }
  return null;
}

/**
 * Execute a `launch` step: start the app from a clean state — terminate and
 * relaunch via `restart-app`, so a copy left running by a prior run can't leak
 * state in. Then let the app settle and wait for the platform's full-hierarchy
 * tree source (see {@link treeSourceGate}), so a slow cold start doesn't eat
 * into the next step's auto-wait budget or degrade it to the wrong tree.
 * Failures are reported as step outcomes, not thrown, so the run still returns
 * a structured report; a run cancelled mid-launch returns the shared aborted
 * outcome (reported as a skip), never a pass that verified nothing or an error
 * blaming the app.
 *
 * Chromium can't relaunch in place — see {@link runChromiumLaunch}.
 */
async function runLaunch(state: ExecState, app: Launch): Promise<DirectiveOutcome> {
  const env = deviceEnv(state);
  const { registry, device, signal } = env;

  // Relaunching is the repair the tree source asks for by name when it refuses
  // an app that loaded no instrumentation, so a verdict recorded before it is
  // spent. Cleared up front rather than on success: nothing after this point
  // leaves the source in the state the memo describes, and a gesture can follow
  // a launch with no read in between to clear it (see ActionEnv.treeOutage).
  if (state.treeOutage) state.treeOutage.proven = undefined;

  if (device.platform === "chromium") return runChromiumLaunch(state, app);

  const bundleId = appIdForPlatform(app, device.platform);
  if (!bundleId) {
    return {
      ok: false,
      reason: `no app id declared for platform "${device.platform}" — add a launch entry for it`,
    };
  }
  let restart: unknown;
  try {
    restart = await invokeOnDevice(env, "restart-app", { bundleId });
  } catch (err) {
    // A cancellation makes the sub-tool itself reject; that rejection is the
    // abort, not an app failure, so it must not be attributed to restart-app.
    if (signal?.aborted) return ABORTED_OUTCOME;
    return { ok: false, reason: `restart-app failed: ${errMsg(err)}` };
  }
  // A blocked precheck is RESOLVED rather than thrown, and returns before the
  // terminate and the launch — so the app was never started. Every remedy below
  // is written for one this step did launch: unread, the gate measures an app
  // that never ran and `not_running` becomes "it exited after launch", sending
  // the author after a crash that did not happen while the message naming the
  // real cause is dropped.
  if (isNativeDevtoolsBlockResult("restart-app", restart)) {
    return { ok: false, reason: `restart-app did not start ${bundleId}: ${restart.message}` };
  }
  if (!(await sleepOrAbort(POST_LAUNCH_SETTLE_MS, signal))) return ABORTED_OUTCOME;
  const gate = await treeSourceGate(registry, device, bundleId, signal);
  // The gate returns null (ready) on abort — check the signal before trusting
  // it, or a cancelled gate would read as a launch that verified readiness.
  if (signal?.aborted) return ABORTED_OUTCOME;
  if (gate) return { ok: false, reason: gate };
  // Remember the launched app for the rest of the RUN (nested `run:` flows
  // share this state, so a nested launch retargets the whole run — see
  // ActionEnv.launchedNativeApp). iOS tree reads use it to explain a read they
  // could not take, and to arbitrate a target auto-resolution stalled out on.
  state.launchedNativeApp = bundleId;
  return { ok: true };
}

/**
 * Execute a `launch` step on a Chromium device. A chromium "device" IS the
 * booted process (its id is the CDP port), so there is no in-place relaunch:
 * only the run's FIRST launch can be satisfied without booting — settling the
 * boot {@link resolveRunDevice} hoisted, or attaching to an instance the runner
 * does not own. Later launches boot their own ({@link bootChromiumForLaunch}).
 */
async function runChromiumLaunch(state: ExecState, app: Launch): Promise<DirectiveOutcome> {
  const { registry, device, signal } = deviceEnv(state);

  if (state.chromiumLaunched) return bootChromiumForLaunch(state, app);
  state.chromiumLaunched = true;

  const spec = chromiumLaunchSpec(app);
  if (!spec) return { ok: false, reason: noChromiumAppReason(device) };

  const owned = ownedInstance(state);
  if (owned) {
    // The hoist booted what an EARLIER read of the flow declared, and a leading
    // run: chain re-reads the file at execution — so settling is only valid
    // while this step still names the booted app; on mismatch fail loudly
    // rather than report a boot of an app that never started.
    const declared = await resolveAppPath(spec.path, state.flowsDir);
    if (declared !== owned.appPath) {
      return {
        ok: false,
        reason: `launch declares "${declared}" but the instance booted for this run is "${owned.appPath}" — the flow file changed after the run started`,
      };
    }
    // Seconds old and already fronted; just settle. Reported as a boot all the
    // same — a reason's presence is how a consumer tells an instance the run
    // owns (and will kill) from one it merely attached to.
    if (!(await sleepOrAbort(POST_LAUNCH_SETTLE_MS, signal))) return ABORTED_OUTCOME;
    return { ok: true, reason: `booted chromium instance ${device.id}` };
  }
  // Attach over CDP, not via `launch-app`: a chromium launch value is an app
  // path, which launch-app's bundleId grammar rejects.
  try {
    const ref = chromiumCdpRef(device);
    const api = await registry.resolveService<ChromiumCdpApi>(ref.urn, ref.options);
    await api.refreshViewport();
  } catch (err) {
    return {
      ok: false,
      reason: `could not attach to chromium instance "${device.id}": ${errMsg(err)}`,
    };
  }
  // The launch just named what the attached instance runs. Record the
  // canonical path as its capture identity — a later boot of this same app
  // must compare equal in the snapshot guard — and fold captures already
  // attributed to the anonymous attached identity into it: attaching restarts
  // nothing, so those captures came from this same app.
  state.attachedAppPath = await resolveAppPath(spec.path, state.flowsDir);
  for (const [key, appId] of state.snapshotApps) {
    if (appId === `attached:${device.id}`) state.snapshotApps.set(key, state.attachedAppPath);
  }
  if (!(await sleepOrAbort(POST_LAUNCH_SETTLE_MS, signal))) return ABORTED_OUTCOME;
  return { ok: true };
}

/**
 * Boot a fresh Chromium instance for a `launch` step and move the run onto it —
 * steps read `state.device` per call, so reassigning it is all the plumbing a
 * new id needs. An instance of the same app that this run owns is killed first:
 * an Electron app holding a single-instance lock makes the second process quit
 * on startup, so its CDP endpoint would never come up. Instances the run does
 * not own are never killed.
 */
async function bootChromiumForLaunch(state: ExecState, app: Launch): Promise<DirectiveOutcome> {
  // The device the run is on now — read before the boot below moves it.
  const { registry, device, signal } = deviceEnv(state);

  const spec = chromiumLaunchSpec(app);
  if (!spec) return { ok: false, reason: noChromiumAppReason(device) };
  const appPath = await resolveAppPath(spec.path, state.flowsDir);
  // Captured before the run moves: the success reason marks the step where the
  // run left this instance, so a green report shows the move (and its fate).
  const prevId = device.id;

  // Path equality, so two app directories shipping one Electron `name` (a v1/v2
  // build pair) are not recognized as one app: the first stays alive, its lock
  // quits this boot, and the failure lands on {@link singleInstanceLockHint} —
  // which is why that hint has to name the instances this run owns.
  const retiring = state.owned.findIndex((o) => o.appPath === appPath);
  let retiredId: string | undefined;
  if (retiring !== -1) {
    const [prev] = state.owned.splice(retiring, 1);
    retiredId = prev!.deviceId;
    await teardownBootedChromium(registry, prev!);
  }

  let booted: BootedChromium;
  try {
    booted = await bootChromiumForFlow(spec, state.flowsDir, state.viaUpload);
  } catch (err) {
    return { ok: false, reason: await chromiumBootFailureReason(state, err) };
  }
  // Recorded before the next await so a cancelled run still reclaims it.
  state.owned.push(booted);
  state.device = resolveDevice(booted.deviceId);

  await frontChromiumPage(registry, state.device);
  if (!(await sleepOrAbort(POST_LAUNCH_SETTLE_MS, signal))) return ABORTED_OUTCOME;
  // "retired" only for the instance actually killed: the one the run leaves
  // stays alive unless the relaunch is of its own app. A relaunch of a
  // different owned app kills an older instance the run is not on — named
  // alongside the move, since nothing else in the report accounts for it.
  const move =
    retiredId === prevId ? `retired ${prevId} (same app relaunched)` : `run moved off ${prevId}`;
  const alsoRetired =
    retiredId !== undefined && retiredId !== prevId
      ? `, retired ${retiredId} (same app relaunched)`
      : "";
  return {
    ok: true,
    reason: `booted chromium instance ${booted.deviceId} — ${move}${alsoRetired}`,
  };
}

/** Bound on the lock-hint liveness re-probe — an already-failing step must stay quick. */
const LOCK_SUSPECT_PROBE_TIMEOUT_MS = 800;

/**
 * The signal of a boot failure the underlying error cannot explain: an Electron
 * process that exits CLEANLY (code 0) before its CDP endpoint comes up — the
 * signature of a second copy quitting against an already-running instance's
 * single-instance lock. Null for every other failure, since a crash, missing
 * path, or spawn failure speaks for itself and a lock hint there would blame
 * the wrong app. The signal itself is returned, not a boolean, because the
 * hoist rethrows under it ({@link hoistedBootFailure}): the reworded error has
 * to keep the `error_code` and exit-code metadata the failure taxonomy reads.
 */
function singleInstanceLockSignal(err: unknown): FailureSignal | null {
  const signal = getFailureSignal(err);
  if (
    signal?.error_code !== FAILURE_CODES.CHROMIUM_ELECTRON_EXITED_BEFORE_READY ||
    signal.failure_exit_code !== 0
  ) {
    return null;
  }
  return signal;
}

/**
 * The instances that could be holding the lock a boot just lost to, each one
 * re-probed for liveness ({@link liveLockSuspects}) — the hint must not assert
 * that a process "is running" when it has since exited.
 */
interface LockSuspects {
  /** The un-owned instance the run attached to, when it still answers CDP. */
  attached: string | null;
  /** Instances this run booted and still holds, oldest first, that still answer CDP. */
  owned: BootedChromium[];
}

/** The hoisted boot's suspects: it attached to nothing and owns nothing yet. */
const NO_LOCK_SUSPECTS: LockSuspects = Object.freeze({ attached: null, owned: [] });

/**
 * The lock explanation, shared by both boot sites so the mid-run failure and
 * the hoisted one that precedes it name one cause in one wording. Both suspect
 * kinds are named when both are live, because they answer different questions:
 * the attached instance is the one the reader can actually close, while a
 * run-owned holder is what makes "close it and rerun" a lie — the runner kills
 * that one at run end, so there is nothing left to close and the rerun loses
 * the identical lock. With neither (every suspect dead, or a hoisted boot that
 * never attached) the hint stays general rather than sending the agent after a
 * ghost, which still beats leaving the likely cause out of band for a
 * lock-holder the runner never knew about.
 */
function singleInstanceLockHint(suspects: LockSuspects): string {
  const clauses: string[] = [];
  if (suspects.attached) {
    clauses.push(
      `${suspects.attached} is running and this run does not own it; if it is this same app, it holds that lock.`
    );
  }
  if (suspects.owned.length > 0) {
    // Every owned instance is listed rather than one guess: the failing app path
    // matched none of them (a match is retired before the boot), so what is left
    // is exactly the set the runner cannot rule out — telling WHICH one ships the
    // colliding Electron `name` would take reading each app's manifest, and
    // picking one would point at the wrong app as readily as the right one.
    const owned = suspects.owned.map((o) => `${o.deviceId} (${o.appPath})`).join(", ");
    clauses.push(
      `This run booted ${owned}, alive until run end — an app path that shares an Electron \`name\` with this one shares its lock. That holder is the runner's own, so closing it is not on offer and a rerun fails identically; launch them in separate runs, or give this launch its own \`--user-data-dir\` in \`args\`.`
    );
  }
  if (clauses.length === 0)
    clauses.push(`If a copy of this app is already running, close it and rerun.`);
  return `A clean exit before CDP comes up is the signature of a single-instance lock — an already-running copy of the app quits the new one at startup. ${clauses.join(" ")}`;
}

/**
 * Reason for a failed mid-run chromium boot: the underlying error, plus the
 * lock explanation when the failure carries that signature. The liveness
 * re-probe sits behind the shape check, so an ordinary boot failure never pays
 * the round-trip to name a suspect it would not mention.
 */
async function chromiumBootFailureReason(state: ExecState, err: unknown): Promise<string> {
  const base = `could not boot the chromium app: ${errMsg(err)}`;
  if (!singleInstanceLockSignal(err)) return base;
  return `${base} ${singleInstanceLockHint(await liveLockSuspects(state))}`;
}

/**
 * Every instance that could still hold the lock, probed in parallel so an
 * already-failing step pays one probe timeout rather than one per instance.
 */
async function liveLockSuspects(state: ExecState): Promise<LockSuspects> {
  const [attached, owned] = await Promise.all([
    liveAttachedInstance(state),
    liveOwnedInstances(state),
  ]);
  return { attached, owned };
}

/**
 * The attached (un-owned) chromium instance re-probed for liveness. Null when
 * the run never attached or the instance's CDP endpoint no longer answers.
 */
async function liveAttachedInstance(state: ExecState): Promise<string | null> {
  const id = state.attachedDeviceId;
  if (id === undefined) return null;
  const port = parseChromiumCdpPort(id);
  if (port === null) return null;
  return (await answersCdp(port)) ? id : null;
}

/**
 * The run's own instances, re-probed like the attached one: owning a process is
 * not evidence it lives — it can crash or be closed after its boot — and a dead
 * one holds no lock, so naming it would send the reader after the same ghost the
 * attached probe exists to avoid.
 */
async function liveOwnedInstances(state: ExecState): Promise<BootedChromium[]> {
  const alive = await Promise.all(state.owned.map((o) => answersCdp(o.port)));
  return state.owned.filter((_, i) => alive[i]);
}

/** Whether an instance still answers CDP, within the hint's probe budget. */
async function answersCdp(port: number): Promise<boolean> {
  try {
    await ensureCdpReachable(port, AbortSignal.timeout(LOCK_SUSPECT_PROBE_TIMEOUT_MS));
    return true;
  } catch {
    return false;
  }
}

/** The instance the runner booted for the current device, when it owns it. */
function ownedInstance(state: ExecState): BootedChromium | undefined {
  return state.owned.find((o) => o.deviceId === state.device?.id);
}

/**
 * App identity a snapshot capture is attributed to: the canonical app path of
 * the owned instance the run sits on, else the path the attaching launch
 * declared for the un-owned instance, else that instance's device id. The
 * declared path is trusted — the author pinned the device and named the app,
 * and the guard is best-effort collision detection, not attestation — so an
 * attach and a later boot of the same app spell one identity, not two.
 * On ios/android the device never moves mid-run, so the identity is constant
 * there and the baseline-collision guard stays chromium-scoped in effect.
 */
function snapshotAppIdentity(state: ExecState): string {
  // Only reached from a `snapshot` step, which acts on a device — `deviceEnv`
  // is the contradiction guard, not an expected path.
  return (
    ownedInstance(state)?.appPath ??
    state.attachedAppPath ??
    `attached:${deviceEnv(state).device.id}`
  );
}

/**
 * Reason for a launch naming no chromium app while the run is on chromium —
 * names the device, since a run can move onto one mid-flight.
 */
function noChromiumAppReason(device: DeviceInfo): string {
  return `no chromium app declared — the run is on ${device.id}; add a \`chromium:\` entry to this launch`;
}

// `device` is null for a run whose flow touches none. Narrowed rather than
// inherited from ActionEnv so every site that acts on the device has to say so
// (via `deviceEnv`) and the compiler can find the ones that don't.
interface ExecState extends Omit<ActionEnv, "device"> {
  device: DeviceInfo | null;
  /**
   * Whether {@link device} is the one the CALLER named, rather than one
   * auto-detected from what happens to be booted. Only a named device may
   * override a scope a recording already carries — see {@link bindDeviceArgs}.
   */
  deviceIsExplicit: boolean;
  /**
   * The ROOT flow file's canonical (realpath'd) directory — the anchor for
   * snapshot baselines and a chromium launch's relative app path, so a
   * symlinked root flow anchors beside its real file. `run:` targets instead
   * anchor to the containing flow file's own directory, derived from the run
   * stack's top entry by {@link scopeFlowDir} (not the `flowDir` parameter
   * threaded through {@link resolveRunDevice}, which is this root directory).
   */
  flowsDir: string;
  /**
   * Whether the flow arrived as an upload, making {@link flowsDir} a server temp
   * dir — a launch step's relative chromium app path can't be anchored there.
   */
  viaUpload: boolean;
  /**
   * The `__baselines__/<segment>` this run's snapshots key their store under —
   * the ROOT flow's CANONICAL stem, so the key agrees with {@link flowsDir}
   * (see {@link baselineKeyFor}). Deliberately NOT the run's caller-visible
   * identity: the report's `flow`, the runStack seed's display name, and the
   * CLI's `--output` directory all keep the as-written name.
   */
  baselineKey: string;
  updateBaselines: boolean;
  reports: StepReport[];
  stopped: boolean;
  /** Whether the status bar was pinned for this run (and so must be restored). */
  pinned: boolean;
  /**
   * Chromium instances the runner booted, oldest first — torn down in reverse at
   * run end. A chromium e2e flow's leading launch has its boot hoisted into
   * {@link resolveRunDevice}, so that one is here before step 1.
   */
  owned: BootedChromium[];
  /** True once a chromium `launch` step has run; every later one boots its own instance. */
  chromiumLaunched: boolean;
  /**
   * App identity ({@link snapshotAppIdentity}) each snapshot key in this run was
   * first captured from — run-scoped memory for runSnapshot's cross-app
   * baseline-collision guard, never persisted and never part of the key.
   */
  snapshotApps: Map<string, string>;
  /**
   * The un-owned chromium instance the run started attached to, if any — the
   * one instance the runner never kills, so it stands as a single-instance
   * lock suspect for every later lock-shaped boot failure
   * ({@link chromiumBootFailureReason}), even after the run moves on. The
   * instances in {@link ExecState.owned} are the other suspects: the runner
   * does kill those, but only at run end.
   */
  attachedDeviceId?: string;
  /**
   * Canonical app path the attaching launch declared for that instance — the
   * capture identity for snapshots taken on it ({@link snapshotAppIdentity}).
   * Unset until a launch attaches; a launch-free run keeps the anonymous
   * `attached:` identity, having never been told what the instance runs.
   */
  attachedAppPath?: string;
  /** Live progress hook: receives every report the moment it is appended. */
  onStepReport?: (report: StepReport) => void;
}

/**
 * The run state as an environment that acts on a device.
 *
 * Only reached from a step classified as needing one, which is why the device is
 * resolved at all. The throw is a contradiction guard, not an expected path: it
 * fires only if the classification and the executor ever disagree, and says so
 * rather than dereferencing null somewhere further in.
 */
function deviceEnv(state: ExecState): ActionEnv {
  if (!state.device) {
    throw new Error("internal: a step that acts on a device ran in a flow resolved as device-free");
  }
  return { ...state, device: state.device };
}

/** A chromium instance the runner booted and must tear down after the run. */
interface BootedChromium {
  deviceId: string;
  port: number;
  pid: number;
  /** Absolute app path it was booted from — identifies a relaunch of the same app. */
  appPath: string;
}

/**
 * Flow name for interaction messages: the display half of resolveFlowSource
 * (basename stem on the flow_path branch) without its validation — these
 * messages render before validation and must still say something on a call
 * validation is about to reject. path.basename keeps a bare ".yaml" filename
 * intact (stripping the suffix would leave nothing), and the raw-path /
 * placeholder fallbacks keep a pathological source from rendering as "" or
 * "undefined".
 */
function displayFlowName(params: { name?: string; flow_path?: string }): string {
  const stem =
    params.flow_path === undefined ? undefined : path.basename(params.flow_path, ".yaml");
  return params.name || stem || params.flow_path || "(unspecified)";
}

/**
 * Yield every parsed step, recursing into a block directive's children through
 * {@link blockSteps} rather than testing one kind: this is the sole feeder of
 * {@link assertUploadSelfContained}, so a block absent from the recursion would
 * carry an uploaded flow's nested `run:`/`snapshot` past the preflight and let
 * an unrunnable flow report green.
 */
function* walkSteps(steps: FlowStep[]): Generator<FlowStep> {
  for (const step of steps) {
    yield step;
    const inner = blockSteps(step);
    if (inner) yield* walkSteps(inner);
  }
}

/**
 * Reject an uploaded root flow that is not self-contained — one with a `run:`
 * or `snapshot` step (at any depth inside a block directive) — before anything
 * executes: a mid-run or guard-gated error could execute half the flow first,
 * or first surface in CI. Both step kinds anchor at the flow file's real
 * directory, which an uploaded flow does not have: a run: step's referenced
 * files stayed on the client, and snapshot baselines live beside the flow's
 * file — against a per-call temp materialization a plain snapshot can only fail
 * (no baseline) and updateBaselines writes PNGs no later run can find.
 */
function assertUploadSelfContained(flow: FlowFile): void {
  for (const step of walkSteps(flow.steps)) {
    if (step.kind === "run") {
      throw new FailureError(
        `This flow uses run: composition ("run: ${step.flow}"), which requires a co-located ` +
          `client and tool server — an uploaded flow's referenced files are not available on ` +
          `this host.`,
        {
          error_code: FAILURE_CODES.FLOW_FILE_INVALID,
          failure_stage: "flow_upload_run_composition",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }
    if (step.kind === "snapshot") {
      throw new FailureError(
        `This flow uses a snapshot step ("snapshot: ${step.name}"), whose baselines live ` +
          `beside the flow's file — an uploaded flow materializes to a fresh temp directory ` +
          `each call, so a plain snapshot can never find a baseline and updateBaselines ` +
          `(--update-baselines) writes PNGs no later run can read. Use name + project_root ` +
          `with a co-located client and tool server for snapshot flows.`,
        {
          error_code: FAILURE_CODES.FLOW_FILE_INVALID,
          failure_stage: "flow_upload_snapshot_baseline",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }
  }
}

export function createRunFlowTool(
  registry: Registry
): ToolDefinition<Params, FlowRunResult | FlowPrerequisiteNotice> {
  return {
    id: "flow-execute",
    interaction: {
      startedMsg: ({ params }) => `Running flow ${displayFlowName(params)}`,
      completedMsg: ({ params }) => `Ran flow ${displayFlowName(params)}`,
      failedMsg: ({ params, failureSignal }) =>
        `Failed to run flow ${displayFlowName(params)}: ${failureSignal.error_code}`,
    },
    description: `Run a saved flow from the .argent/flows/ directory, or an explicit boundary-managed flow_path.
Steps run in order: \`launch\` starts an app from scratch (terminate + relaunch) and waits until it is
ready; \`tool\` calls dispatch through the registry; \`tap\`/\`long-press\`/\`type\` resolve a selector to an
element and act on it (\`tap: { on, times: 2 }\` double-taps; \`long-press: { on, duration }\` presses and
holds; \`tap\`/\`long-press\` alternatively take a raw normalized point — bare \`{ x, y }\` or \`on: { x, y }\`;
any selector may scope its matches geometrically, the CSS combinators read off frames: \`within: <selector>\`
(descendant — inside that container's frame), \`after: <selector>\` (CSS \`~\` — following it in reading
order), \`next: <selector>\` (CSS \`+\` — the nearest such follower, which unlike CSS reaches past a
non-matching neighbour rather than failing), plus \`any: true\` (CSS \`*\` — legal only WITH a scope and
never beside text/id/role). Scopes nest to disambiguate — \`within: { id: card, within: { id: list } }\`
reads "inside card inside list", each container's frame inside the next);
\`scroll-to\` scrolls (momentum-free) until a target is visible; \`pinch\` zooms
(\`pinch: { on?, scale }\` — scale > 1 in, < 1 out; screen center when \`on\` is omitted); \`rotate\` is the
two-finger rotation gesture (\`rotate: { on?, by }\` — degrees, + clockwise, within ±3000°; screen center
when \`on\` is omitted; distinct from the \`rotate\` tool, which changes device orientation); \`await\` waits
for a UI condition, and additionally takes the one condition that has no selector: \`idle: true\` waits
until the screen has content and stops moving in BOTH the UI tree and the rendered pixels (it never
fails a run — a screen that never settles passes carrying a \`warning\`, which is what makes it safe to
persist; the one idle outcome that does stop the run is an \`error\` for a tree source THIS step could not
read at all — a broken window rather than a verdict about the app, which leaves the run not-ok and skips
every later step; it says nothing about WHICH screen settled — a dropped tap leaves the source screen
perfectly idle — so pair it with the element check that names the destination); \`wait\` pauses for a fixed number of milliseconds; \`assert\` checks one now; \`snapshot\`
diffs a screenshot — or, with \`cropOn: <selector>\`, one element's cropped region — against a stored
baseline (a missing baseline fails the step — set updateBaselines to adopt the current screen; a
cropped element whose size drifted fails on dimensions); \`echo\` annotates; \`run\` executes another flow
inline — a YAML path resolved against the directory of the flow file that references it (co-located
runs only).
A selector-less gesture — a coordinate \`tap\`/\`long-press\`, or a \`pinch\`/\`rotate\` with no \`on\` — resolves
no frame out of the tree, so an unreadable tree source does NOT stop it the way it stops \`idle\`: it
settles best-effort, dispatches anyway, and the step PASSES carrying a \`warning\` that quotes the source's
own error. That green says the gesture was SENT, not that it landed. Restore the tree source (usually
relaunch the app so the instrumentation loads), or accept the warning where the app can serve no tree;
the first such gesture proves the outage and later ones spend that verdict without paying the settle
window again. A tree read that comes back, or a relaunch, retires that verdict — which only makes the
next gesture pay a fresh window, and it warns again if the source is still down.
A \`when:\` block (condition + \`steps:\`, no else) runs its steps only if the condition holds —
checked once with the short assert grace — for one-sided divergences like interstitials and coach
marks; a skipped block reports distinctly and failures inside an entered block are real failures.
A flow that begins with a \`launch\` step is a self-contained e2e flow; one that doesn't runs against the
device's current state. Device id is injected by the runner (flows store none) — pass \`device\` or
\`platform\` to pick one, else the single booted device is used. On Chromium a \`launch\` step's value is an
Electron app path ({ chromium: <path> | { path, args } }) the runner boots (on the tool-server host) rather
than an installed app id it relaunches. With no explicit \`device\`, a run whose leading launch is
unambiguously chromium (\`platform: chromium\`, or a lone \`{ chromium: … }\` target) boots that app and
starts there — following a leading \`run:\`, so a fragment that composes a chromium e2e flow boots too;
otherwise the first launch attaches to an already-running instance and never kills it. Every later
launch — a nested e2e flow's own, or a mid-flow relaunch — boots a fresh instance the run moves onto;
an instance the run already owns for that same app is killed first (its exit awaited) so the
replacement can't lose the race against its single-instance lock. Instances the runner still owns at
run end are torn down then. A launch declaring no id for the run's platform is an error, not a cue to
switch platforms. Every step hard-stops the flow on failure; later steps are reported as skipped.
Returns a structured report ({ flow, device, executionPrerequisite, ok, aborted?, passed, failed,
skipped, errored, steps }) — \`device\` is the device the run STARTED on; when launches moved it onto
runner-booted instances, each names its instance in that step's reason and marks the move — \`run moved
off <id>\`, or \`retired <id> (same app relaunched)\` when the instance it left was the one killed —
a relaunch that retired an older owned instance names both.

If a fragment has an execution prerequisite and prerequisiteAcknowledged is not set to true, the tool
returns a notice with the prerequisite instead of running.
Pass exactly one flow source: name for a saved flow under project_root, or flow_path for an explicit YAML — both together, or neither, fails the call.`,
    longRunning: true,
    zodSchema,
    fileInputs,
    services: () => ({}),
    async execute(_services, params, ctx?: ToolContext) {
      const signal = ctx?.signal;
      const { filePath, flowName, viaUpload } = await resolveFlowSource(
        params,
        ctx?.fileInputs?.flow_file,
        ctx?.fileInputs?.flow_path
      );
      // Canonicalize the root path ONCE and derive every root anchor from it:
      // flowsDir (a relative chromium app path + snapshot baselines) and the
      // runStack seed (`run:` targets) must agree, or a symlinked root flow
      // would resolve `run:` beside its real file while the app path and
      // baselines anchored at the symlink's spelling.
      const canonicalPath = await canonicalFlowPath(filePath);
      const flowsDir = path.dirname(canonicalPath);
      const flow = parseFlow(await fs.readFile(canonicalPath, "utf8"));
      if (viaUpload) assertUploadSelfContained(flow);
      // One seed for all three `run:` walks — the prerequisite guard, the
      // chromium hoist, and the executor itself — so none can accept a chain
      // another refuses.
      const rootEntry: RunStackEntry = { canonical: canonicalPath, display: flowName };

      // Run-time analog of validateFlow's e2e-has-prerequisite rule: parse sees
      // one file, but a leading `run:` chain crosses files — a fragment whose
      // chain reaches a launch still (re)starts the app at step 1, destroying
      // the very state the prerequisite demands. Checked before the notice
      // handshake so a caller is never asked to establish state the run would
      // then throw away — and, resolving the pin by shape alone, before any
      // device listing or boot.
      //
      // Exempt: a run pinned to a chromium instance, whose leading launch
      // provably restarts nothing. An explicit `device` skips resolveRunDevice's
      // hoist, so the runner owns no instance at step 1 and the run's FIRST
      // chromium launch can only attach (a viewport refresh — see
      // runChromiumLaunch) or, declaring no chromium app, error; either way the
      // prerequisite state survives. That is the documented escape hatch for
      // running such a fragment against an instance you brought to the required
      // state yourself. Pinning buys nothing on ios/android/vega: `launch` there
      // is restart-app, which terminates and relaunches whatever device it is
      // handed, so those stay refused.
      if (flow.executionPrerequisite && !pinnedToChromium(params.device)) {
        const leading = await leadingLaunch(flow, [rootEntry]);
        if (leading) {
          // Offer the pin only where it is a real way out (see
          // chromiumPinnable): the guard also fires for unpinned runs of every
          // platform and for pinned native ones, and sending the caller of an
          // android flow after a chromium id would only misdirect.
          const pinRemedy = chromiumPinnable(leading.app, params.platform)
            ? ` Or pin the run to a chromium instance you have already brought to that state (--device chromium-cdp-<port>), where the leading launch only attaches.`
            : "";
          throw new FailureError(
            `A flow whose leading run: chain reaches a launch step must not declare executionPrerequisite — it launches its own app and controls its start state. Drop the leading launch in "${leading.flow}" to make it a fragment, or drop executionPrerequisite from "${flowName}".${pinRemedy}`,
            {
              error_code: FAILURE_CODES.FLOW_E2E_HAS_PREREQUISITE,
              failure_stage: "flow_run_validate",
              failure_area: "tool_server",
              error_kind: "validation",
            }
          );
        }
      }

      // LLM-path prerequisite handshake (fragments only; a flow with a leading
      // launch step cannot declare one — validated at parse, and a leading
      // run: chain into a launch is rejected just above unless that launch
      // merely attaches). The chromium-pinned run exempted above lands here and
      // takes the ordinary notice/acknowledge path, like any other prerequisite
      // fragment.
      if (flow.executionPrerequisite && !params.prerequisiteAcknowledged) {
        return {
          flow: flowName,
          notice:
            "This flow has an execution prerequisite that must be fulfilled before it can run. " +
            "Verify the prerequisite is met and call flow-execute again with prerequisiteAcknowledged set to true.",
          executionPrerequisite: flow.executionPrerequisite,
        };
      }

      // Resolve the run device (a run whose leading launch — direct, or reached
      // through a leading run: chain — is chromium boots + owns its own app; see
      // resolveRunDevice). Any instance it booted is torn down in the finally.
      const resolved = await resolveRunDevice(
        registry,
        ctx,
        flow,
        params,
        flowsDir,
        rootEntry,
        viaUpload
      );
      // The device the run STARTS on — `state.device` moves when a chromium
      // launch boots one, so the status-bar restore below must not follow it.
      const device = resolved.device;

      // Normalize the status bar (clock/battery/signal) for the whole run so it
      // never drives a snapshot diff and every screenshot is consistent. Pinned
      // before step 1 — it's a device-level override independent of the app, so
      // an e2e flow's leading launch step (relaunch + settle) doubles as
      // propagation headroom before anything is captured. No-op (returns false)
      // on chromium/vega; restored on teardown.
      const statusBarPinned = device !== null && (await pinStatusBar(device));

      // The chromium equivalent of that normalization: front the page so a
      // backgrounded window doesn't throttle rendering — wheel-event acks
      // (scroll steps) stall on a throttled compositor. Covers the instance the
      // run starts on; a launch that boots one fronts it itself. Best-effort:
      // bringToFront can focus a page but cannot unhide a minimized window
      // (gesture-scroll fails fast on that case itself).
      if (device?.platform === "chromium") await frontChromiumPage(registry, device);

      const state: ExecState = {
        registry,
        ctx,
        device,
        deviceIsExplicit: Boolean(params.device),
        signal,
        // One holder per ExecState, shared by nested `run:` flows: `deviceEnv`
        // spreads the reference, so what one step's settle learns about the
        // tree source the next one already has. A `tool: flow-execute` builds
        // its own instead, which is why that step spends this verdict rather
        // than inheriting whatever the sub-run proved.
        treeOutage: {},
        flowsDir,
        viaUpload,
        baselineKey: baselineKeyFor(canonicalPath, flowName),
        updateBaselines: Boolean(params.updateBaselines),
        reports: [],
        stopped: false,
        pinned: statusBarPinned,
        owned: resolved.booted ? [resolved.booted] : [],
        chromiumLaunched: false,
        snapshotApps: new Map(),
        ...(!resolved.booted && device?.platform === "chromium"
          ? { attachedDeviceId: device.id }
          : {}),
        ...(ctx?.emitProgress ? { onStepReport: ctx.emitProgress } : {}),
      };

      let aborted: boolean;
      try {
        await execSteps(state, flow.steps, {
          runStack: [rootEntry],
          depth: 0,
        });
      } finally {
        // Sample the cancel flag before teardown: a client disconnect during
        // status-bar restore / chromium teardown lands after every step
        // already ran, and must not flip a finished run to FAIL.
        aborted = state.signal?.aborted === true;
        // Restored on the device the pin was applied to — `state.device` may
        // have moved on since.
        if (state.pinned && device) await restoreStatusBar(device);
        // Reverse order: a nested flow's instance goes before the parent's.
        for (let i = state.owned.length - 1; i >= 0; i--) {
          await teardownBootedChromium(registry, state.owned[i]!);
        }
      }

      // The starting device: a run that switched says so on the launch step.
      // Empty when the flow needed no device — the run is not attributed to one
      // it never touched.
      return summarize(
        flowName,
        device?.id ?? "",
        flow.executionPrerequisite,
        state.reports,
        aborted
      );
    },
  };
}

/**
 * Resolve the device a flow *starts* on. When the run's leading launch is
 * unambiguously chromium (see {@link chromiumBootSpec}) and no explicit
 * `device` is given, this boots a fresh Electron instance from the launch's
 * app path and returns it for teardown — a fragment whose leading `run:` chain
 * reaches a chromium e2e flow boots just the same ({@link leadingLaunch}).
 * Otherwise it attaches to an already-booted device. An explicit `device`
 * never boots here — the run starts attached to it, and only a launch step
 * beyond the first moves off it onto an instance the runner owns
 * ({@link bootChromiumForLaunch}). `flowDir` is the root flow file's canonical
 * directory — the base for a relative chromium app path.
 *
 * Returns null when no step in the flow acts on a device: such a run needs none,
 * so demanding one would fail a flow that could have succeeded — and picking
 * whichever device happens to be booted would make the report depend on what
 * else is running on the machine.
 */
async function resolveRunDevice(
  registry: Registry,
  ctx: ToolContext | undefined,
  flow: FlowFile,
  params: Params,
  flowDir: string,
  rootEntry: RunStackEntry,
  viaUpload: boolean
): Promise<{ device: DeviceInfo | null; booted: BootedChromium | null }> {
  if (!params.device) {
    // The executor's own runStack seed, so a boot can never precede a chain it
    // then refuses.
    const leading = await leadingLaunch(flow, [rootEntry]);
    const spec = leading && chromiumBootSpec(leading.app, params.platform);
    if (spec) {
      let booted: BootedChromium;
      try {
        booted = await bootChromiumForFlow(spec, flowDir, viaUpload);
      } catch (err) {
        throw hoistedBootFailure(err);
      }
      return { device: resolveDevice(booted.deviceId), booted };
    }
    // Checked after the chromium boot path, which only applies to a flow led by
    // a `launch` step — and a launch needs a device, so the two never compete.
    if (!flowRequiresDevice(registry, flow.steps)) {
      if (!flowScopesDevice(registry, flow.steps)) return { device: null, booted: null };
      // A flow that only SCOPES to a device (a cleanup flow) takes one when one
      // is unambiguous, so the teardown stays narrowed to the run device and
      // cannot reap what another agent is mid-session on. When resolution has
      // no single answer — nothing booted, or several — that is not a question
      // a sweep has an answer to, so run it unscoped rather than failing the
      // flow. Swallowed only here: every other caller genuinely needs the
      // device, and the diagnosis in the error is the useful thing there.
      //
      // And swallowed only for THAT answer. `resolveFlowDevice` also reaches
      // `list-devices` through the registry, so a bare catch also absorbed an
      // adb/simctl failure, a dead sub-tool, an abort — and the teardown step
      // then ran unscoped and reported pass, which is the machine-wide sweep
      // this whole path exists to avoid. Anything that is not the ambiguity
      // rethrows and fails the run.
      try {
        return {
          device: await resolveFlowDevice(registry, ctx, resolveOpts(params)),
          booted: null,
        };
      } catch (err) {
        if (getFailureSignal(err)?.error_code !== FAILURE_CODES.FLOW_DEVICE_RESOLUTION) throw err;
        return { device: null, booted: null };
      }
    }
  }
  const device = await resolveFlowDevice(registry, ctx, resolveOpts(params));
  return { device, booted: null };
}

function resolveOpts(params: Params): { device?: string; platform?: FlowPlatform } {
  return { device: params.device, platform: params.platform as FlowPlatform | undefined };
}

/**
 * The hoisted boot's failure, carrying the lock explanation when it is
 * lock-shaped. This is the likeliest way of all to meet the lock — the app is
 * already open on the developer's desktop when the run starts — and the one
 * path with no step report to hang a reason on ({@link bootChromiumForFlow}),
 * so the diagnosis has to ride the thrown error itself. A hoist has attached to
 * nothing, so there is never a suspect to name. The rethrow goes through
 * {@link wrapFailure} under the failure's own signal, which keeps the
 * `error_code` (and the original error as `cause`) that the CLI and the failure
 * taxonomy key on — only the message grows; the fallback argument is unreachable
 * here, since a lock-shaped failure is by definition one that carries a signal.
 */
function hoistedBootFailure(err: unknown): unknown {
  const signal = singleInstanceLockSignal(err);
  if (!signal) return err;
  return wrapFailure(err, signal, `${errMsg(err)} ${singleInstanceLockHint(NO_LOCK_SUSPECTS)}`);
}

/**
 * Does an explicit `device` param pin the run to a chromium instance? Answered
 * from the id's shape, which is the whole of what {@link resolveFlowDevice}
 * does with an explicit device ({@link resolveDevice}) — so the answer is
 * exactly the platform the first `launch` step will see, available before the
 * runner has talked to any device. False for an unpinned run, which stays
 * refused — not because a boot is certain there, but because it is undecidable
 * at this point: an unambiguously chromium leading launch ({@link
 * chromiumBootSpec}) has {@link resolveRunDevice} hoist-boot a fresh instance
 * the run owns, so that launch settles a brand-new app and the prerequisite
 * state is gone, while an only *ambiguously* chromium one (multi-platform map,
 * no `platform`) hoists nothing and would in fact attach to whatever
 * auto-detection lands on. Telling those apart needs a device listing, and the
 * refusal has to come before the caller is asked to establish state — so the
 * guard takes the safe answer, and a caller who knows the instance says so with
 * `device`.
 */
function pinnedToChromium(device: string | undefined): boolean {
  return device !== undefined && resolveDevice(device).platform === "chromium";
}

/**
 * Does this leading launch declare a chromium target — i.e. would the
 * {@link pinnedToChromium} exemption be any use to the caller staring at the
 * refusal? Pinned to an instance, a launch naming no chromium app doesn't
 * attach, it errors ({@link noChromiumAppReason}), so an ios/android/vega-only
 * launch must not advertise the pin. A multi-platform map counts: pinning is
 * precisely what picks chromium out of it (only the *boot* hoist demands an
 * unambiguous one). A bare string names no platform and is the native
 * bundle-id shape, read as an app path only once something says chromium — so
 * it counts under `--platform chromium` alone.
 */
function chromiumPinnable(app: Launch, platform: string | undefined): boolean {
  if (typeof app === "string") return platform === "chromium";
  return chromiumLaunchSpec(app) !== null;
}

/** {@link scanLeadingLaunch}'s "keep scanning the parent" outcome. */
const NO_EXECUTABLE_STEP = "no-executable-step";

/**
 * The launch the RUN begins with, following a leading `run:` — a fragment whose
 * first step composes an e2e flow starts with that flow's launch, and the runner
 * has to know that before step 1 to boot a chromium app for it (and to refuse a
 * prerequisite that launch would invalidate). `flow` names the flow whose first
 * step IS the launch, so a rejection can point at the right file. Null when the
 * run doesn't begin with a launch, or when the chain can't be read (a broken
 * `run:` target is reported properly by {@link execRunStep} when it executes).
 */
async function leadingLaunch(
  flow: FlowFile,
  stack: RunStackEntry[]
): Promise<{ app: Launch; flow: string } | null> {
  const found = await scanLeadingLaunch(flow, stack);
  return found === NO_EXECUTABLE_STEP ? null : found;
}

/**
 * {@link leadingLaunch}'s recursion, plus the third outcome it needs internally:
 * {@link NO_EXECUTABLE_STEP} — this flow, and everything its leading `run:`s
 * pulled in, contribute no executable step. That is not a reason to give up on
 * the run: {@link execRunStep} inlines such a fragment and carries straight on
 * to the *parent's* next step, so the scan resumes there too. Abandoning the
 * whole scan instead would make `[run: <echo-only frag>, run: <e2e>]` look
 * launch-free while the run really does launch first thing — the chromium hoist
 * would skip (leaving the run attached to whatever instance happens to be up,
 * green launch step and all) and the prerequisite guard would wave through a
 * run that destroys the state it just asked the caller to establish.
 *
 * The walk below IS the executor's, run ahead of time: it takes the same
 * `runStack` (seeded with the root flow), resolves each hop exactly as
 * {@link execRunStep} does — anchored at the containing file's canonical
 * directory, by concatenation so a `..` reaches the kernel uncollapsed — and
 * applies the same cycle, depth, and on-disk-casing guards. That is not
 * duplication for its own sake: a chain the executor refuses never reaches its
 * launch, so any hop it would error on stays `null` (give up) here, never
 * transparent. Anything unreadable is `null` too — {@link execRunStep} reports
 * that properly when it executes.
 */
async function scanLeadingLaunch(
  flow: FlowFile,
  stack: RunStackEntry[]
): Promise<{ app: Launch; flow: string } | typeof NO_EXECUTABLE_STEP | null> {
  const top = stack[stack.length - 1]!;
  for (const step of flow.steps) {
    if (step.kind === "echo") continue;
    if (step.kind === "launch") return { app: step.app, flow: top.display };
    if (step.kind !== "run") return null;
    const spelled = path.dirname(top.canonical) + path.sep + step.flow;
    let nested: FlowFile;
    let canonical: string;
    try {
      canonical = await canonicalFlowPath(spelled);
      if (stack.some((entry) => entry.canonical === canonical)) return null;
      if (stack.length >= MAX_RUN_DEPTH) return null;
      const supplied = path.posix.basename(step.flow);
      const spelling = await classifyOnDiskSpelling(path.dirname(spelled), supplied);
      if (spelling.state === "case_folded") return null;
      nested = parseFlow(await fs.readFile(canonical, "utf8"));
    } catch {
      return null;
    }
    const inner = await scanLeadingLaunch(nested, [
      ...stack,
      { canonical, display: runDisplayFor(step.flow, stack[0]!.display) },
    ]);
    if (inner !== NO_EXECUTABLE_STEP) return inner;
  }
  return NO_EXECUTABLE_STEP;
}

/**
 * The Chromium app-path spec to boot for this run, or null when the run's
 * leading launch isn't unambiguously a chromium one — `--platform chromium`, or
 * a single-platform `{ chromium: ... }` map. A multi-platform or bare launch
 * with no hint defers to device auto-detection.
 */
function chromiumBootSpec(
  app: Launch,
  platform: string | undefined
): { path: string; args?: string[] } | null {
  if (launchTargetPlatform(app, platform) !== "chromium") return null;
  return chromiumLaunchSpec(app);
}

/**
 * The platform a leading launch targets: an explicit `platform`, else the sole
 * key of a single-key launch map. Null when ambiguous (bare string, or several
 * keys) — the caller then auto-detects a booted device.
 */
function launchTargetPlatform(launch: Launch, platform: string | undefined): string | null {
  if (platform) return platform;
  if (typeof launch === "object") {
    const keys = Object.keys(launch);
    if (keys.length === 1) return keys[0]!;
  }
  return null;
}

/**
 * The absolute app path a chromium launch names — relative resolves against the
 * root flow file's canonical directory, the same anchor baselines (and the root
 * file's own `run:` targets) use, so the target is intrinsic to the flow, not
 * the caller's cwd; absolute passes through. Canonicalized through the OS
 * realpath (symlinks and on-disk casing fold), so two spellings of one app
 * compare equal; a path not on disk keeps the lexical resolution and lets the
 * boot report the missing app itself.
 */
async function resolveAppPath(specPath: string, flowDir: string): Promise<string> {
  const lexical = path.resolve(flowDir, specPath);
  try {
    return await fs.realpath(lexical);
  } catch {
    return lexical;
  }
}

/**
 * Boot the Electron app a chromium launch declares. Boot failures propagate out
 * of here untouched, and the two callers surface them differently: from the
 * {@link resolveRunDevice} hoist the tool call rejects with no report (the
 * Chromium analog of `resolveFlowDevice` throwing on no booted device), while
 * {@link bootChromiumForLaunch} catches and reports a step error inside the
 * run. Either way a lock-shaped failure picks up the same explanation
 * ({@link singleInstanceLockHint}) — in the thrown message on the hoist
 * ({@link hoistedBootFailure}), in the step reason mid-run.
 */
async function bootChromiumForFlow(
  spec: { path: string; args?: string[] },
  flowDir: string,
  viaUpload: boolean
): Promise<BootedChromium> {
  // An uploaded flow's flowDir is a server temp dir — resolving a relative app
  // path there would produce a misleading ENOENT or launch a same-named host
  // path, so reject with the contract error instead.
  if (viaUpload && !path.isAbsolute(spec.path)) {
    throw new FailureError(
      `A relative chromium app path ("${spec.path}") resolves against the flow file's ` +
        `directory, which requires a co-located client and tool server — an uploaded flow ` +
        `has no real flow directory on this host. Use an absolute tool-server path instead.`,
      {
        error_code: FAILURE_CODES.FLOW_FILE_INVALID,
        failure_stage: "flow_upload_chromium_app_path",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }
  const appPath = await resolveAppPath(spec.path, flowDir);
  const res = await bootElectronApp({ appPath, extraArgs: spec.args });
  return { deviceId: res.id, port: res.port, pid: res.pid, appPath: res.appPath };
}

/**
 * Tear down a Chromium instance the runner booted. Best-effort — never fail a
 * run here: dispose the CDP session (if a tool opened one), kill the process,
 * and forget its port so `list-devices` stops probing it. The kill is awaited
 * to the process's actual exit (bounded — see {@link killChromiumByPortAndWait})
 * because every next boot of the same app — an in-run relaunch or a
 * back-to-back run — would otherwise race the dying instance's lock.
 */
async function teardownBootedChromium(registry: Registry, booted: BootedChromium): Promise<void> {
  const urn = `${CHROMIUM_CDP_NAMESPACE}:${booted.deviceId}`;
  try {
    const entry = registry.getSnapshot().services.get(urn);
    if (entry && isLiveServiceState(entry.state)) await registry.disposeService(urn);
  } catch {
    /* the kill below frees the real resource regardless */
  }
  try {
    await killChromiumByPortAndWait(booted.port, booted.pid);
    untrackChromiumPort(booted.port);
  } catch {
    /* one unreachable instance must not strand the others the run-end loop still owes */
  }
}

/**
 * Focus the chromium page for the run. Best-effort: a flow must never fail
 * over focus housekeeping, so resolution/CDP errors are swallowed — the run
 * proceeds and any genuinely blocked step reports its own failure.
 */
async function frontChromiumPage(registry: Registry, device: DeviceInfo): Promise<void> {
  try {
    const ref = chromiumCdpRef(device);
    const api = await registry.resolveService<ChromiumCdpApi>(ref.urn, ref.options);
    await api.cdp.send("Page.bringToFront");
  } catch {
    /* focus is best-effort */
  }
}

function summarize(
  flowName: string,
  deviceId: string,
  executionPrerequisite: string,
  steps: StepReport[],
  aborted: boolean
): FlowRunResult {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let errored = 0;
  for (const s of steps) {
    // Echo is narration, not a test step — counting it would let the summary
    // disagree with the renderers' step numbering (which skips echo too).
    if (s.kind === "echo") continue;
    if (s.status === "pass") passed++;
    else if (s.status === "fail") failed++;
    else if (s.status === "skip") skipped++;
    else errored++;
  }
  return {
    flow: flowName,
    device: deviceId,
    executionPrerequisite,
    // A cancelled run must never read as PASS — it may contain skips alone
    // (no fail/error report), so the verdict folds the abort in directly. A
    // skip by itself is NOT a failure: an unmet `when:` guard skips its block
    // as a successful omission, and a hard stop already carries its own
    // fail/error report.
    ok: failed === 0 && errored === 0 && !aborted,
    ...(aborted ? { aborted: true } : {}),
    passed,
    failed,
    skipped,
    errored,
    steps,
  };
}

/**
 * Append a report to the run and hand it to any live progress consumer. The
 * single choke point for every report — a push site that bypasses it would
 * silently drop steps from the progress stream.
 */
function pushReport(state: ExecState, report: StepReport): void {
  state.reports.push(report);
  state.onStepReport?.(report);
}

function selectorLabel(sel: FlowSelector): string {
  const parts: string[] = [];
  // The universal selector prints as CSS spells it, so a scope-only target
  // never renders as an empty label.
  if (sel.any) parts.push("*");
  if (sel.text !== undefined) parts.push(`"${sel.text}"`);
  if (sel.textMatches !== undefined) parts.push(`/${sel.textMatches}/`);
  if (sel.identifier) parts.push(`id=${sel.identifier}`);
  if (sel.role) parts.push(`role=${sel.role}`);
  // Each relational scope renders after the fields, parenthesized and
  // recursive, so two steps that differ only by scope don't collapse to the
  // same target label in the report — mirroring `describeSelector`'s
  // reason-string spelling so the two surfaces stay in lockstep (see
  // `conditionLabel`).
  for (const relation of SELECTOR_RELATIONS) {
    const scope = sel[relation];
    if (scope !== undefined) parts.push(`${relation} (${selectorLabel(scope)})`);
  }
  return parts.join(" ");
}

/**
 * One template for rendering an await/assert/when-guard UI condition,
 * parameterized by selector spelling — {@link selectorLabel} for report
 * targets, `describeSelector` for reason strings — so the two surfaces share
 * a single shape and cannot drift.
 */
function conditionLabel(
  cond: {
    condition: WaitCondition;
    selector: FlowSelector;
    expectedText?: string;
    textMatch?: TextMatchMode;
  },
  renderSelector: (sel: FlowSelector) => string
): string {
  const sel = renderSelector(cond.selector);
  // A text condition checks expectedText against the element the selector
  // locates; the other conditions are about the selector itself.
  if (cond.condition === "text") {
    return `${sel} ${describeTextExpectation(cond.expectedText, cond.textMatch)}`;
  }
  return `${cond.condition} ${sel}`;
}

/** Display-only "what this step acts on" for {@link StepReport.target}. */
function stepTarget(step: FlowStep): string | undefined {
  switch (step.kind) {
    case "tap":
    case "long-press":
      if (step.selector) return selectorLabel(step.selector);
      if (step.x !== undefined && step.y !== undefined) return `(${step.x}, ${step.y})`;
      return undefined;
    case "type":
      return `into ${selectorLabel(step.into)}`;
    case "await":
    case "assert":
      return conditionLabel(step, selectorLabel);
    case "idle":
      // The caller already prints the kind, and this step has no target beyond
      // the screen itself: returning one would render as "idle screen idle".
      return undefined;
    case "when":
      return step.condition.kind === "platform"
        ? `platform ${step.condition.platform}`
        : conditionLabel(step.condition, selectorLabel);
    case "scroll-to": {
      const dir = step.direction !== "down" ? ` (${step.direction})` : "";
      return `${selectorLabel(step.target)}${dir}`;
    }
    case "pinch": {
      const scale = `scale ${step.scale}`;
      return step.selector ? `${selectorLabel(step.selector)} (${scale})` : scale;
    }
    case "rotate": {
      const by = `by ${step.by}°`;
      return step.selector ? `${selectorLabel(step.selector)} (${by})` : by;
    }
    case "snapshot":
      return step.cropOn ? `"${step.name}" cropOn ${selectorLabel(step.cropOn)}` : `"${step.name}"`;
    case "run":
      // The as-written path, so a report line shows exactly what the flow
      // references (`run ../shared/login.yaml`), not just the attribution stem.
      return step.flow;
    case "echo":
    case "tool":
      // Each carries its subject in a report field of its own (`message`,
      // `tool`) that renderers print in the target's place.
      return undefined;
    case "launch":
      // A launch's app id may be per-platform (`appIdForPlatform`), and a step
      // alone does not know the run device.
      return undefined;
    case "wait":
      return undefined;
    default: {
      const unclassified: never = step;
      void unclassified;
      return undefined;
    }
  }
}

/**
 * One `run:` chain entry: the cycle guard compares canonical (realpath'd)
 * paths; error messages render the human-readable display names.
 */
interface RunStackEntry {
  canonical: string;
  display: string;
}

/**
 * Where a list of steps executes: the `run:` chain (cycle/depth guards) plus
 * the display nesting depth. Attribution and anchor directory derive from the
 * chain's top entry ({@link scopeFlow} / {@link scopeFlowDir}), so no second
 * field can drift out of lockstep with the stack.
 */
interface StepScope {
  runStack: RunStackEntry[];
  depth: number;
}

/** The flow name steps in this scope are attributed to (StepReport.flow). */
function scopeFlow(scope: StepScope): string {
  return scope.runStack[scope.runStack.length - 1]!.display;
}

/**
 * The report attribution for a `run:` target: its basename stem
 * ({@link runTargetName}), except when that stem equals the ROOT flow's name —
 * then the as-written path with the `.yaml` extension stripped, or `./<stem>`
 * when the spelling is bare (stripping would reproduce the stem). Two
 * different files may legitimately share a stem (e.g. root `login.yaml`
 * composing `helpers/login.yaml`), and a bare-stem attribution there would
 * make `StepReport.flow` equal the report's top-level `flow`, so renderers
 * that mark fragment steps by that inequality (the CLI's `[fragment]` suffix)
 * would silently read the fragment's failures as the root flow's. The
 * as-written path keeps the distinguishing directory component. A bare
 * spelling has none to keep, yet still names a genuine different file when
 * written in a nested fragment (`run: login.yaml` inside `helpers/steps.yaml`
 * resolves against the CONTAINING file's dir — `helpers/login.yaml`), so it
 * gets the equivalent spelling `./<stem>`. Only against the root is the
 * comparison needed, because that is the one name downstream consumers
 * compare against — and the inequality is guaranteed: both disambiguated
 * shapes contain a `/`, which FLOW_NAME_PATTERN forbids in the root's name.
 */
function runDisplayName(target: string, scope: StepScope): string {
  return runDisplayFor(target, scope.runStack[0]!.display);
}

/**
 * {@link runDisplayName} against a root name rather than a scope, so
 * {@link scanLeadingLaunch} — which walks the same chain before any scope
 * exists — attributes a hop exactly as the executor will.
 */
function runDisplayFor(target: string, rootDisplay: string): string {
  const stem = runTargetName(target);
  if (stem !== rootDisplay) return stem;
  // Parse guarantees the target ends in lowercase ".yaml", so slicing the
  // extension off never truncates a real path segment.
  const spelled = target.slice(0, -".yaml".length);
  return spelled === stem ? `./${stem}` : spelled;
}

/**
 * Attribution for one report line: a `run:` step belongs to the fragment it
 * references ({@link runDisplayName}) — identical across the executed,
 * errored, and every skip path — everything else to the containing flow.
 */
function stepFlow(step: FlowStep, scope: StepScope): string {
  return step.kind === "run" ? runDisplayName(step.flow, scope) : scopeFlow(scope);
}

/**
 * The directory `run:` paths resolve against — the canonical containing
 * file's, so a symlinked flow anchors where its real file and siblings live.
 */
function scopeFlowDir(scope: StepScope): string {
  return path.dirname(scope.runStack[scope.runStack.length - 1]!.canonical);
}

/** The scope a nesting step's children execute in — one level deeper. */
function childScope(
  scope: StepScope,
  overrides: Partial<Omit<StepScope, "depth">> = {}
): StepScope {
  return { ...scope, ...overrides, depth: scope.depth + 1 };
}

/**
 * The depth stamp for a report — omitted at top level, so a flow with no
 * nesting steps produces a report byte-identical to the pre-depth shape.
 */
function depthOf(scope: StepScope): Pick<StepReport, "depth"> {
  return scope.depth ? { depth: scope.depth } : {};
}

/** Execute a list of steps, appending reports to state. Honors hard-stop + abort. */
async function execSteps(state: ExecState, steps: FlowStep[], scope: StepScope): Promise<void> {
  for (const step of steps) {
    const index = state.reports.length;

    if (state.stopped) {
      pushReport(state, {
        index,
        kind: step.kind,
        status: "skip",
        flow: stepFlow(step, scope),
        target: stepTarget(step),
        ...depthOf(scope),
        // Carry the echo's message so a skipped narration renders as a skip
        // line rather than vanishing — matching reportBlockSkipped.
        ...(step.kind === "echo" ? { message: step.message } : {}),
      });
      // A block directive's literal steps are known — expand them so the report
      // keeps one line per authored step no matter where the stop landed.
      const inner = blockSteps(step);
      if (inner) reportBlockSkipped(state, inner, childScope(scope));
      continue;
    }
    // The flow was resolved as needing no device, yet a step that acts on one
    // reached execution — the two decisions disagree. Report it as this step's
    // error and stop, rather than letting it fail obscurely further in.
    // They cannot disagree today, nor for a future block directive whichever way
    // stepRequiresDevice classifies it — flowRequiresDevice recurses through
    // blockSteps, so no nesting hides a step: under `true` a device is resolved
    // and `!state.device` is false; under `false` this guard's own
    // stepRequiresDevice conjunct fails. The expansion below stays regardless.
    if (!state.device && stepRequiresDevice(state.registry, step)) {
      state.stopped = true;
      pushReport(state, {
        index,
        kind: step.kind,
        status: "error",
        flow: scopeFlow(scope),
        target: stepTarget(step),
        ...depthOf(scope),
        reason: `step needs a device but the flow was resolved as device-free — pass an explicit device`,
      });
      const inner = blockSteps(step);
      if (inner) reportBlockSkipped(state, inner, childScope(scope));
      continue;
    }
    if (state.signal?.aborted) {
      state.stopped = true;
      pushReport(state, {
        index,
        kind: step.kind,
        status: "skip",
        reason: "run aborted",
        flow: stepFlow(step, scope),
        target: stepTarget(step),
        ...depthOf(scope),
        ...(step.kind === "echo" ? { message: step.message } : {}),
      });
      const inner = blockSteps(step);
      if (inner) reportBlockSkipped(state, inner, childScope(scope), "run aborted");
      continue;
    }

    if (step.kind === "run") {
      await execRunStep(state, step, scope);
      continue;
    }
    if (isBlockStep(step)) {
      await execBlockStep(state, step, scope);
      continue;
    }

    const report = await execLeafStep(state, step, index, scope);
    pushReport(state, report);
    if (report.status === "fail" || report.status === "error") state.stopped = true;
  }
}

/** A compact rendering of a when guard for report reasons. */
function describeWhenCondition(cond: WhenCondition): string {
  if (cond.kind === "platform") return `platform ${cond.platform}`;
  return conditionLabel(cond, describeSelector);
}

/**
 * Report every step of a block directive that will not run as skipped — so a
 * run where the block was skipped (a `when:` guard unmet or errored, a hard
 * stop, a cancellation) produces the same report shape (one line per authored
 * step, at the same depth) as a run where it entered, and reports stay
 * comparable run-to-run. Nested blocks expand (their literal steps are known);
 * a `run:` composition stays one line, matching how post-hard-stop skips report
 * a fragment that was never loaded. `scope` is the scope the steps would have
 * executed in — already the block's child scope, not the marker's.
 */
function reportBlockSkipped(
  state: ExecState,
  steps: FlowStep[],
  scope: StepScope,
  reason?: string
): void {
  for (const step of steps) {
    pushReport(state, {
      index: state.reports.length,
      kind: step.kind,
      status: "skip",
      reason,
      flow: stepFlow(step, scope),
      target: stepTarget(step),
      ...depthOf(scope),
      ...(step.kind === "echo" ? { message: step.message } : {}),
    });
    const inner = blockSteps(step);
    if (inner) reportBlockSkipped(state, inner, childScope(scope), reason);
  }
}

/**
 * Dispatch a block directive to its executor. The `never` default arm is the
 * run-time site a kind registered in BLOCK_DIRECTIVE_KEYS cannot miss: an
 * unhandled registered kind fails tsc here instead of returning silently and
 * leaving the block out of the report entirely, not even its own marker.
 * Preventing execLeafStep's "unsupported step kind" error is the isBlockStep
 * gate's doing, not this arm's - a registered kind never reaches the leaf
 * switch. Binds `step.kind` rather than `step` - while the registry has one
 * entry BlockStep is not a union, so only the discriminant narrows to `never`.
 */
async function execBlockStep(state: ExecState, step: BlockStep, scope: StepScope): Promise<void> {
  switch (step.kind) {
    case "when":
      return execWhenStep(state, step, scope);
    default: {
      const unhandled: never = step.kind;
      void unhandled;
    }
  }
}

/**
 * Execute a `when:` block: evaluate the guard (a platform test is static; a UI
 * condition probes with the short assert grace), then either expand the
 * guarded steps inline — where failures are real failures, hard-stopping as
 * usual — or report the whole block as skipped. An unreadable tree errors the
 * step instead: "could not evaluate" is not "condition false", and silently
 * skipping would let a broken tree source turn every guarded dismissal into a
 * green no-op.
 */
async function execWhenStep(
  state: ExecState,
  step: Extract<FlowStep, { kind: "when" }>,
  scope: StepScope
): Promise<void> {
  const index = state.reports.length;
  const label = describeWhenCondition(step.condition);
  const target = stepTarget(step);
  // The marker sits at the enclosing depth; the guarded steps one deeper —
  // whether they execute or report as skipped.
  const marker = {
    index,
    kind: "when",
    flow: scopeFlow(scope),
    target,
    ...depthOf(scope),
  } as const;
  const inner = childScope(scope);

  let met: boolean;
  if (step.condition.kind === "platform") {
    // "ios-remote" is an iOS simulator driven through sim-remote — for a
    // platform guard it IS ios. The parser deliberately rejects "ios-remote"
    // as a guard spelling, so without this fold no guard could ever match on
    // a remote sim and iOS-only blocks would silently skip there.
    const guardEnv = deviceEnv(state);
    const platform = guardEnv.device.platform === "ios-remote" ? "ios" : guardEnv.device.platform;
    met = platform === step.condition.platform;
  } else {
    const probe = await probeWhenCondition(deviceEnv(state), step.condition);
    if (probe.aborted) {
      pushReport(state, { ...marker, status: "skip", reason: "run aborted" });
      reportBlockSkipped(state, step.steps, inner, "run aborted");
      return;
    }
    if (!probe.ok && probe.indeterminate) {
      pushReport(state, {
        ...marker,
        status: "error",
        reason: `could not evaluate when guard (${label}): ${probe.reason}`,
      });
      state.stopped = true;
      reportBlockSkipped(state, step.steps, inner, "when guard errored");
      return;
    }
    met = probe.ok;
  }

  if (!met) {
    const n = step.steps.length;
    pushReport(state, {
      ...marker,
      status: "skip",
      reason: `condition not met (${label}) — block skipped (${n} step${n === 1 ? "" : "s"})`,
    });
    reportBlockSkipped(state, step.steps, inner, "when block skipped");
    return;
  }

  // Marker for the block, then the guarded steps inline — same fragment
  // attribution, one level deeper, failures hard-stop as anywhere else.
  pushReport(state, { ...marker, status: "pass", reason: `condition met (${label})` });
  await execSteps(state, step.steps, inner);
}

/**
 * Canonicalize a flow path — the cycle guard's identity key and the root
 * anchor derivation (flowsDir + runStack seed). The input must arrive with
 * any `..` segments intact (no path.resolve/path.join over the string): a
 * `..` that follows a symlinked directory component names the parent of the
 * link's TARGET, which only the kernel can know — a lexical collapse first
 * silently picks a different file than the spelling denotes on disk.
 * fs/promises' realpath keeps kernel semantics (realpath(3), like callback
 * fs.realpath.native — unlike callback fs.realpath, which path.resolve()s
 * first), so handing it the un-collapsed string is sufficient. When realpath
 * fails (the file is gone), the containing directory is still kernel-resolved
 * before the basename is re-appended, so the subsequent read opens — and its
 * ENOENT names — the file the spelling denotes rather than a lexical collapse
 * that could name an existing impostor; when the directory chain itself is
 * broken (an intermediate component missing, or a dangling link followed by
 * `..`), the spelling is returned verbatim, so the read fails with the
 * kernel's ENOENT for the spelling itself instead of succeeding on a collapse
 * that happens to name an existing file. That failed read hard-stops the flow
 * before any runStack entry is pushed, so the verbatim key never reaches the
 * cycle guard (a genuine cycle needs a readable target, for which realpath
 * succeeds). Callers must pass an absolute path — every return value,
 * including the verbatim fallback, is consumed as absolute (readFile,
 * dirname-derived anchors) with no resolve step after this point; both call
 * sites satisfy this (the root path is validated absolute, and `run:` targets
 * are concatenated onto an absolute anchor).
 */
async function canonicalFlowPath(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    try {
      return path.join(await fs.realpath(path.dirname(p)), path.basename(p));
    } catch {
      return p;
    }
  }
}

/**
 * The `__baselines__/<segment>` a run's snapshots key their baseline store
 * under. The store is `<flowsDir>/__baselines__/<key>` and `flowsDir` is the
 * CANONICAL root flow's directory, so the key must name the canonical file too
 * — directory and name have to agree on which file they identify. With the
 * as-written stem they do not, and the disagreement merges distinct flows: two
 * projects whose `.argent/flows/smoke.yaml` are symlinks into one shared vault
 * (`vault/a-smoke.yaml`, `vault/b-smoke.yaml`) both anchor at `vault/` and both
 * key "smoke", so a single `vault/__baselines__/smoke/` holds one PNG the two
 * flows silently overwrite in turn — each `--update-baselines` run reporting
 * "baseline updated" while it actually replaced another project's reviewed,
 * committed baseline. The canonical stem separates them
 * (`__baselines__/a-smoke/`, `__baselines__/b-smoke/`). For a root flow that is
 * a regular file the canonical stem IS the as-written one, so nothing moves for
 * the common case; only symlinked roots do.
 *
 * The canonical stem is the symlink TARGET's filename, and nothing has ever
 * validated that: `assertSafeFlowName` and `classifyOnDiskSpelling` only run
 * against the as-written spelling, so a vault file may legitimately be called
 * `my.smoke.yaml`, `A Smoke.yaml`, or `...yaml` — whose stem after `.yaml` is
 * `..`, and `path.join(flowsDir, "__baselines__", "..")` IS `flowsDir`: every
 * baseline would be written beside the flow files themselves, outside
 * `__baselines__/` entirely (the escape `flow-path-baseline-escape.test.ts`
 * pins for the as-written spelling). Hence the pattern check, against the same
 * charset every other flow name is held to. An unsafe stem falls back to the
 * as-written `flowName`, which is always validated, rather than throwing: an
 * unusually named vault file is not the caller's error to fix mid-run, the
 * collision this prevents is a shared-vault edge case, and the fallback is
 * exactly the behaviour that shipped before.
 */
function baselineKeyFor(canonicalPath: string, flowName: string): string {
  // path.basename leaves a bare ".yaml" intact (stripping it would leave
  // nothing) — the pattern rejects that spelling too, so it falls back as well.
  const stem = path.basename(canonicalPath, ".yaml");
  return FLOW_NAME_PATTERN.test(stem) ? stem : flowName;
}

async function execRunStep(
  state: ExecState,
  step: Extract<FlowStep, { kind: "run" }>,
  scope: StepScope
): Promise<void> {
  const index = state.reports.length;
  const target = step.flow;
  // Shared with stepFlow so the marker/error reports here and every skip path
  // there attribute the same run: step identically; the fragment's expanded
  // steps inherit it through the runStack entry pushed below.
  const display = runDisplayName(target, scope);

  const fail = (reason: string): void => {
    pushReport(state, {
      index,
      kind: "run",
      status: "error",
      flow: display,
      target,
      reason,
      ...depthOf(scope),
    });
    state.stopped = true;
  };

  // The cycle guard deliberately runs before the depth guard. A loop that
  // happens to close on the MAX_RUN_DEPTH-th hop is still a loop, and reporting
  // it as "max run depth exceeded" would send the author looking for excessive
  // nesting instead of the repeated reference — and would drop the chain, which
  // is the one piece of output that identifies the offending edge. The cost is
  // one extra realpath on the max-depth path; the depth guard immediately below
  // still stops the recursion, so nothing runs away.
  //
  // Joined by concatenation, NOT path.resolve/path.join: those collapse a `..`
  // lexically before the kernel ever sees the spelling, and parseRunTarget
  // deliberately admits `..` (shared fragments may live outside the flows
  // dir) — after a symlinked directory component the collapse names a
  // different file than the one on disk (see canonicalFlowPath). The anchor
  // is absolute and the target relative, so the concatenation is well-formed.
  const canonical = await canonicalFlowPath(scopeFlowDir(scope) + path.sep + target);
  if (scope.runStack.some((entry) => entry.canonical === canonical)) {
    return fail(
      `cyclic flow reference: ${[...scope.runStack.map((entry) => entry.display), display].join(" → ")}`
    );
  }

  if (scope.runStack.length >= MAX_RUN_DEPTH) {
    return fail("max run depth exceeded");
  }

  // Nothing above consulted the directory: canonicalFlowPath resolves the
  // spelling by the FILESYSTEM's rules, and a case-insensitive one (APFS,
  // NTFS) opens a file really named "frag.yaml" for `run: Frag.yaml`. The read
  // below then succeeds, every expanded step is attributed to a fragment named
  // "Frag" that no directory entry carries, and the identical tree fails with
  // ENOENT the moment it lands on a case-sensitive volume (Linux CI) — green
  // on the author's macOS, red in CI, for a reason nothing in the flow file
  // expresses. parseRunTarget already holds this line for the ".yaml"
  // extension of this same string, and resolveFlowSource holds it for the root
  // flow's own basename; the fragment basename was the last unchecked
  // spelling. Only a case-folded verdict refuses: a basename matching nothing
  // at all is an ordinary missing fragment, which the read's own per-file
  // ENOENT reports far better than a casing complaint could, and an unreadable
  // listing vouches for nothing so it must refuse nothing.
  //
  // Listed against the directory the target is SPELLED in — NOT
  // path.dirname(canonical): realpath rewrites a symlinked fragment to its
  // target's name, so `run: alias.yaml` (alias.yaml → a.yaml) — a legitimate
  // layout the cycle guard already relies on — would be refused for not being
  // named "a.yaml". That directory is the same concatenation canonicalized
  // above with only the final segment dropped: path.dirname removes a segment,
  // it does not collapse `..`, so a `..` in the target still reaches readdir
  // intact for the kernel to resolve (a lexical collapse here would list a
  // different directory than the one the read opens, exactly the split
  // canonicalFlowPath exists to avoid). Only the basename is checked, matching
  // the two root-flow routes' scope — validating every directory component of
  // a cross-directory target is a different and much larger contract.
  const suppliedBase = path.posix.basename(target);
  const spelling = await classifyOnDiskSpelling(
    path.dirname(scopeFlowDir(scope) + path.sep + target),
    suppliedBase
  );
  if (spelling.state === "case_folded") {
    // Quote a replacement target only when parseRunTarget would accept one —
    // `addressable` tests the same FLOW_FILE_NAME_PATTERN that gate applies to
    // a run: basename — keeping the target's own directory prefix so the hint
    // is the line the author can paste. An on-disk ".YAML" is reachable by no
    // run: target at all (the extension gate refuses it), so that fork asks
    // for the rename it really needs.
    const recovery = spelling.addressable
      ? `reference it as "${target.slice(0, target.length - suppliedBase.length)}${spelling.actual}"`
      : `rename "${spelling.actual}" to "${suppliedBase}" to compose it — flow files must be ` +
        `lowercase .yaml`;
    return fail(
      `mis-cased fragment reference "${target}": no directory entry is named "${suppliedBase}" ` +
        `(this filesystem matched it case-insensitively to "${spelling.actual}"), so the fragment ` +
        `name keying its step reports is one nothing on disk carries and a case-sensitive ` +
        `checkout could not find the file at all — ${recovery}`
    );
  }

  // There is deliberately NO path fence between here and the read. A `run:`
  // target is reachable exactly when the tool-server user can read it, which
  // is the same reach the front door already grants: an operator can point
  // flow_path at any YAML on the host (see resolveFlowSource), so restricting
  // composition below that only breaks documented layouts — a fragment shared
  // sideways (`../shared/login.yaml`), and a flows dir symlinked to a tree
  // kept outside the project, whose fragments must be able to reach their own
  // siblings more than one level down. The one route that carries untrusted
  // content, an uploaded flow, never arrives here at all:
  // assertUploadSelfContained rejects every `run:` step on that path.
  let fragment: FlowFile;
  try {
    fragment = parseFlow(await fs.readFile(canonical, "utf8"));
  } catch (err) {
    return fail(`could not load fragment "${target}": ${errMsg(err)}`);
  }

  // Marker for the composition point, then expand the fragment's steps inline,
  // one level deeper, attributed to the fragment. The fragment's own directory
  // becomes the anchor for `run:` paths inside it; baselines stay anchored to
  // the root flow (state.flowsDir / state.baselineKey).
  pushReport(state, {
    index,
    kind: "run",
    status: "pass",
    flow: display,
    target,
    ...depthOf(scope),
  });
  await execSteps(
    state,
    fragment.steps,
    childScope(scope, { runStack: [...scope.runStack, { canonical, display }] })
  );
}

async function execLeafStep(
  state: ExecState,
  step: FlowStep,
  index: number,
  scope: StepScope
): Promise<StepReport> {
  const base = {
    index,
    kind: step.kind,
    flow: scopeFlow(scope),
    target: stepTarget(step),
    ...depthOf(scope),
  } as const;
  const { registry, ctx, device, signal } = state;

  switch (step.kind) {
    case "echo":
      return { ...base, status: "pass", message: step.message };

    case "launch": {
      const r = await runLaunch(state, step.app);
      // A run cancelled mid-launch is a skip (matching the pre-step guard and
      // the directives), never a step failure — the app did nothing wrong.
      if (r.aborted) return { ...base, status: "skip", reason: r.reason };
      return { ...base, status: r.ok ? "pass" : "error", reason: r.reason };
    }

    case "tap":
    case "long-press":
    case "type":
    case "await":
    case "assert":
    case "idle":
    case "scroll-to":
    case "pinch":
    case "rotate": {
      // A directive that *throws* (vs. reporting a failed outcome) — e.g. a
      // touch gesture on a focus-driven TV target — must still land in the
      // structured report rather than abort the whole run unreported.
      try {
        const r = await runDirective(deviceEnv(state), step);
        // A run cancelled mid-directive is a skip (matching the pre-step guard
        // and `wait`), never a step failure — the app did nothing wrong.
        if (r.aborted) return { ...base, status: "skip", reason: r.reason };
        // `indeterminate` is `idle`'s only non-passing outcome: a screen that
        // merely kept moving passes with a warning, and so does one that
        // rendered nothing, so what is left here is a wait that could not run
        // at all — a tree source that failed, or one that answered and then
        // wedged. Scoring that `fail` would make CI
        // read an environment problem as a regression and a QA author reset a
        // pass streak over it. `error` keeps the run non-ok while saying
        // plainly that the app was never judged. Scoped to `idle`, whose whole
        // verdict rests on being able to observe the screen; the selector
        // conditions keep their existing `fail` mapping.
        if (!r.ok && r.indeterminate && step.kind === "idle") {
          return { ...base, status: "error", reason: r.reason };
        }
        return {
          ...base,
          status: r.ok ? "pass" : "fail",
          reason: r.reason,
          ...(r.warning !== undefined ? { warning: r.warning } : {}),
        };
      } catch (err) {
        return { ...base, status: "error", reason: errMsg(err) };
      }
    }

    case "wait": {
      if (!(await sleepOrAbort(step.ms, signal))) {
        return { ...base, status: "skip", reason: "run aborted during wait" };
      }
      return { ...base, status: "pass" };
    }

    case "snapshot": {
      try {
        const r = await runSnapshot(deviceEnv(state), {
          flowsDir: state.flowsDir,
          flowName: state.baselineKey,
          name: step.name,
          maxMismatch: step.maxMismatch ?? DEFAULT_MAX_MISMATCH,
          updateBaselines: state.updateBaselines,
          cropOn: step.cropOn,
          appIdentity: snapshotAppIdentity(state),
          seenKeys: state.snapshotApps,
        });
        return {
          ...base,
          status: r.status,
          reason: r.reason,
          snapshotKey: r.snapshotKey,
          artifacts: r.artifacts,
        };
      } catch (err) {
        return { ...base, status: "error", reason: errMsg(err) };
      }
    }

    case "tool": {
      // A device-less run reaches here only for a tool declaring none of
      // `DEVICE_ARG_KEYS` — a target key — so binding injects no target and
      // merely strips any device key the recorded args carried. The `?? ""` is
      // unreachable for those and must stay unreachable: injecting the empty
      // string would not fail the step, it would silently retarget it at no
      // device. A SCOPE key (`devices`) does reach here device-free, which is
      // the cleanup-flow case `bindDeviceArgs` guards by keeping whatever the
      // recording scoped — and, when the run device was only auto-detected, it
      // keeps that even with a device resolved.
      const args = bindDeviceArgs(
        registry,
        step.name,
        device?.id ?? "",
        step.args,
        state.deviceIsExplicit
      );
      const outputHint = registry.getTool(step.name)?.outputHint;
      if (step.delayMs && !(await sleepOrAbort(step.delayMs, signal))) {
        return { ...base, status: "skip", tool: step.name, reason: "run aborted during delay" };
      }
      try {
        // These sub-tools can change (or relaunch) the foreground app, so the
        // `launch:`-derived hint no longer names what is on screen, and a
        // relaunch is the repair a proven tree outage asks for by name - the
        // same clear `runLaunch` makes for the directive spelling. Cleared
        // BEFORE invoking: a tool that throws mid-way may still have switched
        // apps, and a stale hint is worse than no hint (tree reads fall back to
        // plain auto-resolution, today's behavior).
        if (FOREGROUND_CHANGING_TOOLS.has(step.name)) {
          state.launchedNativeApp = undefined;
          if (state.treeOutage) state.treeOutage.proven = undefined;
        }
        // A nested orchestrator runs its tools outside this run's holder -
        // `flow-execute` on an ExecState of its own, `run-sequence` on none -
        // so a tree read or relaunch inside it retires nothing here. Cleared
        // before the invoke for the same reason as above, and over-clearing
        // only costs a later gesture a window it would have skipped.
        if (isNestedOrchestratorTool(step.name) && state.treeOutage) {
          state.treeOutage.proven = undefined;
        }
        const result = await invokeSubTool(registry, ctx, step.name, args);
        if (isUnmetUiWaitResult(step.name, result)) {
          const note = (result as { note?: string }).note;
          return {
            ...base,
            status: "fail",
            tool: step.name,
            reason: `await-ui-element condition not met${note ? `: ${note}` : ""}`,
          };
        }
        // `flow-execute` and `run-sequence` run other tools and report what
        // happened in their result instead of throwing, so without this a
        // composition that failed everything counted as a passing step (#606).
        const nested = nestedOrchestratorOutcome(step.name, result);
        if (nested) {
          return {
            ...base,
            status: nested.status,
            tool: step.name,
            reason: nested.reason,
            result,
            outputHint,
            args,
          };
        }
        if (isDebuggerNotConnectedResult(step.name, result)) {
          // Keep `detail` in the report: it is the only place the underlying
          // error text lives (device_mismatch's guidance points the agent at
          // the logicalDeviceIds "listed in the detail message", and the
          // metro_not_running `got:` fragment names what actually answered the
          // port). And `note`, because the guidance that comes with one opens
          // by telling the reader to read it, and the CLI renders no tool-step
          // result at all — `renderStepLine` prints this string and nothing
          // else — so a pointer left in the result alone names a field nothing
          // there shows.
          return {
            ...base,
            status: "fail",
            tool: step.name,
            reason:
              `debugger not connected (${result.reason}): ${result.detail} — ${result.guidance}` +
              (result.note ? ` ${result.note}` : ``),
            result,
            outputHint,
            args,
          };
        }
        // Same hazard as the two above, on the native-devtools precheck: it
        // RESOLVES its block rather than throwing, so a step that never reached
        // the tool's work read as green — and a saved regression flow reported
        // `ok: true` for a native read that returned nothing. `launch:` already
        // guards its own `restart-app` (see runLaunch); this is the `tool:`
        // spelling of the same sub-tools, plus the six feature tools it never
        // covered.
        if (isNativeDevtoolsBlockResult(step.name, result)) {
          return {
            ...base,
            status: "fail",
            tool: step.name,
            reason: `${step.name} did not run (${result.status}): ${result.message}`,
            result,
            outputHint,
            args,
          };
        }
        // The launch-derived hint the clear above spent, restored for the two
        // tools whose args name the app they just started: they change WHICH
        // app is in front, not whether the run has one, so discarding the id
        // drops the iOS tree source back to auto-targeting's "Launch or restart
        // the app first" — the very advice the measured diagnosis replaces.
        // After the invoke, like `runLaunch`: a tool that threw started nothing.
        if (step.name === "launch-app" || step.name === "restart-app") {
          const launched = (args as { bundleId?: unknown }).bundleId;
          if (typeof launched === "string") state.launchedNativeApp = launched;
        }
        return { ...base, status: "pass", tool: step.name, result, outputHint, args };
      } catch (err) {
        return { ...base, status: "error", tool: step.name, reason: errMsg(err) };
      }
    }

    default:
      return { ...base, status: "error", reason: `unsupported step kind` };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resolve the flow YAML source a tool reads. An explicit `flow_path` is accepted
 * only when the file-input boundary resolved the exact client path in place on
 * this host AND matched the client-recorded stat (`statVerified`) — presence
 * alone is satisfiable by a hand-crafted stat-less wrapper, so it is not
 * containment. Uploaded explicit paths are rejected: the uploaded root YAML
 * would lose sibling `run:` files, baseline reads, and baseline write-back. A
 * remote `name` call uploads the same way and is accepted below, so this
 * rejection does not make composition or baselines work remotely — it only
 * keeps `flow_path`, whose whole contract is that those resolve beside the
 * caller's YAML, from silently meaning a temp directory instead. A raw
 * `flow_path` is also rejected even if the file exists, so callers cannot
 * bypass the boundary and read arbitrary server files.
 *
 * With no `flow_path` or `flow_file`, derive the saved-flow path from
 * project_root + name. When `flow_file` is set it must be one of the two shapes
 * its existing file-input boundary legitimately produces: the exact
 * `${project_root}/.argent/flows/${name}.yaml` path (co-located client,
 * resolved in place), or a temp file THIS server materialized from uploaded
 * content (`fileInput.viaUpload` — remote client). Anything else is rejected:
 * the schema marks `flow_file` internal, and honoring an arbitrary path would
 * let a caller execute (and, under --update-baselines, write PNGs next to) any
 * YAML on the host through a parameter no caller is supposed to set. Naming a
 * file outside the flows dir has exactly one legitimate spelling — `flow_path`,
 * gated above on the file-input boundary having resolved and stat-matched the
 * caller's own path — and this branch must not become a second one that skips
 * that gate. The logical flow name for an explicit path comes from the
 * caller-visible YAML basename recorded by the boundary. Either source's flow
 * name must then appear in that flow's own directory listing byte-for-byte — a
 * case-insensitive filesystem opens files under spellings no directory entry
 * carries, and the name is what keys the report and `__baselines__/` (see
 * {@link classifyOnDiskSpelling}). Name is validated on the branch that has one;
 * project_root is validated up front, before either branch, since only the
 * `name` branch would otherwise reach a check.
 *
 * Resolution is pure: it reads and mutates no shared state, so replaying a flow
 * in one project can never rebind the paths of a recording in progress in
 * another (or in the same project on another agent).
 */
export async function resolveFlowSource(
  params: {
    name?: string;
    project_root: string;
    flow_file?: string;
    flow_path?: string;
  },
  fileInput?: ResolvedFileInput,
  flowPathInput?: ResolvedFileInput
): Promise<{ filePath: string; flowName: string; viaUpload: boolean }> {
  // The schemas' superRefine already enforces this for flow-execute and
  // flow-read-prerequisite; this copy covers direct execute() callers (tests,
  // in-process invocations) and keeps the params.name! below sound.
  if ((params.name === undefined) === (params.flow_path === undefined)) {
    throw new FailureError("Pass exactly one flow source: name or flow_path.", {
      error_code: FAILURE_CODES.FLOW_FILE_INVALID,
      failure_stage: "flow_source",
      failure_area: "tool_server",
      error_kind: "validation",
    });
  }

  // Before either branch, so both are covered. `getFlowPath` validates the root
  // on the `name` branch only, and deleting `setActiveProjectRoot` — which ran
  // here, unconditionally, and whose body is today's assertValidProjectRoot —
  // removed the check on the `flow_path` branch entirely, letting relative and
  // ".."-bearing roots through. Nothing reads project_root on that branch
  // today, so this restores a guardrail rather than fixing a live exploit; it
  // is here so a future reader of it does not have to establish that.
  assertValidProjectRoot(params.project_root);

  if (params.flow_path !== undefined) {
    if (flowPathInput?.viaUpload) {
      throw new FailureError(
        `Invalid flow_path "${flowPathInput.clientPath}": explicit flow paths require a ` +
          `co-located client and tool server with a shared filesystem, and this one arrived as ` +
          `an upload — sibling run: files, baselines, and baseline write-back all resolve beside ` +
          `the copy this server materialized, alone in a temp directory. Pass name + ` +
          `project_root to run a self-contained flow from a remote client; name uploads the same ` +
          `way, so a flow with run: or snapshot: steps needs the client and tool server on one ` +
          `filesystem.`,
        {
          error_code: FAILURE_CODES.FLOW_FILE_INVALID,
          failure_stage: "flow_path_shared_filesystem",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }

    // The last conjunct is not containment — over HTTP both sides come from the
    // same wire path (file-inputs.ts). It ties the string returned below to the
    // one the extension/name checks read, so no caller can have them validate a
    // different file than the one that gets opened.
    const isVerifiedHostPath =
      flowPathInput?.presentOnHost === true &&
      flowPathInput.statVerified === true &&
      path.resolve(params.flow_path) === path.resolve(flowPathInput.clientPath);

    if (!isVerifiedHostPath) {
      throw new FailureError(
        `Invalid flow_path "${params.flow_path}": explicit flow paths must be supplied through ` +
          `the flow_path file-input boundary. Pass the client-local path and let the argent ` +
          `client resolve it.`,
        {
          error_code: FAILURE_CODES.FLOW_FILE_INVALID,
          failure_stage: "flow_path_boundary",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }

    // The two rules below are about the shape of the path string itself, not
    // about how it reached us, so they are reported apart from the boundary
    // gate above — a caller that did use the boundary must not be told to use
    // the boundary.

    // Reject a relative path: this string seeds canonicalFlowPath in
    // execute(), which requires an absolute input — its realpath, the read,
    // and every root anchor derived from the one canonical result (flowsDir
    // for baselines, baseline write-back, and a relative chromium app path;
    // the runStack seed for run:
    // targets) would otherwise resolve against the tool server's working
    // directory, which is not the caller's. `argent flow list` prints
    // repo-relative paths, so this is the spelling an agent is most likely to
    // pass back.
    if (!path.isAbsolute(params.flow_path)) {
      throw new FailureError(
        `Invalid flow_path "${params.flow_path}": flow paths must be absolute — a relative path ` +
          `is resolved against the tool server's working directory, not the caller's. Pass the ` +
          `absolute path to the flow's YAML.`,
        {
          error_code: FAILURE_CODES.FLOW_FILE_INVALID,
          failure_stage: "flow_path_absolute",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }

    // Reject ".." segments: execute() canonicalizes this path ONCE with
    // kernel semantics (canonicalFlowPath) and derives the read, flowsDir,
    // and the runStack seed from that one result, so a ".." spelling can no
    // longer split the read from its anchors. What it still can do is carry
    // two readings — after a symlinked component, the kernel's ".." and a
    // lexical collapse name different files, and the runner would silently
    // follow the kernel's — or, when the directory chain is broken, slip
    // through canonicalFlowPath's verbatim fallback to fail later as a raw
    // readFile ENOENT on the unresolved spelling. Rejecting up front means
    // every admitted flow_path has exactly one reading, and the unresolved
    // one fails here with a precise validation error instead. The argent
    // client rejects ".." segments before sending; only a direct MCP/HTTP
    // caller can pass an unresolved flow_path.
    if (params.flow_path.split(/[\\/]+/).includes("..")) {
      throw new FailureError(
        `Invalid flow_path "${params.flow_path}": flow paths must not contain ".." segments — ` +
          `a ".." after a symlinked directory can name a different file than the spelling ` +
          `suggests, and the argent client always sends fully resolved paths. Pass the fully ` +
          `resolved absolute path to the flow's YAML.`,
        {
          error_code: FAILURE_CODES.FLOW_FILE_INVALID,
          failure_stage: "flow_path_dotdot",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }

    const clientPath = flowPathInput!.clientPath;
    const clientExt = path.extname(clientPath);
    // path.extname reads a basename that is only the extension as an
    // extensionless dotfile, so clientExt is "" for ".yaml" (and ".YAML") and
    // the arms below would blame the extension of a path that visibly ends in
    // .yaml. What is actually missing is the filename stem — fall past this
    // check and let assertSafeFlowName name it, the way the CLI does.
    const bareExtension = path.basename(clientPath).toLowerCase() === ".yaml";
    if (!bareExtension && clientExt !== ".yaml") {
      // On case-insensitive filesystems the path looks valid to the user, so name the real problem.
      const detail =
        clientExt.toLowerCase() === ".yaml"
          ? `flow files must use the lowercase .yaml extension, not "${clientExt}".`
          : `flow files must use the .yaml extension.`;
      throw new FailureError(`Invalid flow_path "${clientPath}": ${detail}`, {
        error_code: FAILURE_CODES.FLOW_FILE_INVALID,
        failure_stage: "flow_path_extension",
        failure_area: "tool_server",
        error_kind: "validation",
      });
    }
    // basename leaves a suffix in place when stripping it would leave nothing,
    // and strips only an exact-case one — so both ".yaml" and ".YAML" would
    // otherwise be reported as a flow *named* that, not as a missing stem.
    const flowName = bareExtension ? "" : path.basename(clientPath, ".yaml");
    assertSafeFlowName(flowName);

    // The boundary's stat matched the basename by the filesystem's rules,
    // which on a case-insensitive filesystem (APFS, NTFS) finds a file really
    // named "uppercase.yaml" for "UpperCase.yaml" — every arm above would then
    // have validated a spelling that exists nowhere on disk, and the flow name
    // derived from it (which keys the report and __baselines__/) would be one
    // no directory entry carries: a baseline seeded under it is unfindable the
    // moment the tree lands on a case-sensitive volume. Require the supplied
    // basename to appear in the parent directory byte-for-byte. Absence from
    // the listing refuses either way here — unlike the name branch below, this
    // path arrives with the boundary's stat vouching for the file, so a
    // listing that lacks it entirely is the same phantom spelling, just
    // without a neighbour to name.
    const suppliedBase = path.basename(clientPath);
    const spelling = await classifyOnDiskSpelling(path.dirname(params.flow_path), suppliedBase);
    if (spelling.state !== "listed") {
      // Hint the real spelling only when this same ladder would accept it (a
      // stem-case slip like Checkout.yaml); an invalid real name (Upper.YAML)
      // needs a rename, and pointing at a flow_path the extension arm will
      // refuse helps no one.
      const recovery =
        spelling.state === "absent"
          ? `Pass the basename exactly as it appears on disk.`
          : spelling.addressable
            ? `Pass flow_path with the on-disk basename "${spelling.actual}".`
            : `Rename "${spelling.actual}" to "${suppliedBase}" to run it — flow files must be lowercase .yaml.`;
      throw new FailureError(
        `Invalid flow_path "${clientPath}": the file must be named as it appears on disk — this ` +
          `filesystem matched "${suppliedBase}" case-insensitively` +
          (spelling.state === "case_folded" ? ` to "${spelling.actual}"` : "") +
          `, so the flow name (which keys the report and __baselines__/) would be one no ` +
          `directory entry carries. ${recovery}`,
        {
          error_code: FAILURE_CODES.FLOW_FILE_INVALID,
          failure_stage: "flow_path_casing",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }

    return { filePath: params.flow_path, flowName, viaUpload: false };
  }

  const flowName = params.name!;
  assertSafeFlowName(flowName);
  const expected = getFlowPath(params.project_root, flowName);
  // A path the boundary materialized from uploaded content is a fresh temp
  // file this process itself created (see file-inputs.ts) — trusted as-is, and
  // returned ahead of the on-disk-spelling gate below deliberately: the only
  // directory there is to list is that temp dir, whose single entry this
  // server named from `name` itself, so the comparison could only ever agree
  // with itself. The listing that could disagree is the remote client's, on a
  // host this process cannot read — a mis-cased name on an uploading client
  // stays the client's to catch, and refusing here on the strength of whatever
  // happens to sit at the same path on THIS host would reject legitimate
  // remote runs. That temp dir is also what a run takes flowsDir from, so a
  // remote `name` run resolves `run:` targets and `__baselines__/` there and
  // finds neither — the flow's siblings never left the client. What this branch
  // buys a remote caller is a self-contained flow; one that composes or
  // snapshots fails against that temp dir, and the failure names it (a fragment
  // that could not be loaded, a baseline missing from a path under the system
  // temp dir) rather than the missing co-location that is the real cause.
  if (params.flow_file && fileInput?.viaUpload)
    return { filePath: params.flow_file, flowName, viaUpload: true };
  if (
    params.flow_file &&
    (!path.isAbsolute(params.flow_file) ||
      params.flow_file.split(/[\\/]+/).includes("..") ||
      path.resolve(params.flow_file) !== path.resolve(expected))
  ) {
    throw new FailureError(
      `Invalid flow_file "${params.flow_file}": it must resolve to the flow's path under the ` +
        `project root ("${expected}"). flow_file is internal — leave it unset and pass ` +
        `project_root + name.`,
      {
        error_code: FAILURE_CODES.FLOW_FILE_INVALID,
        failure_stage: "flow_file_containment",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }

  // Same invariant as the flow_path branch, on the route every remote/MCP
  // caller takes: nothing above consulted the directory, so on a
  // case-insensitive filesystem `name: "Snap"` opens a file really named
  // snap.yaml and then keys the report and __baselines__/ under "Snap" — a
  // directory no entry carries, whose baselines vanish the moment the tree
  // lands on a case-sensitive volume. Only a case-folded match refuses: a name
  // that matches nothing at all is an ordinary missing flow, and the read that
  // follows says so far better than a casing complaint would.
  const spelling = await classifyOnDiskSpelling(path.dirname(expected), `${flowName}.yaml`);
  if (spelling.state === "case_folded") {
    // Hand back a name only when one can reach the file: an on-disk .YAML is
    // addressable by no name at all (this branch always builds "<name>.yaml"),
    // it is omitted from `argent flow list`, and flow_path refuses it too — so
    // that fork asks for the rename it really needs.
    const recovery = spelling.addressable
      ? `Pass name "${path.basename(spelling.actual, ".yaml")}".`
      : `Rename "${spelling.actual}" to "${flowName}.yaml" to run it — flow files must be ` +
        `lowercase .yaml.`;
    throw new FailureError(
      `Invalid flow name "${flowName}": no saved flow is named "${flowName}.yaml" — this ` +
        `filesystem matched it case-insensitively to "${spelling.actual}", so the flow name ` +
        `(which keys the report and __baselines__/) would be one no directory entry carries. ` +
        recovery,
      {
        error_code: FAILURE_CODES.FLOW_NAME_INVALID,
        failure_stage: "flow_name_casing",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }

  // Either the boundary's own path for this flow (containment-checked above,
  // so it resolves to `expected`) or `expected` itself.
  return { filePath: params.flow_file || expected, flowName, viaUpload: false };
}
