import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FAILURE_CODES, FailureError, isLiveServiceState } from "@argent/registry";
import type {
  DeviceInfo,
  FileInputSpec,
  Registry,
  ResolvedFileInput,
  ToolContext,
  ToolDefinition,
} from "@argent/registry";
import {
  appIdForPlatform,
  assertSafeFlowName,
  chromiumLaunchSpec,
  describeTextExpectation,
  getFlowPath,
  isE2eFlow,
  parseFlow,
  setActiveProjectRoot,
  type FlowFile,
  type FlowSelector,
  type FlowStep,
  type Launch,
} from "./flow-utils";
import { sleepOrAbort } from "../../utils/timing";
import { invokeSubTool } from "../../utils/sub-invoke";
import { isUnmetUiWaitResult } from "../await-ui-element";
import { resolveFlowDevice, bindDeviceArgs, type FlowPlatform } from "./flow-device";
import {
  runDirective,
  invokeOnDevice,
  ABORTED_OUTCOME,
  type ActionEnv,
  type DirectiveOutcome,
} from "./flow-actions";
import { nativeDevtoolsRef, type NativeDevtoolsApi } from "../../blueprints/native-devtools";
import { androidDevtoolsRef, type AndroidDevtoolsApi } from "../../blueprints/android-devtools";
import {
  chromiumCdpRef,
  CHROMIUM_CDP_NAMESPACE,
  type ChromiumCdpApi,
} from "../../blueprints/chromium-cdp";
import { bootElectronApp, killChromiumByPort } from "../devices/boot-electron";
import { untrackChromiumPort } from "../../utils/chromium-discovery";
import { resolveDevice } from "../../utils/device-info";
import { runSnapshot, DEFAULT_MAX_MISMATCH, type SnapshotArtifacts } from "./flow-visual";
import { describeVega } from "../describe/platforms/vega";
import { pinStatusBar, restoreStatusBar } from "../../utils/status-bar";

const zodSchema = z.object({
  name: z.string().describe('Name of the flow to run (e.g. "settings-explore")'),
  project_root: z
    .string()
    .describe(
      "Absolute path to the project root directory that contains `.argent/flows/<name>.yaml`."
    ),
  flow_file: z
    .string()
    .optional()
    .describe(
      "Path to the flow .yaml as readable by the tool-server. Internal — the argent client derives it from project_root and name automatically; leave unset."
    ),
  device: z
    .string()
    .optional()
    .describe(
      "Device id to run against (iOS UDID, Android/Vega serial, Chromium id). Auto-detected when omitted."
    ),
  platform: z
    .enum(["ios", "android", "chromium", "vega"])
    .optional()
    .describe("Restrict auto-detection to this platform when several devices are booted."),
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
});

type Params = z.infer<typeof zodSchema>;

const fileInputs: FileInputSpec[] = [
  { target: "flow_file", path: "${project_root}/.argent/flows/${name}.yaml", kind: "file" },
];

export type StepStatus = "pass" | "fail" | "skip" | "error";

export interface StepReport {
  index: number;
  kind: FlowStep["kind"];
  status: StepStatus;
  /** Machine-readable explanation when the step did not pass. */
  reason?: string;
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
  /** The fragment a step belongs to (set on `run` and the steps it expands). */
  flow?: string;
  /**
   * Human-readable "what this step acts on" — the selector for directive
   * steps, the snapshot name — so a report line reads `tap "Clear logs"`,
   * not a bare `tap`. Display-only; derived from the step definition.
   */
  target?: string;
  /**
   * Baseline key stem (`<name>__<platform>-WxH`) for snapshot steps that carry
   * artifacts — clients exporting them to a durable location (the CLI's
   * `--output`) name files by it.
   */
  snapshotKey?: string;
  /** Snapshot-step artifacts (baseline/current/diff) as materializable handles. */
  artifacts?: SnapshotArtifacts;
}

export interface FlowRunResult {
  flow: string;
  device: string;
  executionPrerequisite: string;
  ok: boolean;
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

const MAX_RUN_DEPTH = 20;

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
 * the launch step reports the problem where it belongs, with a relaunch hint.
 */
const NATIVE_READY_TIMEOUT_MS = 8000;
const NATIVE_READY_POLL_MS = 250;

/**
 * Poll until native-devtools is connected for `bundleId`. Returns true once
 * connected, false on timeout / abort / the service being unavailable. The
 * caller decides how to treat false (iOS flows fail; see treeSourceGate).
 */
async function waitForNativeDevtools(
  registry: Registry,
  device: DeviceInfo,
  bundleId: string,
  signal?: AbortSignal
): Promise<boolean> {
  let api: NativeDevtoolsApi;
  try {
    const ref = nativeDevtoolsRef(device);
    api = await registry.resolveService<NativeDevtoolsApi>(ref.urn, ref.options);
  } catch {
    return false; // native-devtools service unavailable
  }
  const deadline = Date.now() + NATIVE_READY_TIMEOUT_MS;
  for (;;) {
    if (signal?.aborted) return false;
    if (api.isConnected(bundleId)) return true;
    if (Date.now() >= deadline) return false;
    if (!(await sleepOrAbort(NATIVE_READY_POLL_MS, signal))) return false;
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
 * letting the first directive surface a raw tree-source error. Returns null
 * when ready (or the platform needs no gate / the run was aborted), else the
 * reason to report.
 */
async function treeSourceGate(
  registry: Registry,
  device: DeviceInfo,
  bundleId: string,
  signal?: AbortSignal
): Promise<string | null> {
  if (device.platform === "ios" && !signal?.aborted) {
    const connected = await waitForNativeDevtools(registry, device, bundleId, signal);
    if (!connected && !signal?.aborted) {
      return (
        `could not connect to native devtools for ${bundleId}. Re-run to relaunch the app and retry. ` +
        `If it keeps failing, a stale or duplicate argent server may be holding the devtools connection — restart the argent server and try again.`
      );
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
 * Chromium can't relaunch in place: `execute` boots a fresh instance before
 * step 1 (`state.chromiumBooted`), so here the step just settles it. The
 * exception is a run the runner did not boot for — an explicit `device` pinning
 * an already-running instance, or auto-detection picking a booted one — where
 * the step attaches in place instead of spawning a second window: it confirms
 * the CDP session is reachable and refreshes the cached viewport. That is done
 * against the CDP service directly, not via `launch-app` — the chromium launch
 * value is an app *path*, which `launch-app`'s bundleId grammar rejects (and
 * its chromium handler is this same viewport refresh anyway).
 */
async function runLaunch(state: ExecState, app: Launch): Promise<DirectiveOutcome> {
  const { registry, device, signal } = state;

  if (device.platform === "chromium") {
    if (state.chromiumBooted) {
      // already booted + fronted; just settle
      if (!(await sleepOrAbort(POST_LAUNCH_SETTLE_MS, signal))) return ABORTED_OUTCOME;
      return { ok: true };
    }
    if (!appIdForPlatform(app, "chromium")) {
      return { ok: false, reason: `no chromium app declared — add a chromium launch entry` };
    }
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
    if (!(await sleepOrAbort(POST_LAUNCH_SETTLE_MS, signal))) return ABORTED_OUTCOME;
    return { ok: true };
  }

  const bundleId = appIdForPlatform(app, device.platform);
  if (!bundleId) {
    return {
      ok: false,
      reason: `no app id declared for platform "${device.platform}" — add a launch entry for it`,
    };
  }
  try {
    await invokeOnDevice(state, "restart-app", { bundleId });
  } catch (err) {
    // A cancellation makes the sub-tool itself reject; that rejection is the
    // abort, not an app failure, so it must not be attributed to restart-app.
    if (signal?.aborted) return ABORTED_OUTCOME;
    return { ok: false, reason: `restart-app failed: ${errMsg(err)}` };
  }
  if (!(await sleepOrAbort(POST_LAUNCH_SETTLE_MS, signal))) return ABORTED_OUTCOME;
  const gate = await treeSourceGate(registry, device, bundleId, signal);
  // The gate returns null (ready) on abort — check the signal before trusting
  // it, or a cancelled gate would read as a launch that verified readiness.
  if (signal?.aborted) return ABORTED_OUTCOME;
  if (gate) return { ok: false, reason: gate };
  return { ok: true };
}

interface ExecState extends ActionEnv {
  flowsDir: string;
  topFlowName: string;
  updateBaselines: boolean;
  reports: StepReport[];
  stopped: boolean;
  /** Whether the status bar was pinned for this run (and so must be restored). */
  pinned: boolean;
  /** True when the runner booted the chromium app for this run (and owns its teardown). */
  chromiumBooted: boolean;
  /** Live progress hook: receives every report the moment it is appended. */
  onStepReport?: (report: StepReport) => void;
}

/** A chromium instance the runner booted and must tear down after the run. */
interface BootedChromium {
  deviceId: string;
  port: number;
  pid: number;
}

export function createRunFlowTool(
  registry: Registry
): ToolDefinition<Params, FlowRunResult | FlowPrerequisiteNotice> {
  return {
    id: "flow-execute",
    description: `Run a saved flow from the .argent/flows/ directory.
Steps run in order: \`launch\` starts an app from scratch (terminate + relaunch) and waits until it is
ready; \`tool\` calls dispatch through the registry; \`tap\`/\`long-press\`/\`type\` resolve a selector to an
element and act on it (\`long-press: { on, duration }\` presses and holds); \`scroll-to\` scrolls
(momentum-free) until a target is visible; \`await\` waits for a UI
condition; \`wait\` pauses for a fixed number of milliseconds; \`assert\` checks one now; \`snapshot\`
diffs a screenshot against a stored baseline (a missing baseline fails the step — set updateBaselines
to adopt the current screen); \`echo\` annotates; \`run\` executes a referenced fragment inline.
A flow that begins with a \`launch\` step is a self-contained e2e flow; one that doesn't runs against the
device's current state. Device id is injected by the runner (flows store none) — pass \`device\` or
\`platform\` to pick one, else the single booted device is used. For a Chromium e2e flow the \`launch\`
step's chromium value is an Electron app path ({ chromium: <path> | { path, args } }); the runner boots a
fresh instance from it (on the tool-server host) and tears it down when the run ends, unless an explicit
\`device\` pins an already-running instance. Every step hard-stops the flow on failure;
later steps are reported as skipped. Returns a structured report ({ ok, passed, failed, skipped, errored, steps }).

If a fragment has an execution prerequisite and prerequisiteAcknowledged is not set to true, the tool
returns a notice with the prerequisite instead of running.`,
    longRunning: true,
    zodSchema,
    fileInputs,
    services: () => ({}),
    async execute(_services, params, ctx?: ToolContext) {
      const signal = ctx?.signal;
      const filePath = resolveFlowFilePath(params, ctx?.fileInputs?.flow_file);
      const flowsDir = path.dirname(filePath);
      const flow = parseFlow(await fs.readFile(filePath, "utf8"));

      // LLM-path prerequisite handshake (fragments only; a flow with a leading
      // launch step cannot declare one — validated at parse).
      if (flow.executionPrerequisite && !params.prerequisiteAcknowledged) {
        return {
          flow: params.name,
          notice:
            "This flow has an execution prerequisite that must be fulfilled before it can run. " +
            "Verify the prerequisite is met and call flow-execute again with prerequisiteAcknowledged set to true.",
          executionPrerequisite: flow.executionPrerequisite,
        };
      }

      // Resolve the run device (a Chromium e2e flow boots + owns its own app; see
      // resolveRunDevice). Any instance it booted is torn down in the finally.
      const resolved = await resolveRunDevice(registry, ctx, flow, params, flowsDir);
      const device = resolved.device;
      const env: ActionEnv = { registry, ctx, device, signal };

      // Normalize the status bar (clock/battery/signal) for the whole run so it
      // never drives a snapshot diff and every screenshot is consistent. Pinned
      // before step 1 — it's a device-level override independent of the app, so
      // an e2e flow's leading launch step (relaunch + settle) doubles as
      // propagation headroom before anything is captured. No-op (returns false)
      // on chromium/vega; restored on teardown.
      const statusBarPinned = await pinStatusBar(device);

      // The chromium equivalent of that normalization: front the page once so
      // a backgrounded window doesn't throttle rendering for the whole run —
      // wheel-event acks (scroll steps) stall on a throttled compositor.
      // Best-effort: bringToFront can focus a page but cannot unhide a
      // minimized window (gesture-scroll fails fast on that case itself).
      if (device.platform === "chromium") await frontChromiumPage(registry, device);

      const state: ExecState = {
        ...env,
        flowsDir,
        topFlowName: params.name,
        updateBaselines: Boolean(params.updateBaselines),
        reports: [],
        stopped: false,
        pinned: statusBarPinned,
        chromiumBooted: resolved.booted !== null,
        ...(ctx?.emitProgress ? { onStepReport: ctx.emitProgress } : {}),
      };

      try {
        await execSteps(state, flow.steps, params.name, [params.name]);
      } finally {
        if (state.pinned) await restoreStatusBar(device);
        if (resolved.booted) await teardownBootedChromium(registry, resolved.booted);
      }

      return summarize(params.name, device.id, flow.executionPrerequisite, state.reports);
    },
  };
}

/**
 * Resolve the device a flow runs against. For a Chromium e2e flow with no
 * explicit `device` (see {@link chromiumBootSpec}) this boots a fresh Electron
 * instance from the launch's app path and returns it for teardown; otherwise it
 * attaches to an already-booted device. An explicit `device` always attaches —
 * never boots or tears down. `flowDir` is the flow file's directory — the base
 * for a relative chromium app path.
 */
async function resolveRunDevice(
  registry: Registry,
  ctx: ToolContext | undefined,
  flow: FlowFile,
  params: Params,
  flowDir: string
): Promise<{ device: DeviceInfo; booted: BootedChromium | null }> {
  if (!params.device) {
    const spec = chromiumBootSpec(flow, params.platform);
    if (spec) {
      const booted = await bootChromiumForFlow(spec, flowDir);
      return { device: resolveDevice(booted.deviceId), booted };
    }
  }
  const device = await resolveFlowDevice(registry, ctx, {
    device: params.device,
    platform: params.platform as FlowPlatform | undefined,
  });
  return { device, booted: null };
}

/**
 * The Chromium app-path spec to boot for this run, or null when this isn't a
 * Chromium e2e flow that should boot its own app. Requires an e2e flow whose
 * leading launch names a chromium target that is unambiguously the one to run —
 * `--platform chromium`, or a single-platform `{ chromium: ... }` map. A
 * multi-platform or bare launch with no hint defers to device auto-detection.
 */
function chromiumBootSpec(
  flow: FlowFile,
  platform: string | undefined
): { path: string; args?: string[] } | null {
  if (!isE2eFlow(flow)) return null;
  const first = flow.steps.find((s) => s.kind !== "echo");
  if (!first || first.kind !== "launch") return null;
  if (launchTargetPlatform(first.app, platform) !== "chromium") return null;
  return chromiumLaunchSpec(first.app);
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
 * Boot the Electron app a chromium launch declares. A relative path resolves
 * against the flow file's directory (`flowDir`) — the same anchor `run:` and
 * baselines use — so the target is intrinsic to the flow, not the caller's cwd;
 * an absolute path is taken as-is. Boot failures propagate as-is — the Chromium
 * analog of `resolveFlowDevice` throwing on no booted device. The app must exist
 * on the *tool-server* host, so a flow-relative path won't resolve on a remote
 * tool-server (the flow file lives in a shipped temp dir there).
 */
async function bootChromiumForFlow(
  spec: { path: string; args?: string[] },
  flowDir: string
): Promise<BootedChromium> {
  const appPath = path.isAbsolute(spec.path) ? spec.path : path.resolve(flowDir, spec.path);
  const res = await bootElectronApp({ appPath, extraArgs: spec.args });
  return { deviceId: res.id, port: res.port, pid: res.pid };
}

/**
 * Tear down a Chromium instance the runner booted. Best-effort — never fail a
 * run here: dispose the CDP session (if a tool opened one), kill the process,
 * and forget its port so `list-devices` stops probing it.
 */
async function teardownBootedChromium(registry: Registry, booted: BootedChromium): Promise<void> {
  const urn = `${CHROMIUM_CDP_NAMESPACE}:${booted.deviceId}`;
  try {
    const entry = registry.getSnapshot().services.get(urn);
    if (entry && isLiveServiceState(entry.state)) await registry.disposeService(urn);
  } catch {
    /* the kill below frees the real resource regardless */
  }
  killChromiumByPort(booted.port, booted.pid);
  untrackChromiumPort(booted.port);
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
  steps: StepReport[]
): FlowRunResult {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let errored = 0;
  let hasSkippedReport = false;
  for (const s of steps) {
    hasSkippedReport ||= s.status === "skip";
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
    // A skip is never a successful omission: the runner only emits skips after
    // a hard stop or cancellation. The former already has a fail/error report;
    // the latter may contain skips alone, so include them in the verdict or an
    // aborted run would be reported as PASS.
    ok: failed === 0 && errored === 0 && !hasSkippedReport,
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
  if (sel.text !== undefined) parts.push(`"${sel.text}"`);
  if (sel.textMatches !== undefined) parts.push(`/${sel.textMatches}/`);
  if (sel.identifier) parts.push(`id=${sel.identifier}`);
  if (sel.role) parts.push(`role=${sel.role}`);
  return parts.join(" ");
}

/** Display-only "what this step acts on" for {@link StepReport.target}. */
function stepTarget(step: FlowStep): string | undefined {
  switch (step.kind) {
    case "tap":
      if (step.selector) return selectorLabel(step.selector);
      if (step.x !== undefined && step.y !== undefined) return `(${step.x}, ${step.y})`;
      return undefined;
    case "long-press":
      return selectorLabel(step.selector);
    case "type":
      return `into ${selectorLabel(step.into)}`;
    case "await":
    case "assert": {
      const sel = selectorLabel(step.selector);
      // A text condition checks expectedText against the element the selector
      // locates; the other conditions are about the selector itself.
      if (step.condition === "text") {
        return `${sel} ${describeTextExpectation(step.expectedText, step.textMatch)}`;
      }
      return `${step.condition} ${sel}`;
    }
    case "scroll-to": {
      const dir = step.direction !== "down" ? ` (${step.direction})` : "";
      return `${selectorLabel(step.target)}${dir}`;
    }
    case "snapshot":
      return `"${step.name}"`;
    default:
      return undefined;
  }
}

/** Execute a list of steps, appending reports to state. Honors hard-stop + abort. */
async function execSteps(
  state: ExecState,
  steps: FlowStep[],
  sourceFlow: string,
  runStack: string[]
): Promise<void> {
  for (const step of steps) {
    const index = state.reports.length;

    if (state.stopped) {
      pushReport(state, {
        index,
        kind: step.kind,
        status: "skip",
        flow: sourceFlow,
        target: stepTarget(step),
      });
      continue;
    }
    if (state.signal?.aborted) {
      state.stopped = true;
      pushReport(state, {
        index,
        kind: step.kind,
        status: "skip",
        reason: "run aborted",
        flow: sourceFlow,
        target: stepTarget(step),
      });
      continue;
    }

    if (step.kind === "run") {
      await execRunStep(state, step, runStack);
      continue;
    }

    const report = await execLeafStep(state, step, index, sourceFlow);
    pushReport(state, report);
    if (report.status === "fail" || report.status === "error") state.stopped = true;
  }
}

async function execRunStep(
  state: ExecState,
  step: Extract<FlowStep, { kind: "run" }>,
  runStack: string[]
): Promise<void> {
  const index = state.reports.length;
  const target = step.flow;

  const fail = (reason: string): void => {
    pushReport(state, { index, kind: "run", status: "error", flow: target, reason });
    state.stopped = true;
  };

  if (runStack.includes(target)) {
    return fail(`cyclic flow reference: ${[...runStack, target].join(" → ")}`);
  }
  if (runStack.length >= MAX_RUN_DEPTH) {
    return fail("max run depth exceeded");
  }

  let fragment: FlowFile;
  try {
    assertSafeFlowName(target);
    const fragPath = path.join(state.flowsDir, `${target}.yaml`);
    fragment = parseFlow(await fs.readFile(fragPath, "utf8"));
  } catch (err) {
    return fail(`could not load fragment "${target}": ${errMsg(err)}`);
  }

  if (isE2eFlow(fragment)) {
    return fail(
      `"${target}" is an e2e flow (starts with a launch step); only fragments can be run from another flow`
    );
  }

  // Marker for the composition point, then expand the fragment's steps inline.
  pushReport(state, { index, kind: "run", status: "pass", flow: target });
  await execSteps(state, fragment.steps, target, [...runStack, target]);
}

async function execLeafStep(
  state: ExecState,
  step: FlowStep,
  index: number,
  sourceFlow: string
): Promise<StepReport> {
  const base = { index, kind: step.kind, flow: sourceFlow, target: stepTarget(step) } as const;
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
    case "scroll-to": {
      // A directive that *throws* (vs. reporting a failed outcome) — e.g. a
      // touch gesture on a focus-driven TV target — must still land in the
      // structured report rather than abort the whole run unreported.
      try {
        const r = await runDirective(state, step);
        // A run cancelled mid-directive is a skip (matching the pre-step guard
        // and `wait`), never a step failure — the app did nothing wrong.
        if (r.aborted) return { ...base, status: "skip", reason: r.reason };
        return { ...base, status: r.ok ? "pass" : "fail", reason: r.reason };
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
        const r = await runSnapshot(state, {
          flowsDir: state.flowsDir,
          flowName: state.topFlowName,
          name: step.name,
          maxMismatch: step.maxMismatch ?? DEFAULT_MAX_MISMATCH,
          updateBaselines: state.updateBaselines,
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
      const args = bindDeviceArgs(registry, step.name, device.id, step.args);
      const outputHint = registry.getTool(step.name)?.outputHint;
      if (step.delayMs && !(await sleepOrAbort(step.delayMs, signal))) {
        return { ...base, status: "skip", tool: step.name, reason: "run aborted during delay" };
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
 * Resolve the flow YAML path a tool reads. With no `flow_file`, derive it from
 * project_root + name. When `flow_file` is set it must be one of the two shapes
 * the file-input boundary legitimately produces: the exact
 * `${project_root}/.argent/flows/${name}.yaml` path (co-located client,
 * resolved in place), or a temp file THIS server materialized from uploaded
 * content (`fileInput.viaUpload` — remote client). Anything else is rejected:
 * the schema marks `flow_file` internal, and honoring an arbitrary path would
 * let a caller execute (and, under --update-baselines, write PNGs next to) any
 * YAML on the host, bypassing the project-root containment the rest of the
 * module enforces. Name and project_root are validated in every branch.
 */
export function resolveFlowFilePath(
  params: {
    name: string;
    project_root: string;
    flow_file?: string;
  },
  fileInput?: ResolvedFileInput
): string {
  assertSafeFlowName(params.name);
  setActiveProjectRoot(params.project_root);
  const expected = getFlowPath(params.name);
  if (!params.flow_file) return expected;
  // A path the boundary materialized from uploaded content is a fresh temp
  // file this process itself created (see file-inputs.ts) — trusted as-is.
  if (fileInput?.viaUpload) return params.flow_file;
  if (
    !path.isAbsolute(params.flow_file) ||
    params.flow_file.split(/[\\/]+/).includes("..") ||
    path.resolve(params.flow_file) !== path.resolve(expected)
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
  return params.flow_file;
}
