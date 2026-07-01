import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  DeviceInfo,
  FileInputSpec,
  Registry,
  ToolContext,
  ToolDefinition,
} from "@argent/registry";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import {
  appIdForPlatform,
  assertSafeFlowName,
  getFlowPath,
  isE2eFlow,
  parseFlow,
  setActiveProjectRoot,
  type FlowFile,
  type FlowStep,
} from "./flow-utils";
import { sleepOrAbort } from "../../utils/timing";
import { invokeSubTool } from "../../utils/sub-invoke";
import { isUnmetUiWaitResult, AWAIT_UI_ELEMENT_TOOL_ID } from "../await-ui-element";
import { resolveFlowDevice, bindDeviceArgs, type FlowPlatform } from "./flow-device";
import { runTap, runType, runAssert, runScrollTo } from "./flow-actions";
import { nativeDevtoolsRef, type NativeDevtoolsApi } from "../../blueprints/native-devtools";
import { androidDevtoolsRef, type AndroidDevtoolsApi } from "../../blueprints/android-devtools";
import { runSnapshot, DEFAULT_MAX_MISMATCH } from "./flow-visual";
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
      "Write/refresh screenshot baselines for `expect` steps instead of diffing against them."
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
  /** Underlying tool id for `tool` / `await` steps. */
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
  artifacts?: string[];
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
 * one-shot `assert`, or a `tap` whose 5s budget is eaten by the launch), so we
 * give the app a head start here rather than inflating every step's timeout.
 */
const POST_LAUNCH_SETTLE_MS = 1500;

/**
 * Flows resolve selectors against the native UIView tree, served over the
 * native-devtools connection the injected dylib opens asynchronously after
 * launch. The post-launch settle alone can race a slow cold start, so we
 * additionally poll for the connection before step 1. If it never connects,
 * selectors would silently fall back to the (collapsing) AX tree — where a
 * testID container the flow addresses (e.g. a `within` scroll container) is
 * absent, producing confusing "not visible" failures. So the caller treats a
 * failure to connect as a hard error rather than degrading the whole run.
 */
const NATIVE_READY_TIMEOUT_MS = 8000;
const NATIVE_READY_POLL_MS = 250;

/**
 * Poll until native-devtools is connected for `bundleId`. Returns true once
 * connected, false on timeout / abort / the service being unavailable. The
 * caller decides how to treat false (iOS flows fail; see execute).
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
 * Probe whether the android-devtools helper — the full-hierarchy source flows
 * resolve testIDs against (`flow-android-tree.ts`) — is usable.
 *
 * Unlike iOS's native-devtools (a connection the injected dylib opens
 * asynchronously *after* launch, which `waitForNativeDevtools` must poll for),
 * the Android helper is a separate `am instrument` process the registry spawns
 * synchronously on first `resolveService`. There is no post-launch race to wait
 * out: one resolution either brings the helper up (install + spawn + ping
 * handshake in the factory) or it can't run on this device. So this is a
 * one-shot probe, not a poll. Returns true when the helper is ready. On failure
 * the caller hard-fails rather than let `fetchFlowTree` silently degrade to the
 * trimmed accessibility tree — where a testID on a not-important RN container is
 * absent, producing the same confusing "not visible" failures the iOS gate
 * guards against.
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

interface ExecState {
  registry: Registry;
  ctx?: ToolContext;
  device: DeviceInfo;
  signal?: AbortSignal;
  flowsDir: string;
  topFlowName: string;
  updateBaselines: boolean;
  reports: StepReport[];
  stopped: boolean;
  /** Whether the status bar was pinned for this run (and so must be restored). */
  pinned: boolean;
}

export function createRunFlowTool(
  registry: Registry
): ToolDefinition<Params, FlowRunResult | FlowPrerequisiteNotice> {
  return {
    id: "flow-execute",
    description: `Run a saved flow from the .argent/flows/ directory.
Steps run in order: \`tool\` calls dispatch through the registry; \`tap\`/\`type\` resolve a selector to
an element and act on it; \`scroll-to\` scrolls (momentum-free) until a target is visible; \`await\` waits for
a UI condition; \`wait\` pauses for a fixed number of milliseconds; \`assert\` checks one now; \`snapshot\`
diffs a screenshot against a stored baseline; \`echo\` annotates; \`run\` executes a referenced fragment inline.
Device id is injected by the runner (flows store none) — pass \`device\` or \`platform\` to pick one, else
the single booted device is used. Every step hard-stops the flow on failure; later steps are reported as
skipped. Returns a structured report ({ ok, passed, failed, skipped, errored, steps }).

If a fragment has an execution prerequisite and prerequisiteAcknowledged is not set to true, the tool
returns a notice with the prerequisite instead of running.`,
    longRunning: true,
    zodSchema,
    fileInputs,
    services: () => ({}),
    async execute(_services, params, ctx?: ToolContext) {
      const signal = ctx?.signal;
      const filePath = resolveFlowFilePath(params);
      const flowsDir = path.dirname(filePath);
      const flow = parseFlow(await fs.readFile(filePath, "utf8"));

      // LLM-path prerequisite handshake (fragments only; e2e flows have none).
      if (flow.executionPrerequisite && !params.prerequisiteAcknowledged) {
        return {
          flow: params.name,
          notice:
            "This flow has an execution prerequisite that must be fulfilled before it can run. " +
            "Verify the prerequisite is met and call flow-execute again with prerequisiteAcknowledged set to true.",
          executionPrerequisite: flow.executionPrerequisite,
        };
      }

      const device = await resolveFlowDevice(registry, ctx, {
        device: params.device,
        platform: params.platform as FlowPlatform | undefined,
      });

      // Normalize the status bar (clock/battery/signal) for the whole run so it
      // never drives a snapshot diff and every screenshot is consistent. The
      // `simctl status_bar override` is a device-level op independent of the
      // app, so we pin as early as possible (see below). No-op (returns false)
      // on chromium/vega; restored on teardown.
      let statusBarPinned: boolean;

      // An e2e flow starts its app from a clean state (its contract): terminate
      // and relaunch via `restart-app` so a copy left running by a prior run
      // can't leak state into this one. Chromium has no app lifecycle to
      // restart (the renderer is always live), so fall back to `launch-app`
      // there. Fragments inherit whatever app the caller already has open.
      if (isE2eFlow(flow)) {
        const bundleId = appIdForPlatform(flow.launch, device.platform);
        if (!bundleId) {
          throw new FailureError(
            `Flow "${params.name}" declares no app id for platform "${device.platform}". Add a launch entry for it.`,
            {
              error_code: FAILURE_CODES.FLOW_APP_ID_MISSING,
              failure_stage: "flow_app_launch",
              failure_area: "tool_server",
              error_kind: "validation",
            }
          );
        }
        const launchTool = device.platform === "chromium" ? "launch-app" : "restart-app";
        await invokeSubTool(
          registry,
          ctx,
          launchTool,
          bindDeviceArgs(registry, launchTool, device.id, { bundleId })
        );
        // Pin right after the relaunch.
        statusBarPinned = await pinStatusBar(device);
        // Let the app finish coming up before step 1 reads/acts on the UI, so a
        // slow cold start doesn't eat into the first step's auto-wait budget.
        await sleepOrAbort(POST_LAUNCH_SETTLE_MS, signal);
        // Flows resolve selectors against the native UIView hierarchy, which the
        // injected dylib serves over a connection it opens asynchronously — wait
        // for it so step 1 doesn't race the cold start. If it never connects,
        // selectors would silently fall back to the AX tree (which drops testID
        // containers), so fail outright rather than run against the wrong tree.
        if (device.platform === "ios" && !signal?.aborted) {
          const connected = await waitForNativeDevtools(registry, device, bundleId, signal);
          if (!connected && !signal?.aborted) {
            if (statusBarPinned) await restoreStatusBar(device);
            throw new FailureError(
              `Flow "${params.name}" could not connect to native devtools for ${bundleId}. Re-run to relaunch the app and retry. ` +
                `If it keeps failing, a stale or duplicate argent server may be holding the devtools connection — restart the argent server and try again.`,
              {
                error_code: FAILURE_CODES.FLOW_NATIVE_DEVTOOLS_UNAVAILABLE,
                failure_stage: "flow_native_devtools_connect",
                failure_area: "tool_server",
                error_kind: "timeout",
              }
            );
          }
        }
        // Android resolves testID selectors against the full accessibility
        // hierarchy served by the android-devtools helper. If the helper can't
        // run, selectors silently fall back to the trimmed AX tree (which drops
        // testID-bearing not-important containers), so probe for it up front and
        // fail explicitly rather than degrade — the iOS gate's rationale, minus
        // the poll (the helper spawns synchronously, so there's no race).
        if (device.platform === "android" && !signal?.aborted) {
          const ready = await androidDevtoolsReady(registry, device);
          if (!ready && !signal?.aborted) {
            if (statusBarPinned) await restoreStatusBar(device);
            throw new FailureError(
              `Flow "${params.name}" could not reach the Android devtools helper (full-hierarchy source for testID selectors). ` +
                `Confirm the device is unlocked and the argent helper can be installed (\`adb install -t\`); a locked device or a blocked install is the usual cause. Re-run once resolved.`,
              {
                error_code: FAILURE_CODES.FLOW_NATIVE_DEVTOOLS_UNAVAILABLE,
                failure_stage: "flow_native_devtools_connect",
                failure_area: "tool_server",
                error_kind: "dependency_missing",
              }
            );
          }
        }
      } else {
        // Fragment run directly (no relaunch): pin before the first step runs.
        statusBarPinned = await pinStatusBar(device);
      }

      const state: ExecState = {
        registry,
        ctx,
        device,
        signal,
        flowsDir,
        topFlowName: params.name,
        updateBaselines: Boolean(params.updateBaselines),
        reports: [],
        stopped: false,
        pinned: statusBarPinned,
      };

      try {
        await execSteps(state, flow.steps, params.name, [params.name]);
      } finally {
        if (state.pinned) await restoreStatusBar(device);
      }

      return summarize(params.name, device.id, flow.executionPrerequisite, state.reports);
    },
  };
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
  for (const s of steps) {
    if (s.status === "pass") passed++;
    else if (s.status === "fail") failed++;
    else if (s.status === "skip") skipped++;
    else errored++;
  }
  return {
    flow: flowName,
    device: deviceId,
    executionPrerequisite,
    ok: failed === 0 && errored === 0,
    passed,
    failed,
    skipped,
    errored,
    steps,
  };
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
      state.reports.push({ index, kind: step.kind, status: "skip", flow: sourceFlow });
      continue;
    }
    if (state.signal?.aborted) {
      state.stopped = true;
      state.reports.push({
        index,
        kind: step.kind,
        status: "skip",
        reason: "run aborted",
        flow: sourceFlow,
      });
      continue;
    }

    if (step.kind === "run") {
      await execRunStep(state, step, sourceFlow, runStack);
      continue;
    }

    const report = await execLeafStep(state, step, index, sourceFlow);
    state.reports.push(report);
    if (report.status === "fail" || report.status === "error") state.stopped = true;
  }
}

async function execRunStep(
  state: ExecState,
  step: Extract<FlowStep, { kind: "run" }>,
  sourceFlow: string,
  runStack: string[]
): Promise<void> {
  const index = state.reports.length;
  const target = step.flow;

  if (runStack.includes(target)) {
    state.reports.push({
      index,
      kind: "run",
      status: "error",
      flow: target,
      reason: `cyclic flow reference: ${[...runStack, target].join(" → ")}`,
    });
    state.stopped = true;
    return;
  }
  if (runStack.length >= MAX_RUN_DEPTH) {
    state.reports.push({
      index,
      kind: "run",
      status: "error",
      flow: target,
      reason: "max run depth exceeded",
    });
    state.stopped = true;
    return;
  }

  let fragment: FlowFile;
  try {
    assertSafeFlowName(target);
    const fragPath = path.join(state.flowsDir, `${target}.yaml`);
    fragment = parseFlow(await fs.readFile(fragPath, "utf8"));
  } catch (err) {
    state.reports.push({
      index,
      kind: "run",
      status: "error",
      flow: target,
      reason: `could not load fragment "${target}": ${err instanceof Error ? err.message : String(err)}`,
    });
    state.stopped = true;
    return;
  }

  if (isE2eFlow(fragment)) {
    state.reports.push({
      index,
      kind: "run",
      status: "error",
      flow: target,
      reason: `"${target}" is an e2e flow (declares launch); only fragments can be run from another flow`,
    });
    state.stopped = true;
    return;
  }

  // Marker for the composition point, then expand the fragment's steps inline.
  state.reports.push({ index, kind: "run", status: "pass", flow: target });
  await execSteps(state, fragment.steps, target, [...runStack, target]);
}

async function execLeafStep(
  state: ExecState,
  step: FlowStep,
  index: number,
  sourceFlow: string
): Promise<StepReport> {
  const base = { index, kind: step.kind, flow: sourceFlow } as const;
  const { registry, ctx, device, signal } = state;

  switch (step.kind) {
    case "echo":
      return { ...base, status: "pass", message: step.message };

    case "tap": {
      const r = await runTap(
        registry,
        ctx,
        device,
        { selector: step.selector, x: step.x, y: step.y },
        signal
      );
      return { ...base, status: r.ok ? "pass" : "fail", reason: r.reason };
    }

    case "type": {
      const r = await runType(registry, ctx, device, step.into, step.text, step.submit, signal);
      return { ...base, status: r.ok ? "pass" : "fail", reason: r.reason };
    }

    case "assert": {
      const r = await runAssert(
        registry,
        device,
        step.condition,
        step.selector,
        step.expectedText,
        step.textMatch,
        signal
      );
      return { ...base, status: r.ok ? "pass" : "fail", reason: r.reason };
    }

    case "scroll-to": {
      const r = await runScrollTo(
        registry,
        ctx,
        device,
        { target: step.target, direction: step.direction, within: step.within },
        signal
      );
      return { ...base, status: r.ok ? "pass" : "fail", reason: r.reason };
    }

    case "wait": {
      if (!(await sleepOrAbort(step.ms, signal))) {
        return { ...base, status: "skip", reason: "run aborted during wait" };
      }
      return { ...base, status: "pass" };
    }

    case "await": {
      const args = bindDeviceArgs(registry, AWAIT_UI_ELEMENT_TOOL_ID, device.id, {
        condition: step.condition,
        selector: step.selector,
        ...(step.expectedText !== undefined ? { expectedText: step.expectedText } : {}),
        ...(step.textMatch !== undefined ? { textMatch: step.textMatch } : {}),
      });
      try {
        const result = await invokeSubTool(registry, ctx, AWAIT_UI_ELEMENT_TOOL_ID, args);
        if (isUnmetUiWaitResult(AWAIT_UI_ELEMENT_TOOL_ID, result)) {
          const note = (result as { note?: string }).note;
          return {
            ...base,
            status: "fail",
            tool: AWAIT_UI_ELEMENT_TOOL_ID,
            reason: note ?? "condition not met",
          };
        }
        return { ...base, status: "pass", tool: AWAIT_UI_ELEMENT_TOOL_ID, result };
      } catch (err) {
        return { ...base, status: "error", tool: AWAIT_UI_ELEMENT_TOOL_ID, reason: errMsg(err) };
      }
    }

    case "snapshot": {
      try {
        const r = await runSnapshot(
          registry,
          ctx,
          device,
          {
            flowsDir: state.flowsDir,
            flowName: state.topFlowName,
            name: step.name,
            maxMismatch: step.maxMismatch ?? DEFAULT_MAX_MISMATCH,
            updateBaselines: state.updateBaselines,
          },
          signal
        );
        return { ...base, status: r.status, reason: r.reason, artifacts: r.artifacts };
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
 * Prefer the boundary-resolved `flow_file`; fall back to deriving the path from
 * project_root + name. The name is validated in both branches.
 */
export function resolveFlowFilePath(params: {
  name: string;
  project_root: string;
  flow_file?: string;
}): string {
  assertSafeFlowName(params.name);
  if (params.flow_file) return params.flow_file;
  setActiveProjectRoot(params.project_root);
  return getFlowPath(params.name);
}
