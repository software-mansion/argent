import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  FAILURE_CODES,
  FailureError,
  FLOW_FILE_NAME_PATTERN,
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
  getFlowPath,
  isBlockStep,
  parseFlow,
  precedesLeadingLaunch,
  runTargetName,
  type BlockStep,
  type FlowFile,
  type FlowStep,
  type Launch,
  type ScriptEnv,
  SELECTABLE_PLATFORMS,
} from "./flow-utils";
import { createScriptLogBudget, type FlowScriptLogBudget } from "./script/flow-script-executor";
import { assertNoEnvOutputReferences } from "./flow-utils";
import { canonicalFlowPath, resolveFlowRelativeFile } from "./flow-file-refs";
import { runFlowScriptStep } from "./flow-script-step";
import { describeWhenCondition, stepTarget } from "./flow-step-definitions";
import {
  describeScriptEnvProblem,
  mergeScriptEnv,
  resolveScriptEnvSecrets,
  scriptEnvParameter,
} from "./script/flow-script-env";
import { createScriptRunNotes, type FlowScriptRunNotes } from "./script/flow-script-executor";
import { sleepOrAbort } from "../../utils/timing";
import { InvalidToolInputError } from "../../utils/capability";
import { invokeSubTool, describeNestedParamError } from "../../utils/sub-invoke";
import { iosDeviceRunnerRef } from "../../blueprints/ios-device-runner";
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
import { isIosPhysicalDevice, parseChromiumCdpPort, resolveDevice } from "../../utils/device-info";
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
        "Absolute path to the calling agent's project root — the cwd it is working in. With name, the saved flow is read from `.argent/flows/<name>.yaml` under this root; with flow_path, the flow, its run: siblings, its script: paths and baselines all resolve beside the YAML instead, so pass the agent's cwd. A script still RUNS in this root whichever source was used."
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
      .enum(SELECTABLE_PLATFORMS)
      .optional()
      .describe(
        "Restrict auto-detection to this platform when several devices are booted. `ios` selects local simulators only — pass `ios-remote` to select a remote one. `chromium` does more than filter: with no `device` it SELECTS the self-boot branch for an e2e flow - the runner boots an Electron instance from the `launch` step's chromium value and tears it down after the run (a single-key `launch: { chromium: … }` map selects it on its own, without this parameter). When it selects that branch it never falls back to device auto-detection (a fragment, or an e2e launch map with no `chromium` key, still does), and the launch value must be a real Electron app path on the tool-server host: a bare-string `launch:` - what the recorder writes - holds an installed-app bundle id, so passing `chromium` for one fails the whole run with `Electron boot: path does not exist`. Edit the launch to `{ chromium: <app path> }` first."
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
    env: scriptEnvParameter("This run's")
      .optional()
      .describe(
        "Environment values every `script` step in this run reads from its environment — `process.env` in a `.mjs`, `$NAME` in a `.sh` — through nested `run:` flows. This is what makes a flow reusable: the file holds the defaults a project checks in, and this map holds what changes per run (a build number, a staging URL, a per-run account), so no CI job has to edit the YAML. Values are strings — quote a number. A name must match [A-Za-z_][A-Za-z0-9_]* and must not be NODE_OPTIONS, NODE_CHANNEL_FD, NODE_UNIQUE_ID, NODE_CHANNEL_SERIALIZATION_MODE, ELECTRON_RUN_AS_NODE, ARGENT_FLOW_SCRIPT_RUNNER, or any npm spelling of npm_config_node-options / npm_config_userconfig / npm_config_globalconfig — each steers the runner's own process. ARGENT_OUTPUT is refused too: it names the file a `.sh` step exchanges its output document through, and this map reaches every step whatever its language. Do not send __proto__ either: it is an accessor rather than an entry, so `z.record` would rebuild the map without it and the call would pass with that one value silently missing — this parameter refuses the name instead. These OVERRIDE the flow file's own `env` defaults at every depth; a `script` step's own `env` still wins over them. " +
          "Put a credential behind `{{secret:<NAME>}}` rather than in the clear: a plaintext value in a tool call enters your context and ~/.argent/mcp-calls.log, which records every call whole. The placeholder is resolved on the machine running the tool-server, in this order: `ARGENT_SECRET_<NAME>`, the project's `.argent/secrets.env`, its `.env.local`/`.env` ARGENT_SECRET_-prefixed keys, then `~/.argent/secrets.env`. The PROJECT here is `project_root`, the same anchor the step resolves under. `keyboard` and `paste` take no project and read the two project files under the tool-server's own working directory, which is whatever spawned it - so on a host where that is `/` or your home directory, a name this map resolves may not resolve in a `type:` step. A name no source defines refuses THIS CALL before the run starts, unlike the same name in a flow file's own `env:`, which errors the step that reads it: this map is one argument rather than one flow's own text, so a run over a directory stops at the first flow instead of repeating the refusal once per file. " +
          "A shell `export` does NOT reach a script: the tool server's environment is a snapshot from its first start, so a value exported after it started is not in that snapshot at all. `scripts.env.allow` only widens which NAMES are copied out of it, so it cannot recover one — pass the value here, or in the flow's `env`, or restart the tool server."
      ),
  })
  .superRefine((params, ctx) => {
    if ((params.name === undefined) === (params.flow_path === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          params.name !== undefined
            ? "Pass exactly one flow source: name or flow_path."
            : "Pass exactly one flow source: name or flow_path. flow-execute needs the flow's " +
              "name in `name` — it resolves <project_root>/.argent/flows/<name>.yaml.",
        path: [],
      });
    }
  });

type Params = z.infer<typeof zodSchema>;

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
  reason?: string;
  warning?: string;
  tool?: string;
  result?: unknown;
  outputHint?: string;
  args?: unknown;
  message?: string;
  /**
   * The fragment a step belongs to (set on `run` and the steps it expands) —
   * the target's basename stem; when that stem collides with the top-level
   * flow's name, the as-written path minus `.yaml` (`./<stem>` for a bare
   * spelling). Renderers distinguish fragment steps by this differing from the
   * report's `flow`, which the collision fallback guarantees: both
   * disambiguated shapes contain a `/`, which FLOW_NAME_PATTERN forbids.
   */
  flow?: string;
  target?: string;
  snapshotKey?: string;
  artifacts?: SnapshotArtifacts;
  scriptLog?: string;
  scriptLogTruncated?: boolean;
  /**
   * Nesting depth for display: omitted at top level, +1 inside each nesting
   * step's expanded steps. The report is a flat list with no block-end marker,
   * so renderers cannot reconstruct depth downstream.
   */
  depth?: number;
}

export interface FlowRunResult {
  flow: string;
  device: string;
  executionPrerequisite: string;
  ok: boolean;
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

export const MAX_RUN_DEPTH = 20;

const POST_LAUNCH_SETTLE_MS = 1500;

/**
 * Flows resolve selectors against the native UIView tree, served over the
 * native-devtools connection the injected dylib opens asynchronously after
 * launch. `fetchFlowTree` treats a missing connection as a hard per-read error
 * (it never degrades to the collapsing AX tree — see flow-tree.ts), so without
 * this gate a slow cold start would fail the first directive with a raw
 * tree-source error instead of reporting it on the launch step.
 *
 * Deliberately the same constant as the budget the measurement allows a dial: a
 * gate that waited longer would time out onto `unregistered`, whose remedy is a
 * tool-server restart, for an app the state machine still considered worth
 * waiting for.
 *
 * Exported so the gate's reason text can be pinned against it.
 */
export const NATIVE_READY_TIMEOUT_MS = NATIVE_DEVTOOLS_CONNECT_BUDGET_MS;
const NATIVE_READY_POLL_MS = 250;

export const LAUNCH_TO_VERDICT_MS = POST_LAUNCH_SETTLE_MS + NATIVE_READY_TIMEOUT_MS;

/**
 * `tool:` steps that can change or relaunch the foreground app — running one
 * drops {@link ActionEnv.treeTarget} outright instead of keeping it as an
 * unpinned hint, since the launched app may no longer be on screen at all, and
 * spends {@link ActionEnv.treeOutage}. `button` is included for its `home` case;
 * distinguishing button kinds would couple this list to that tool's arg schema.
 *
 * `launch-app` and `restart-app` re-set the id from their own `bundleId` once
 * they return, as an unpinned hint — they name the app they switched to, where
 * the rest leave it unknown.
 */
const FOREGROUND_CHANGING_TOOLS = new Set([
  "launch-app",
  "restart-app",
  "reinstall-app",
  "open-url",
  "button",
]);

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
  // Timed out with no connection. An app the native tools refuse to target has
  // no hierarchy to wait for, so that is its expected outcome rather than a
  // launch failure; the refusal bites only where a selector needs the hierarchy,
  // and `fetchFlowTree` reports it there.
  //
  // The wait itself still runs, deliberately: whether the dylib loads into a
  // simulator system app is unsettled (#453 saw `connected: false` for
  // com.apple.Preferences on iOS 26.5, an E2E run `connected: true` on 18.5).
  // Only the VERDICT is withheld — before a measurement no arm below would
  // consult for such an app, costing several uninterruptible simctl round-trips.
  if (!isInjectableBundleId(bundleId)) return null;
  const state = await api.appConnectionState(bundleId).catch(() => "indeterminate" as const);
  if (state === "connected") return null;
  return flowLaunchGateReason(bundleId, state);
}

export function flowLaunchGateReason(
  bundleId: string,
  state: Exclude<NativeDevtoolsAppState, "connected">
): string {
  const measured = buildAppStateMessage(bundleId, state);
  switch (state) {
    case "not_running":
      return (
        `${bundleId} was relaunched by this step and is no longer running ${LAUNCH_TO_VERDICT_MS} ms later, ` +
        `so it exited after launch rather than failing to connect. Re-running the flow repeats the same launch: ` +
        `start it by hand (launch-app, then describe or screenshot) to see the crash or early exit first.`
      );
    case "stale_process":
      // The first sentence must not pick between the state's two producers: a
      // process carrying no argent injection at all, or one carrying THIS
      // endpoint and merely older than the listener — the measured text names
      // both, and blaming the launchd environment would be false for the second.
      // The environment IS right on a SECOND landing: a re-run's process is
      // younger than any long-up listener, which rules that producer out (it
      // needs `processAge + grace >= listenerAge`).
      return (
        `${measured} This step already relaunched it, so the process it measured predates whatever the ` +
        `relaunch would have given it — re-run the flow to launch again. If it lands here twice, the ` +
        `simulator's launchd environment is not holding argent's instrumentation: re-boot the device ` +
        `(boot-device with force) before re-running.`
      );
    case "unregistered":
      return (
        `${measured} A cold start slower than the ${LAUNCH_TO_VERDICT_MS} ms this step waited reads the ` +
        `same way — if that is likely, re-run the flow to relaunch and wait again before restarting anything.`
      );
    case "connecting":
      return (
        `${measured} This step launched it ${LAUNCH_TO_VERDICT_MS} ms before that reading, so the process ` +
        `being measured started after the step's own launch — something relaunched it in between. Re-run ` +
        `the flow once the app is settled.`
      );
    case "indeterminate":
      return (
        `${measured} This step already performed that one restart, so re-run the flow at most once more ` +
        `before restarting the tool-server rather than the app.`
      );
    case "provider_attached":
      return (
        `${measured} This step already waited ${LAUNCH_TO_VERDICT_MS} ms after launching it, so the ` +
        `provider is lending a different app rather than one still connecting. Re-run the flow only ` +
        `once it is lending this one; otherwise drive the app by coordinate.`
      );
  }
}

/**
 * Poll until the Vega automation toolkit — the only tree source on Vega —
 * serves a page source. Like iOS's injected dylib it attaches asynchronously at
 * app launch, and `describeVega` degrades to an empty tree + relaunch hint until
 * it does; gating the launch keeps that window from eating the first directive's
 * auto-wait (or silently confirming a `hidden` assert against a blind read).
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
 * asynchronously *after* launch), the Android helper is a separate
 * `am instrument` process the registry spawns synchronously on first
 * `resolveService`: one resolution either brings it up (install + spawn + ping
 * handshake in the factory) or it can't run on this device. Hence a one-shot
 * probe, not a poll.
 */
async function androidDevtoolsReady(registry: Registry, device: DeviceInfo): Promise<boolean> {
  try {
    const ref = androidDevtoolsRef(device);
    const api = await registry.resolveService<AndroidDevtoolsApi>(ref.urn, ref.options);
    return api.isReady();
  } catch {
    return false;
  }
}

async function treeSourceGate(
  registry: Registry,
  device: DeviceInfo,
  bundleId: string,
  signal?: AbortSignal
): Promise<string | null> {
  if (isIosPhysicalDevice(device) && !signal?.aborted) {
    try {
      const ref = iosDeviceRunnerRef(device);
      await registry.resolveService(ref.urn, ref.options);
      return null;
    } catch (err) {
      return (
        `the on-device XCUITest runner did not become ready for ${device.id}: ` +
        `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  if (device.platform === "ios" && !signal?.aborted) {
    const reason = await waitForNativeDevtools(registry, device, bundleId, signal);
    if (reason !== null && !signal?.aborted) {
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

async function runLaunch(state: ExecState, app: Launch): Promise<DirectiveOutcome> {
  const env = deviceEnv(state);
  const { registry, device, signal } = env;

  if (state.treeOutage) state.treeOutage.proven = undefined;

  if (device.platform === "chromium") return runChromiumLaunch(state, app);

  const bundleId = appIdForPlatform(app, device.platform);
  if (!bundleId) {
    return {
      ok: false,
      reason: `no app id declared for platform "${device.platform}" — add a launch entry for it`,
    };
  }
  state.treeTarget = undefined;
  let restart: unknown;
  try {
    restart = await invokeOnDevice(env, "restart-app", { bundleId });
  } catch (err) {
    if (signal?.aborted) return ABORTED_OUTCOME;
    return { ok: false, reason: `restart-app failed: ${errMsg(err)}` };
  }
  // A blocked precheck is RESOLVED rather than thrown, and returns before the
  // terminate and the launch — so the app was never started. Every remedy below
  // is written for one this step did launch: unread, the gate measures an app
  // that never ran and `not_running` becomes "it exited after launch".
  if (isNativeDevtoolsBlockResult("restart-app", restart)) {
    return { ok: false, reason: `restart-app did not start ${bundleId}: ${restart.message}` };
  }
  if (!(await sleepOrAbort(POST_LAUNCH_SETTLE_MS, signal))) return ABORTED_OUTCOME;
  const gate = await treeSourceGate(registry, device, bundleId, signal);
  if (signal?.aborted) return ABORTED_OUTCOME;
  if (gate) return { ok: false, reason: gate };
  // A FRESH object every time, never a mutation of the previous target: the
  // app just cold-started, so a re-pin has to re-arm `probeAnswered`.
  state.treeTarget = { bundleId, pinned: true, probeAnswered: false };
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
    const declared = await resolveAppPath(spec.path, state.flowsDir);
    if (declared !== owned.appPath) {
      return {
        ok: false,
        reason: `launch declares "${declared}" but the instance booted for this run is "${owned.appPath}" — the flow file changed after the run started`,
      };
    }
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
  const { registry, device, signal } = deviceEnv(state);

  const spec = chromiumLaunchSpec(app);
  if (!spec) return { ok: false, reason: noChromiumAppReason(device) };
  const appPath = await resolveAppPath(spec.path, state.flowsDir);
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
  state.owned.push(booted);
  state.device = resolveDevice(booted.deviceId);

  await frontChromiumPage(registry, state.device);
  if (!(await sleepOrAbort(POST_LAUNCH_SETTLE_MS, signal))) return ABORTED_OUTCOME;
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

const LOCK_SUSPECT_PROBE_TIMEOUT_MS = 800;

/**
 * The signal of a boot failure the underlying error cannot explain: an Electron
 * process that exits CLEANLY (code 0) before its CDP endpoint comes up — the
 * signature of a second copy quitting against an already-running instance's
 * single-instance lock. Null for every other failure, since a crash, missing
 * path, or spawn failure speaks for itself and a lock hint there would blame
 * the wrong app. The signal itself is returned, not a boolean, because the
 * hoist rethrows under it ({@link hoistedBootFailure}) and the reworded error
 * has to keep the `error_code` and exit-code metadata.
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

interface LockSuspects {
  attached: string | null;
  owned: BootedChromium[];
}

const NO_LOCK_SUSPECTS: LockSuspects = Object.freeze({ attached: null, owned: [] });

function singleInstanceLockHint(suspects: LockSuspects): string {
  const clauses: string[] = [];
  if (suspects.attached) {
    clauses.push(
      `${suspects.attached} is running and this run does not own it; if it is this same app, it holds that lock.`
    );
  }
  if (suspects.owned.length > 0) {
    const owned = suspects.owned.map((o) => `${o.deviceId} (${o.appPath})`).join(", ");
    clauses.push(
      `This run booted ${owned}, alive until run end — an app path that shares an Electron \`name\` with this one shares its lock. That holder is the runner's own, so closing it is not on offer and a rerun fails identically; launch them in separate runs, or give this launch its own \`--user-data-dir\` in \`args\`.`
    );
  }
  if (clauses.length === 0)
    clauses.push(`If a copy of this app is already running, close it and rerun.`);
  return `A clean exit before CDP comes up is the signature of a single-instance lock — an already-running copy of the app quits the new one at startup. ${clauses.join(" ")}`;
}

async function chromiumBootFailureReason(state: ExecState, err: unknown): Promise<string> {
  const base = `could not boot the chromium app: ${errMsg(err)}`;
  if (!singleInstanceLockSignal(err)) return base;
  return `${base} ${singleInstanceLockHint(await liveLockSuspects(state))}`;
}

async function liveLockSuspects(state: ExecState): Promise<LockSuspects> {
  const [attached, owned] = await Promise.all([
    liveAttachedInstance(state),
    liveOwnedInstances(state),
  ]);
  return { attached, owned };
}

async function liveAttachedInstance(state: ExecState): Promise<string | null> {
  const id = state.attachedDeviceId;
  if (id === undefined) return null;
  const port = parseChromiumCdpPort(id);
  if (port === null) return null;
  return (await answersCdp(port)) ? id : null;
}

async function liveOwnedInstances(state: ExecState): Promise<BootedChromium[]> {
  const alive = await Promise.all(state.owned.map((o) => answersCdp(o.port)));
  return state.owned.filter((_, i) => alive[i]);
}

async function answersCdp(port: number): Promise<boolean> {
  try {
    await ensureCdpReachable(port, AbortSignal.timeout(LOCK_SUSPECT_PROBE_TIMEOUT_MS));
    return true;
  } catch {
    return false;
  }
}

function ownedInstance(state: ExecState): BootedChromium | undefined {
  return state.owned.find((o) => o.deviceId === state.device?.id);
}

/**
 * App identity a snapshot capture is attributed to: the canonical app path of
 * the owned instance the run sits on, else the path the attaching launch
 * declared for the un-owned instance, else that instance's device id. The
 * declared path is trusted — the guard is best-effort collision detection, not
 * attestation — so an attach and a later boot of the same app spell one
 * identity. On ios/android the device never moves mid-run, so the guard stays
 * chromium-scoped in effect.
 */
function snapshotAppIdentity(state: ExecState): string {
  return (
    ownedInstance(state)?.appPath ??
    state.attachedAppPath ??
    `attached:${deviceEnv(state).device.id}`
  );
}

function noChromiumAppReason(device: DeviceInfo): string {
  return `no chromium app declared — the run is on ${device.id}; add a \`chromium:\` entry to this launch`;
}

interface ExecState extends Omit<ActionEnv, "device"> {
  device: DeviceInfo | null;
  deviceIsExplicit: boolean;
  flowsDir: string;
  viaUpload: boolean;
  baselineKey: string;
  updateBaselines: boolean;
  reports: StepReport[];
  stopped: boolean;
  pinned: boolean;
  owned: BootedChromium[];
  chromiumLaunched: boolean;
  snapshotApps: Map<string, string>;
  attachedDeviceId?: string;
  attachedAppPath?: string;
  projectRoot: string;
  scriptLogBudget: FlowScriptLogBudget;
  /**
   * The `env` map this CALL supplied, applying to every script step in the run
   * including those inside nested `run:` fragments. On the run rather than on a
   * scope because it is constant for the whole root run: a flow-level map is a
   * default at any depth, so this outranks even the innermost fragment's.
   */
  runtimeEnv: Readonly<ScriptEnv>;
  /**
   * Notes any script step has already carried in this run. A note about the
   * host's configuration is true of every step, so it is said once.
   */
  scriptRunNotes: FlowScriptRunNotes;
  onStepReport?: (report: StepReport) => void;
}

function deviceEnv(state: ExecState): ActionEnv {
  if (!state.device) {
    throw new Error("internal: a step that acts on a device ran in a flow resolved as device-free");
  }
  return { ...state, device: state.device };
}

interface BootedChromium {
  deviceId: string;
  port: number;
  pid: number;
  appPath: string;
}

function displayFlowName(params: { name?: string; flow_path?: string }): string {
  const stem =
    params.flow_path === undefined ? undefined : path.basename(params.flow_path, ".yaml");
  return params.name || stem || params.flow_path || "(unspecified)";
}

function* walkSteps(steps: FlowStep[], within = ""): Generator<{ step: FlowStep; where: string }> {
  for (const [i, step] of steps.entries()) {
    const where = `step ${i + 1}${within}`;
    yield { step, where };
    const inner = blockSteps(step);
    if (inner) yield* walkSteps(inner, ` of the ${step.kind}: block at ${where}`);
  }
}

interface RetiredArgUse {
  where: string;
  tool: string;
  key: string;
  guidance: string;
}

/**
 * The guidance a schema property carries if - and only if - it is a RETIRED
 * field, else undefined (an empty string is retired with no guidance).
 *
 * A retired field is declared `z.never().optional()`, which serializes to a
 * `not: {}` with no `type`. Matched by SHAPE and never by field name, so a key
 * retired on any tool later is refused with no edit here - the same test
 * `isRetiredField` applies on the CLI's flag paths.
 */
function retiredKeyGuidance(prop: unknown): string | undefined {
  const schema = prop as { not?: Record<string, unknown>; description?: string } | undefined;
  if (!schema?.not || Object.keys(schema.not).length > 0) return undefined;
  return (schema.description ?? "").replace(/^Retired:\s*/, "");
}

function toolArgProps(registry: Registry, tool: string): Record<string, unknown> | undefined {
  return (
    registry.getTool(tool)?.inputSchema as { properties?: Record<string, unknown> } | undefined
  )?.properties;
}

function retiredArgIn(
  props: Record<string, unknown>,
  tool: string,
  args: Record<string, unknown>,
  where: string
): RetiredArgUse | undefined {
  for (const key of Object.keys(args)) {
    const guidance = retiredKeyGuidance(props[key]);
    if (guidance !== undefined) return { where, tool, key, guidance };
  }
  return undefined;
}

/**
 * The tool invocations a `tool:` step's args carry inline, each with the
 * position naming it. Matched by SHAPE - a `{ tool, args }` entry, in an arg's
 * array (run-sequence's `steps`) or as an arg itself - never by the carrying
 * tool's name.
 *
 * Only under a key the carrying tool DECLARES: a non-strict schema strips an
 * undeclared key before execute, so the invocation it looks like is never made
 * and refusing the flow over it would refuse a call that never happens.
 *
 * One level only: those args are forwarded verbatim to the named tool, and no
 * tool that batches others allows a batching tool among them.
 */
function* nestedInvocations(
  props: Record<string, unknown>,
  args: Record<string, unknown>
): Generator<{ tool: string; args: Record<string, unknown>; at: string }> {
  for (const [key, value] of Object.entries(args)) {
    if (!Object.hasOwn(props, key)) continue;
    const entries = Array.isArray(value) ? value : [value];
    for (const [i, entry] of entries.entries()) {
      const call = entry as { tool?: unknown; args?: unknown } | null | undefined;
      if (typeof call?.tool !== "string") continue;
      if (typeof call.args !== "object" || call.args === null || Array.isArray(call.args)) continue;
      yield {
        tool: call.tool,
        args: call.args as Record<string, unknown>,
        at: Array.isArray(value) ? `step ${i + 1}` : `\`${key}\``,
      };
    }
  }
}

function findRetiredToolArg(registry: Registry, steps: FlowStep[]): RetiredArgUse | undefined {
  for (const { step, where } of walkSteps(steps)) {
    if (step.kind !== "tool") continue;
    const props = toolArgProps(registry, step.name);
    if (!props) continue;
    const direct = retiredArgIn(props, step.name, step.args, where);
    if (direct) return direct;
    for (const call of nestedInvocations(props, step.args)) {
      const nestedProps = toolArgProps(registry, call.tool);
      if (!nestedProps) continue;
      const hit = retiredArgIn(
        nestedProps,
        call.tool,
        call.args,
        `${call.at} of the ${step.name} step at ${where}`
      );
      if (hit) return hit;
    }
  }
  return undefined;
}

function retiredArgReason(use: RetiredArgUse): string {
  return `${use.where} as written (echo included) passes ${use.tool}'s retired \`${use.key}\` key${use.guidance ? `: ${use.guidance}` : ""}`;
}

/**
 * Reject an uploaded root flow that is not self-contained — one with a `run:`,
 * `script:` or `snapshot` step at any depth — before anything executes, so a
 * mid-run or guard-gated error cannot execute half the flow first. All three
 * anchor at the flow file's real directory, which an uploaded flow does not
 * have: a run: step's referenced files stayed on the client, a script step's
 * own file (and whatever it imports) stayed there too, and against a per-call temp
 * materialization a plain snapshot can only fail (no baseline) while
 * updateBaselines writes PNGs no later run can find.
 */
function assertUploadSelfContained(flow: FlowFile): void {
  for (const { step } of walkSteps(flow.steps)) {
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
    if (step.kind === "script") {
      throw new FailureError(
        `This flow uses a script step ("script: { path: ${step.path} }"), whose script file lives ` +
          `beside the flow's file on the CLIENT — an uploaded flow carries only its own YAML, so ` +
          `the script is not on this host and never could be. Use name + project_root with a ` +
          `co-located client and tool server for flows that run scripts.`,
        {
          error_code: FAILURE_CODES.FLOW_FILE_INVALID,
          failure_stage: "flow_upload_script_step",
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
    description: `Run a saved YAML flow end to end. Use when
asked to replay a recorded path, re-run a QA regression, or check that a known journey still passes; for a
one-off interaction use the gesture tools instead, and to author a flow use flow-start-recording. Pass
exactly one flow source: name (under project_root) or flow_path.
Returns a per-step report: the first failure stops the run and the rest report as skipped.`,
    longRunning: true,
    zodSchema,
    fileInputs,
    services: () => ({}),
    async execute(_services, params, ctx?: ToolContext) {
      // The run-time map is judged here rather than by the schema, which takes
      // it as a plain map of strings and stops there. A NAME the operating
      // system cannot carry, or one that steers the runner's own process, is
      // the same mistake wherever the map came from and reads best against one
      // rule — the same one a flow file's own `env:` is held to.
      const envProblem = describeScriptEnvProblem(params.env ?? {});
      if (envProblem) {
        // Named after the channel it came from, as the other two are — the flow
        // file says `Invalid flow file: \`env\`` and a step says
        // `script \`env\``. A bare \`env\` on a flow that also declares a
        // top-level one sends the author to the YAML for a name they typed on
        // the command line.
        throw new InvalidToolInputError(`This run's \`env\` ${envProblem}`, {
          failure_stage: "flow_run_env",
        });
      }
      // The same refusal a flow file's own `env` earns, on the channel a CI job
      // and an agent both use. Without it the reference reaches the script as
      // literal text and the step reports pass — the outcome that refusal is
      // written to prevent. Re-raised as caller input, like the check above it:
      // the shared refusal is worded for a flow FILE and classified as one, and
      // this is the same parameter.
      try {
        assertNoEnvOutputReferences(params.env, "This run's");
      } catch (err) {
        throw new InvalidToolInputError(err instanceof Error ? err.message : String(err), {
          failure_stage: "flow_run_env",
        });
      }
      // And the `{{secret:NAME}}` names of that same map, resolved here only to
      // be refused here. A name no source defines is a fault in the ARGUMENT,
      // and every flow in a directory run takes the same arguments apart from
      // its own path — so left to the step it became one ~900-character refusal
      // per file, and a run of N flows ended `0 passed, N failed` for one
      // mistyped name. Raised as caller input, the run stops at the first flow,
      // which is what the two checks above it already do for a bad NAME.
      //
      // The step resolves again and is still the authority: this reads the
      // run's own map only, holds nothing it resolved, and passes the same
      // project anchor the step will. A flow file's own `env:` is a fault in
      // that FILE and is left to the step, where it stays one flow's problem.
      if (params.env && Object.keys(params.env).length > 0) {
        try {
          resolveScriptEnvSecrets(params.env, { cwd: params.project_root });
        } catch (err) {
          throw new InvalidToolInputError(
            `This run's ${err instanceof Error ? err.message : String(err)}`,
            { failure_stage: "flow_run_env" }
          );
        }
      }
      const signal = ctx?.signal;
      const { filePath, flowName, viaUpload } = await resolveFlowSource(
        params,
        ctx?.fileInputs?.flow_file,
        ctx?.fileInputs?.flow_path
      );
      const canonicalPath = await canonicalFlowPath(filePath);
      const flowsDir = path.dirname(canonicalPath);
      const flow = parseFlow(await fs.readFile(canonicalPath, "utf8"));
      if (viaUpload) assertUploadSelfContained(flow);
      const retiredArg = findRetiredToolArg(registry, flow.steps);
      if (retiredArg) {
        throw new FailureError(`Flow "${flowName}" ${retiredArgReason(retiredArg)}`, {
          error_code: FAILURE_CODES.FLOW_FILE_INVALID,
          failure_stage: "flow_run_validate",
          failure_area: "tool_server",
          error_kind: "validation",
        });
      }
      const rootEntry: RunStackEntry = { canonical: canonicalPath, display: flowName };

      if (flow.executionPrerequisite && !pinnedToChromium(params.device)) {
        const leading = await leadingLaunch(flow, [rootEntry]);
        if (leading) {
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

      if (flow.executionPrerequisite && !params.prerequisiteAcknowledged) {
        return {
          flow: flowName,
          notice:
            "This flow has an execution prerequisite that must be fulfilled before it can run. " +
            "Verify the prerequisite is met and call flow-execute again with prerequisiteAcknowledged set to true.",
          executionPrerequisite: flow.executionPrerequisite,
        };
      }

      const resolved = await resolveRunDevice(
        registry,
        ctx,
        flow,
        params,
        flowsDir,
        rootEntry,
        viaUpload
      );
      const device = resolved.device;

      const statusBarPinned = device !== null && (await pinStatusBar(device));

      // The chromium equivalent: front the page so a backgrounded window doesn't
      // throttle rendering — wheel-event acks (scroll steps) stall on a throttled
      // compositor. Covers the instance the run starts on; a launch that boots
      // one fronts it itself. Best-effort: whether bringToFront un-minimizes is
      // runtime-dependent (measured: Chrome restores the window and unthrottles
      // input, Electron leaves it minimized and hidden). Resolving the session
      // applies focus emulation, which keeps input unthrottled even while
      // minimized, and gesture-tap/-drag/-scroll carry
      // assertChromiumWindowVisible for sessions where it could not apply.
      if (device?.platform === "chromium") await frontChromiumPage(registry, device);

      const state: ExecState = {
        registry,
        ctx,
        device,
        deviceIsExplicit: Boolean(params.device),
        signal,
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
        projectRoot: params.project_root,
        scriptLogBudget: createScriptLogBudget(),
        runtimeEnv: params.env ?? {},
        scriptRunNotes: createScriptRunNotes(),
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
          env: flow.env ?? {},
        });
      } finally {
        // Sample the cancel flag before teardown: a client disconnect during
        // status-bar restore / chromium teardown lands after every step
        // already ran, and must not flip a finished run to FAIL.
        aborted = state.signal?.aborted === true;
        if (state.pinned && device) await restoreStatusBar(device);
        for (let i = state.owned.length - 1; i >= 0; i--) {
          await teardownBootedChromium(registry, state.owned[i]!);
        }
      }

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
    if (!flowRequiresDevice(registry, flow.steps)) {
      if (!flowScopesDevice(registry, flow.steps)) return { device: null, booted: null };
      // A flow that only SCOPES to a device (a cleanup flow) takes one when one
      // is unambiguous, so the teardown stays narrowed to the run device and
      // cannot reap what another agent is mid-session on. When resolution has
      // no single answer — nothing booted, or several — run it unscoped rather
      // than failing the flow.
      //
      // Swallowed only for THAT answer. `resolveFlowDevice` also reaches
      // `list-devices` through the registry, so a bare catch would absorb an
      // adb/simctl failure, a dead sub-tool, an abort — and the teardown step
      // would then run unscoped and report pass, the machine-wide sweep this
      // path exists to avoid.
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

function hoistedBootFailure(err: unknown): unknown {
  const signal = singleInstanceLockSignal(err);
  if (!signal) return err;
  return wrapFailure(err, signal, `${errMsg(err)} ${singleInstanceLockHint(NO_LOCK_SUSPECTS)}`);
}

function pinnedToChromium(device: string | undefined): boolean {
  return device !== undefined && resolveDevice(device).platform === "chromium";
}

function chromiumPinnable(app: Launch, platform: string | undefined): boolean {
  if (typeof app === "string") return platform === "chromium";
  return chromiumLaunchSpec(app) !== null;
}

const NO_EXECUTABLE_STEP = "no-executable-step";

async function leadingLaunch(
  flow: FlowFile,
  stack: RunStackEntry[]
): Promise<{ app: Launch; flow: string } | null> {
  const found = await scanLeadingLaunch(flow, stack);
  return found === NO_EXECUTABLE_STEP ? null : found;
}

async function scanLeadingLaunch(
  flow: FlowFile,
  stack: RunStackEntry[]
): Promise<{ app: Launch; flow: string } | typeof NO_EXECUTABLE_STEP | null> {
  const top = stack[stack.length - 1]!;
  for (const step of flow.steps) {
    if (precedesLeadingLaunch(step)) continue;
    if (step.kind === "launch") return { app: step.app, flow: top.display };
    if (step.kind !== "run") return null;
    let nested: FlowFile;
    let canonical: string;
    try {
      const hop = await resolveFlowRelativeFile(
        path.dirname(top.canonical),
        step.flow,
        FLOW_FILE_NAME_PATTERN
      );
      canonical = hop.canonical;
      if (stack.some((entry) => entry.canonical === canonical)) return null;
      if (stack.length >= MAX_RUN_DEPTH) return null;
      if (hop.spelling.state === "case_folded") return null;
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

function chromiumBootSpec(
  app: Launch,
  platform: string | undefined
): { path: string; args?: string[] } | null {
  if (launchTargetPlatform(app, platform) !== "chromium") return null;
  return chromiumLaunchSpec(app);
}

function launchTargetPlatform(launch: Launch, platform: string | undefined): string | null {
  if (platform) return platform;
  if (typeof launch === "object") {
    const keys = Object.keys(launch);
    if (keys.length === 1) return keys[0]!;
  }
  return null;
}

async function resolveAppPath(specPath: string, flowDir: string): Promise<string> {
  const lexical = path.resolve(flowDir, specPath);
  try {
    return await fs.realpath(lexical);
  } catch {
    return lexical;
  }
}

async function bootChromiumForFlow(
  spec: { path: string; args?: string[] },
  flowDir: string,
  viaUpload: boolean
): Promise<BootedChromium> {
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
    /* one unreachable instance must not strand the others */
  }
}

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
    ok: failed === 0 && errored === 0 && !aborted,
    ...(aborted ? { aborted: true } : {}),
    passed,
    failed,
    skipped,
    errored,
    steps,
  };
}

function pushReport(state: ExecState, report: StepReport): void {
  state.reports.push(report);
  state.onStepReport?.(report);
}

interface RunStackEntry {
  canonical: string;
  display: string;
}

interface StepScope {
  runStack: RunStackEntry[];
  depth: number;
  /**
   * Flow-level `env` DEFAULTS in force here: the root flow's map with each
   * nested flow's layered over it, outermost first.
   *
   * On the scope rather than on {@link ExecState} because a nested flow must
   * inherit the active values, be able to override them inside itself, and
   * leave the parent's intact on the way out — which is what {@link childScope}
   * already does for `runStack`, on every return path including a throw, by
   * never mutating the parent. Held immutable for that reason: a map shared by
   * reference would be mutated by the fragment and never restored.
   */
  env: Readonly<ScriptEnv>;
}

function scopeFlow(scope: StepScope): string {
  return scope.runStack[scope.runStack.length - 1]!.display;
}

function runDisplayName(target: string, scope: StepScope): string {
  return runDisplayFor(target, scope.runStack[0]!.display);
}

function runDisplayFor(target: string, rootDisplay: string): string {
  const stem = runTargetName(target);
  if (stem !== rootDisplay) return stem;
  const spelled = target.slice(0, -".yaml".length);
  return spelled === stem ? `./${stem}` : spelled;
}

function stepFlow(step: FlowStep, scope: StepScope): string {
  return step.kind === "run" ? runDisplayName(step.flow, scope) : scopeFlow(scope);
}

function scopeFlowDir(scope: StepScope): string {
  return path.dirname(scope.runStack[scope.runStack.length - 1]!.canonical);
}

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

async function execSteps(state: ExecState, steps: FlowStep[], scope: StepScope): Promise<void> {
  for (const step of steps) {
    const index = state.reports.length;

    if (state.stopped) {
      const stopReason = state.signal?.aborted ? "run aborted" : undefined;
      pushReport(state, {
        index,
        kind: step.kind,
        status: "skip",
        flow: stepFlow(step, scope),
        target: stepTarget(step),
        ...depthOf(scope),
        ...(stopReason ? { reason: stopReason } : {}),
        ...(step.kind === "echo" ? { message: step.message } : {}),
      });
      const inner = blockSteps(step);
      if (inner) reportBlockSkipped(state, inner, childScope(scope), stopReason);
      continue;
    }
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
 * leaving the block out of the report entirely, not even its own marker. Binds
 * `step.kind` rather than `step` - while the registry has one entry BlockStep is
 * not a union, so only the discriminant narrows to `never`.
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

async function execWhenStep(
  state: ExecState,
  step: Extract<FlowStep, { kind: "when" }>,
  scope: StepScope
): Promise<void> {
  const index = state.reports.length;
  const label = describeWhenCondition(step.condition);
  const target = stepTarget(step);
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

  pushReport(state, { ...marker, status: "pass", reason: `condition met (${label})` });
  await execSteps(state, step.steps, inner);
}

/**
 * The `__baselines__/<segment>` a run's snapshots key their baseline store
 * under. The store is `<flowsDir>/__baselines__/<key>` and `flowsDir` is the
 * CANONICAL root flow's directory, so the key must name the canonical file too.
 * With the as-written stem it does not, and the disagreement merges distinct
 * flows: two projects whose `.argent/flows/smoke.yaml` are symlinks into one
 * shared vault (`vault/a-smoke.yaml`, `vault/b-smoke.yaml`) both anchor at
 * `vault/` and both key "smoke", so a single `vault/__baselines__/smoke/` holds
 * one PNG the two flows silently overwrite in turn while each
 * `--update-baselines` run reports "baseline updated". For a root flow that is a
 * regular file the canonical stem IS the as-written one, so only symlinked roots
 * move.
 *
 * The canonical stem is the symlink TARGET's filename, which nothing validates:
 * `assertSafeFlowName` and `classifyOnDiskSpelling` only run against the
 * as-written spelling, so a vault file may legitimately be called `...yaml` —
 * whose stem after `.yaml` is `..`, and
 * `path.join(flowsDir, "__baselines__", "..")` IS `flowsDir`, so every baseline
 * would land beside the flow files themselves (the escape
 * `flow-path-baseline-escape.test.ts` pins for the as-written spelling). Hence
 * the pattern check, against the same charset every other flow name is held to.
 * An unsafe stem falls back to the always-validated `flowName` rather than
 * throwing: an unusually named vault file is not the caller's error to fix
 * mid-run.
 */
function baselineKeyFor(canonicalPath: string, flowName: string): string {
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

  const { canonical, spelling } = await resolveFlowRelativeFile(
    scopeFlowDir(scope),
    target,
    FLOW_FILE_NAME_PATTERN
  );
  if (scope.runStack.some((entry) => entry.canonical === canonical)) {
    return fail(
      `cyclic flow reference: ${[...scope.runStack.map((entry) => entry.display), display].join(" → ")}`
    );
  }

  if (scope.runStack.length >= MAX_RUN_DEPTH) {
    return fail("max run depth exceeded");
  }

  const suppliedBase = path.posix.basename(target);
  if (spelling.state === "case_folded") {
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
  // target is reachable exactly when the tool-server user can read it, the same
  // reach the front door already grants: an operator can point flow_path at any
  // YAML on the host, so restricting composition below that only breaks
  // documented layouts — a fragment shared sideways (`../shared/login.yaml`),
  // and a flows dir symlinked to a tree kept outside the project. The one route
  // that carries untrusted content, an uploaded flow, never arrives here:
  // assertUploadSelfContained rejects every `run:` step on that path.
  let fragment: FlowFile;
  try {
    fragment = parseFlow(await fs.readFile(canonical, "utf8"));
  } catch (err) {
    return fail(`could not load fragment "${target}": ${errMsg(err)}`);
  }

  const retiredArg = findRetiredToolArg(state.registry, fragment.steps);
  if (retiredArg) return fail(`fragment "${target}" ${retiredArgReason(retiredArg)}`);

  pushReport(state, {
    index,
    kind: "run",
    status: "pass",
    flow: display,
    target,
    ...depthOf(scope),
  });
  // The fragment's own `env` layers over the values already in force and, being
  // a fresh object, leaves the parent scope's map exactly as it was when this
  // `run:` returns — including when a step inside it throws.
  await execSteps(
    state,
    fragment.steps,
    childScope(scope, {
      runStack: [...scope.runStack, { canonical, display }],
      ...(fragment.env ? { env: mergeScriptEnv(scope.env, fragment.env) } : {}),
    })
  );
}

type ScriptStepOutcome = Pick<StepReport, "status" | "reason" | "scriptLog" | "scriptLogTruncated">;

/**
 * A `script` step is the one step whose `reason` is written by something other
 * than this server: the child's own `throw` message crosses into it verbatim,
 * and a multi-line message is the ordinary shape of a rethrown API error. Every
 * surface that renders a step is one line per step and interpolates the reason
 * raw — the CLI's step line, `flowRunToMcpContent`, and the lift in
 * `flow-nested-outcome.ts` — so a newline in it puts script-controlled text at
 * column 0, below a `✗` line and above the real summary. A forged
 * "PASS — 3 passed, 0 failed" reads there as the run's own verdict.
 *
 * Escaped rather than stripped, and here rather than in each renderer: the
 * original characters stay recoverable, and the one step whose reason is not
 * server-composed is the one that pays for it. `describe`'s tree renderer takes
 * the same measure for the same reason (`format-tree.ts`), on labels read off a
 * device — a less hostile source than a local process's uncaught throw.
 *
 * Length is left to the executor's own `SCRIPT_MAX_FAILURE_MESSAGE_CHARS`: it
 * is the budget that decides what a failed script may say about itself, and a
 * second ceiling here would cut the step's only diagnostic without moving that
 * decision anywhere a reader can find it.
 */
function oneLineReason(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

async function runScriptStep(
  state: ExecState,
  step: Extract<FlowStep, { kind: "script" }>,
  scope: StepScope
): Promise<ScriptStepOutcome> {
  // The whole precedence, in one expression: the flow-level defaults this scope
  // carries, then the run-time map (a default loses to a caller at any depth),
  // then the step's own map, which is not a default at all.
  const { outcome } = await runFlowScriptStep({
    flowDir: scopeFlowDir(scope),
    step,
    projectRoot: state.projectRoot,
    logBudget: state.scriptLogBudget,
    env: mergeScriptEnv(scope.env, state.runtimeEnv, step.env),
    runNotes: state.scriptRunNotes,
    ...(state.signal ? { signal: state.signal } : {}),
  });
  return outcome.reason === undefined
    ? outcome
    : { ...outcome, reason: oneLineReason(outcome.reason) };
}

type LeafStep = Exclude<FlowStep, BlockStep | { kind: "run" }>;

async function execLeafStep(
  state: ExecState,
  step: LeafStep,
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
      if (r.aborted) return { ...base, status: "skip", reason: r.reason };
      return { ...base, status: r.ok ? "pass" : "error", reason: r.reason };
    }

    case "tap":
    case "long-press":
    case "swipe":
    case "type":
    case "await":
    case "assert":
    case "idle":
    case "scroll-to":
    case "pinch":
    case "rotate": {
      try {
        const r = await runDirective(deviceEnv(state), step);
        if (r.aborted) return { ...base, status: "skip", reason: r.reason };
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
      // recording scoped — as it does with a device resolved, unless the caller
      // named it.
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
      if (FOREGROUND_CHANGING_TOOLS.has(step.name)) {
        state.treeTarget = undefined;
        if (state.treeOutage) state.treeOutage.proven = undefined;
      } else if (state.treeTarget?.pinned) {
        state.treeTarget = { ...state.treeTarget, pinned: false };
        if (state.treeOutage) state.treeOutage.proven = undefined;
      }
      // A nested orchestrator runs its tools outside this run's holder -
      // `flow-execute` on an ExecState of its own, `run-sequence` on none - so
      // a tree read or relaunch inside it retires nothing here. Cleared before
      // the invoke for the same reason as above, and over-clearing only costs a
      // later gesture a window it would have skipped.
      if (isNestedOrchestratorTool(step.name) && state.treeOutage) {
        state.treeOutage.proven = undefined;
      }
      try {
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
          return {
            ...base,
            status: "fail",
            tool: step.name,
            reason: `debugger not connected (${result.reason}): ${result.detail} — ${result.guidance}`,
            result,
            outputHint,
            args,
          };
        }
        // Same hazard as the two above, on the native-devtools precheck: it
        // RESOLVES its block rather than throwing, so a step that never reached
        // the tool's work read as green. `launch:` already guards its own
        // `restart-app` (see runLaunch); this is the `tool:` spelling of the
        // same sub-tools, plus the native-* tools it never covered.
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
        if (step.name === "launch-app" || step.name === "restart-app") {
          const launched = (args as { bundleId?: unknown }).bundleId;
          if (typeof launched === "string") {
            state.treeTarget = { bundleId: launched, pinned: false, probeAnswered: false };
          }
        }
        return { ...base, status: "pass", tool: step.name, result, outputHint, args };
      } catch (err) {
        if (signal?.aborted) {
          return { ...base, status: "skip", tool: step.name, reason: ABORTED_OUTCOME.reason };
        }
        const reframed = describeNestedParamError(registry, err, step.name, args, step.args ?? {});
        return { ...base, status: "error", tool: step.name, reason: reframed ?? errMsg(err) };
      }
    }

    case "script": {
      const outcome = await runScriptStep(state, step, scope);
      return { ...base, ...outcome };
    }

    default: {
      const unexecuted: never = step;
      void unexecuted;
      return { ...base, status: "error", reason: `unsupported step kind` };
    }
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
 * rejection only keeps `flow_path`, whose whole contract is that those resolve
 * beside the caller's YAML, from silently meaning a temp directory instead.
 *
 * With no `flow_path` or `flow_file`, derive the saved-flow path from
 * project_root + name. When `flow_file` is set it must be one of the two shapes
 * its file-input boundary legitimately produces: the exact
 * `${project_root}/.argent/flows/${name}.yaml` path (co-located client), or a
 * temp file THIS server materialized from uploaded content
 * (`fileInput.viaUpload` — remote client). Anything else is rejected: the schema
 * marks `flow_file` internal, and honoring an arbitrary path would let a caller
 * execute (and, under --update-baselines, write PNGs next to) any YAML on the
 * host through a parameter no caller is supposed to set — `flow_path`, gated on
 * the boundary above, is the one legitimate spelling for a file outside the
 * flows dir. Either source's flow name must then appear in that flow's own
 * directory listing byte-for-byte — a case-insensitive filesystem opens files
 * under spellings no directory entry carries, and the name is what keys the
 * report and `__baselines__/` (see {@link classifyOnDiskSpelling}). Name is
 * validated on the branch that has one; project_root is validated up front,
 * before either branch, since only the `name` branch would otherwise reach a
 * check.
 *
 * Resolution is pure: it reads and mutates no shared state, so replaying a flow
 * in one project can never rebind the paths of a recording in progress in
 * another.
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

  assertValidProjectRoot(params.project_root);

  if (params.flow_path !== undefined) {
    if (flowPathInput?.viaUpload) {
      throw new FailureError(
        `Invalid flow_path "${flowPathInput.clientPath}": explicit flow paths require a ` +
          `co-located client and tool server with a shared filesystem, and this one arrived as ` +
          `an upload — sibling run: files, baselines, and baseline write-back all resolve beside ` +
          `the copy this server materialized, alone in a temp directory. Pass name + ` +
          `project_root to run a self-contained flow from a remote client; name uploads the same ` +
          `way, so a flow with run:, script: or snapshot: steps needs the client and tool server ` +
          `on one filesystem.`,
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

    // Reject ".." segments: execute() canonicalizes this path ONCE with kernel
    // semantics (canonicalFlowPath) and derives the read, flowsDir, and the
    // runStack seed from that one result, so a ".." spelling can no longer split
    // the read from its anchors. What it still can do is carry two readings —
    // after a symlinked component, the kernel's ".." and a lexical collapse name
    // different files — or, when the directory chain is broken, slip through
    // canonicalFlowPath's verbatim fallback to fail later as a raw readFile
    // ENOENT on the unresolved spelling. Rejecting up front means every admitted
    // flow_path has exactly one reading. The argent client rejects ".." segments
    // before sending; only a direct MCP/HTTP caller can pass an unresolved
    // flow_path.
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
    // check and let assertSafeFlowName name it.
    const bareExtension = path.basename(clientPath).toLowerCase() === ".yaml";
    if (!bareExtension && clientExt !== ".yaml") {
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

    const suppliedBase = path.basename(clientPath);
    const spelling = await classifyOnDiskSpelling(path.dirname(params.flow_path), suppliedBase);
    if (spelling.state !== "listed") {
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

  const spelling = await classifyOnDiskSpelling(path.dirname(expected), `${flowName}.yaml`);
  if (spelling.state === "case_folded") {
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

  return { filePath: params.flow_file || expected, flowName, viaUpload: false };
}
