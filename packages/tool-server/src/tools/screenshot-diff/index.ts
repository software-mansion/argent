import crypto from "node:crypto";
import fs from "fs/promises";
import os from "node:os";
import path from "path";
import { z } from "zod";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import type {
  DeviceInfo,
  FileInputSpec,
  Registry,
  ServiceRef,
  ToolContext,
  ToolCapability,
  ToolDefinition,
} from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { iosDeviceRunnerRef, type IosDeviceRunnerApi } from "../../blueprints/ios-device-runner";
import { isIosPhysicalDevice, resolveDevice } from "../../utils/device-info";
import { captureRunnerScreenshotPng } from "../../utils/ios-device/runner-commands";
import { RUNNER_COMMAND_TIMEOUT_MS } from "../../utils/ios-device/runner-client";
import { httpScreenshot } from "../../utils/simulator-client";
import { captureScreenshotUpright } from "../../utils/rotation-aware-capture";
import { androidDevtoolsRotationPeek } from "../../utils/android-devtools-rotation-peek";
import type { RotationPeek } from "../../utils/device-orientation";
import { requireArtifacts, type ArtifactHandle } from "../../artifacts";
import { diffPngFiles } from "./screenshot-diff";
import { getStagedBaseline, stageBaseline, type StagedBaseline } from "./staged-baselines";

const zodSchema = z
  .object({
    baselinePath: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Path to the baseline PNG file. Omit to compare against the baseline staged for this udid by an earlier captureBaseline call."
      ),
    currentPath: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Path to the current PNG file. Omit when capturing the current side live with captureCurrent, or when the call only stages a baseline."
      ),
    udid: z
      .string()
      .min(1)
      .describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
    captureBaseline: z.coerce
      .boolean()
      .optional()
      .describe(
        "Capture the baseline screenshot live. With a current side it is diffed straight away; with no current side (no currentPath, no captureCurrent) it is staged for this udid and the call returns without comparing. Cannot be combined with captureCurrent."
      ),
    captureCurrent: z.coerce
      .boolean()
      .optional()
      .describe(
        "Capture the current screenshot live before diffing. With no baseline side it is compared against the baseline staged for this udid. Cannot be combined with captureBaseline."
      ),
    rotation: z
      .enum(["Portrait", "LandscapeLeft", "LandscapeRight", "PortraitUpsideDown"])
      .optional()
      .describe(
        "Orientation override for live baseline/current captures. Ignored on physical iPhones."
      ),
    outputDir: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Directory where diff artifacts should be written. Optional — defaults to a temp directory; the diff images are returned in the result either way."
      ),
  })
  .strict();

type Params = z.infer<typeof zodSchema>;

interface ScreenshotDiffResult {
  summary: string;
  /**
   * Artifact handles, not host paths: the client materializes them locally so the
   * agent can open them — and the MCP adapter can inline the context diff — even
   * when the tool-server is remote.
   */
  diffPath?: ArtifactHandle;
  contextDiffPath?: ArtifactHandle;
}

type CaptureScreenshot = typeof httpScreenshot;

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
};

/**
 * The saved PNGs live on the AGENT's machine, so both path params cross the file
 * boundary as `file` inputs. `outputDir` is only probed — see resolveOutputDir.
 */
const fileInputs: FileInputSpec[] = [
  { target: "baselinePath", path: "${baselinePath}", kind: "file", optional: true },
  { target: "currentPath", path: "${currentPath}", kind: "file", optional: true },
  { target: "outputDir", path: "${outputDir}", kind: "probe", optional: true },
];

export const screenshotDiffTool: ToolDefinition<Params, ScreenshotDiffResult> = {
  id: "screenshot-diff",
  interaction: {
    startedMsg: () => "Comparing screenshots",
    completedMsg: () => "Compared screenshots",
    failedMsg: ({ failureSignal }) => `Failed to compare screenshots: ${failureSignal.error_code}`,
  },
  description: `Compare two PNG screenshots and return a compact visual-diff summary, or stage a live baseline for a later comparison.
Accepts saved baseline/current PNG paths, or a live capture from a device on either side. Always provide udid so the capture backend can be resolved.
Use when stable before/after screenshots exist and the expected result is pixel-visible: layout, spacing, color, typography, image/icon rendering, clipping, overflow, or text rendering.
For the visual-regression flow, call it twice: captureBaseline: true with no current side stages the baseline for this udid, then captureCurrent: true with no baseline side compares the live screen against it. Set at most one of captureBaseline or captureCurrent per call.
Physical iPhones: live captures are device-wide and need no registered app. Keep baselines per device model; different aspect ratios fail as a dimension mismatch.
Returns { summary, diffPath, contextDiffPath }; a staging call returns { summary } alone. The summary uses normalized [0,1] screen locations matching describe coordinates; diffPath is the full-size diff image and contextDiffPath is a downscaled image for MCP/agent display. A comparison against a staged baseline opens with that baseline's udid, capture time and age.
Ignores the fixed top status-bar band for both pixel and OCR text comparisons.
Fails if the input sources are invalid, no baseline is staged for the udid, PNG files cannot be read, outputDir cannot be written, or the simulator-server / emulator backend is not reachable.`,
  searchHint:
    "compare screenshots png diff visual UI changes UI regression visual regression screenshot diff changed regions text ocr live capture",
  zodSchema,
  capability,
  fileInputs,
  services: (params): Record<string, ServiceRef> => {
    // Only a live capture needs a capture backend. Requesting one
    // unconditionally would resolve and start it even for pure static-PNG
    // diffs, which fails on tvOS simulators that have no SimulatorServer
    // backend and would build the XCUITest runner for a diff that never
    // touches the device.
    if (params.captureBaseline || params.captureCurrent) {
      const device = resolveDevice(params.udid);
      if (isIosPhysicalDevice(device)) {
        return { iosDeviceRunner: iosDeviceRunnerRef(device) };
      }
      return { simulatorServer: simulatorServerRef(device) };
    }
    return {};
  },
  async execute(services, params, options) {
    return executeScreenshotDiffTool(services, params, options);
  },
};

/**
 * The registered form: same tool, but live captures can read a rotated Android
 * device's rotation from the android-devtools helper when it is already running
 * (~1 ms) instead of probing over adb (~8 ms). `screenshotDiffTool` itself stays
 * registry-free for callers and tests that have no registry.
 */
export function createScreenshotDiffTool(
  registry: Registry
): ToolDefinition<Params, ScreenshotDiffResult> {
  return {
    ...screenshotDiffTool,
    async execute(services, params, options) {
      return executeScreenshotDiffTool(services, params, options, httpScreenshot, (device) =>
        androidDevtoolsRotationPeek(registry, device)
      );
    },
  };
}

export async function executeScreenshotDiffTool(
  services: Record<string, unknown>,
  params: Params,
  options?: Partial<ToolContext>,
  captureScreenshot: CaptureScreenshot = httpScreenshot,
  peekFor?: (device: DeviceInfo) => RotationPeek
): Promise<ScreenshotDiffResult> {
  const outputDir = await resolveOutputDir(params, options);

  if (classifyInputSources(params) === "stage-baseline") {
    const staged = stageBaseline(
      params.udid,
      await captureLiveSide(
        "baseline",
        services,
        params,
        outputDir,
        options,
        captureScreenshot,
        peekFor
      )
    );
    return { summary: formatStagedBaselineSummary(params.udid, staged) };
  }

  const { baselinePath, currentPath, staged } = await resolveInputPaths(
    services,
    params,
    outputDir,
    options,
    captureScreenshot,
    peekFor
  );

  const result = await diffPngFiles({
    baselinePath,
    currentPath,
    outputDir,
  });

  const artifacts = requireArtifacts(options);
  return {
    summary: staged
      ? `${formatStagedBaselineProvenance(params.udid, staged)}\n\n${result.summary}`
      : result.summary,
    ...(result.diffPath
      ? {
          diffPath: await artifacts.register({
            hostPath: result.diffPath,
            kind: "screenshot-diff",
            mimeType: "image/png",
          }),
        }
      : {}),
    ...(result.contextDiffPath
      ? {
          contextDiffPath: await artifacts.register({
            hostPath: result.contextDiffPath,
            kind: "screenshot-diff-context",
            mimeType: "image/png",
          }),
        }
      : {}),
  };
}

/**
 * An agent-supplied outputDir is honored when it is usable on this host;
 * everything else gets a per-call temp dir (the diffs travel back as artifacts
 * either way).
 *
 * The probe only answers "does this path already exist here", so a local agent
 * naming a fresh directory is indistinguishable from a remote client's own path —
 * both come back `presentOnHost: false`. The non-recursive mkdir separates them:
 * it succeeds only when the parent already exists here.
 */
async function resolveOutputDir(params: Params, options?: Partial<ToolContext>): Promise<string> {
  const probe = options?.fileInputs?.outputDir;
  if (params.outputDir && (probe === undefined || probe.presentOnHost)) {
    return params.outputDir;
  }
  if (params.outputDir) {
    try {
      await fs.mkdir(params.outputDir);
      return params.outputDir;
    } catch (err) {
      // EEXIST: it appeared since the probe — still a usable host directory.
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return params.outputDir;
      // Missing parent or unwritable: not a meaningful path here — use temp below.
    }
  }
  const dir = path.join(
    os.tmpdir(),
    "argent-screenshot-diff",
    crypto.randomBytes(6).toString("hex")
  );
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function resolveInputPaths(
  services: Record<string, unknown>,
  params: Params,
  outputDir: string,
  options: Partial<ToolContext> | undefined,
  captureScreenshot: CaptureScreenshot,
  peekFor?: (device: DeviceInfo) => RotationPeek
): Promise<{ baselinePath: string; currentPath: string; staged?: StagedBaseline }> {
  const staged =
    params.captureBaseline || params.baselinePath ? undefined : await requireStaged(params.udid);

  const baselinePath = params.captureBaseline
    ? await captureLiveSide(
        "baseline",
        services,
        params,
        outputDir,
        options,
        captureScreenshot,
        peekFor
      )
    : (staged?.path ?? params.baselinePath!);
  const currentPath = params.captureCurrent
    ? await captureLiveSide(
        "current",
        services,
        params,
        outputDir,
        options,
        captureScreenshot,
        peekFor
      )
    : params.currentPath!;

  return { baselinePath, currentPath, ...(staged && { staged }) };
}

/**
 * Route a live capture to the right backend for the device: the on-device
 * XCUITest runner for a physical iPhone, the simulator-server for simulators and
 * Android. Shared by the staging branch and the two-sided comparison so both
 * reach the same backend for a given udid.
 */
function captureLiveSide(
  name: "baseline" | "current",
  services: Record<string, unknown>,
  params: Params,
  outputDir: string,
  options: Partial<ToolContext> | undefined,
  captureScreenshot: CaptureScreenshot,
  peekFor?: (device: DeviceInfo) => RotationPeek
): Promise<string> {
  const device = resolveDevice(params.udid);
  if (isIosPhysicalDevice(device)) {
    return captureIosDeviceLiveInput({
      runner: requireIosDeviceRunner(services),
      outputDir,
      name,
    });
  }
  return captureLiveInput({
    api: requireSimulatorServer(services),
    device,
    peekFor,
    outputDir,
    name,
    rotation: params.rotation,
    signal: options?.signal,
    captureScreenshot,
  });
}

function invalidInput(message: string, stage: string): FailureError {
  return new FailureError(message, {
    error_code: FAILURE_CODES.SCREENSHOT_DIFF_INPUT_INVALID,
    failure_stage: stage,
    failure_area: "tool_server",
    error_kind: "validation",
  });
}

/**
 * Which of the two shapes the call is, rejecting everything that is neither.
 *
 * The conflict checks run first on purpose: a call that names a baseline BOTH
 * ways still has no current side, so testing for staging ahead of them would
 * accept it and ignore the `baselinePath` it was given.
 */
function classifyInputSources(params: Params): "stage-baseline" | "diff" {
  if (params.captureBaseline && params.captureCurrent) {
    throw invalidInput(
      "captureBaseline and captureCurrent cannot both be true; stage the baseline in one call, then capture the current side in the next.",
      "screenshot_diff_both_captures"
    );
  }
  if (params.captureBaseline && params.baselinePath) {
    throw invalidInput(
      "Provide either baselinePath or captureBaseline, not both.",
      "screenshot_diff_baseline_conflict"
    );
  }
  if (params.captureCurrent && params.currentPath) {
    throw invalidInput(
      "Provide either currentPath or captureCurrent, not both.",
      "screenshot_diff_current_conflict"
    );
  }
  // The conflict check above rejects `captureCurrent` with `currentPath`, so
  // this reads as "the call named a current side", not "it named exactly one".
  const hasCurrentSide = Boolean(params.captureCurrent) || Boolean(params.currentPath);
  if (params.captureBaseline && !hasCurrentSide) return "stage-baseline";
  if (!hasCurrentSide) {
    throw invalidInput(
      "currentPath is required unless captureCurrent is true, or captureBaseline is staging a baseline for a later call.",
      "screenshot_diff_current_missing"
    );
  }
  return "diff";
}

/**
 * The baseline a `captureBaseline`-only call left for this device. A missing or
 * reaped one is a hard failure rather than a silent live re-capture: the whole
 * point of the staged baseline is that it predates the change under test.
 */
async function requireStaged(udid: string): Promise<StagedBaseline> {
  const staged = getStagedBaseline(udid);
  if (!staged) {
    throw invalidInput(
      `No baseline is staged for ${udid}. Pass baselinePath, or stage one first by calling screenshot-diff with captureBaseline: true and no current side.`,
      "screenshot_diff_no_staged_baseline"
    );
  }
  try {
    await fs.access(staged.path);
  } catch {
    throw invalidInput(
      `The baseline staged for ${udid} at ${new Date(staged.capturedAt).toISOString()} is no longer on disk. Stage a new one by calling screenshot-diff with captureBaseline: true and no current side.`,
      "screenshot_diff_staged_baseline_gone"
    );
  }
  return staged;
}

function formatStagedBaselineSummary(udid: string, staged: StagedBaseline): string {
  return [
    "Screenshot diff baseline staged",
    "",
    "Baseline:",
    `- staged_baseline: udid=${udid} captured_at=${new Date(staged.capturedAt).toISOString()} file=${path.basename(staged.path)}`,
    "- no comparison ran, so this result carries no diff images",
    "- next: call screenshot-diff again for this udid with a current side (captureCurrent: true, or currentPath) and no baseline side",
    "- it stays staged until another staging call for this udid replaces it, or the tool-server stops",
  ].join("\n");
}

/**
 * Leads the diff summary rather than trailing it: a staged baseline is the one
 * input the call does not name, so its age is read before the figures measured
 * against it.
 */
function formatStagedBaselineProvenance(udid: string, staged: StagedBaseline): string {
  const ageSeconds = Math.max(0, Math.round((Date.now() - staged.capturedAt) / 1000));
  return [
    "Baseline:",
    `- staged_baseline: udid=${udid} captured_at=${new Date(staged.capturedAt).toISOString()} age_seconds=${ageSeconds} file=${path.basename(staged.path)}`,
    "  - captured by an earlier screenshot-diff staging call, not by this one; everything the screen did since captured_at is inside this diff",
  ].join("\n");
}

// On the registry path the service is always resolved before a live-capture branch
// runs, so this can only trip a direct caller of the exported
// executeScreenshotDiffTool (e.g. a test) — hence a plain Error with no failure
// code, which could never bucket a real failure.
function requireSimulatorServer(services: Record<string, unknown>): SimulatorServerApi {
  const api = services.simulatorServer as SimulatorServerApi | undefined;
  if (!api) {
    throw new Error("Live screenshot capture requires a simulatorServer service.");
  }
  return api;
}

// Same reasoning as requireSimulatorServer. The registry resolves the runner
// before a physical-device live capture runs, so only a direct caller of the
// exported executeScreenshotDiffTool can trip this.
function requireIosDeviceRunner(services: Record<string, unknown>): IosDeviceRunnerApi {
  const runner = services.iosDeviceRunner as IosDeviceRunnerApi | undefined;
  if (!runner) {
    throw new Error(
      "Live screenshot capture on a physical iPhone requires an iosDeviceRunner service."
    );
  }
  return runner;
}

/**
 * Physical-iOS live capture through the on-device XCUITest runner. The runner
 * returns one full-resolution device-wide PNG, so no app session is required
 * and the simulator scale fallback does not apply. The rotation parameter is
 * deliberately not forwarded, because the capture always follows the device's
 * real orientation, the same behaviour as the screenshot tool on hardware.
 */
async function captureIosDeviceLiveInput(params: {
  runner: IosDeviceRunnerApi;
  outputDir: string;
  name: "baseline" | "current";
}): Promise<string> {
  const png = await captureRunnerScreenshotPng(params.runner, RUNNER_COMMAND_TIMEOUT_MS);
  const suffix = crypto.randomBytes(4).toString("hex");
  const destination = path.join(params.outputDir, `${params.name}-${suffix}.live.png`);
  await fs.mkdir(params.outputDir, { recursive: true });
  await fs.writeFile(destination, png);
  return destination;
}

async function captureLiveInput(params: {
  api: SimulatorServerApi;
  // Needed so a live capture picks up the device's rotation the same way the
  // `screenshot` tool does. Without it a rotated-Android `captureCurrent` would
  // come back sideways and diff at ~100% against an upright saved baseline.
  device: DeviceInfo;
  peekFor?: (device: DeviceInfo) => RotationPeek;
  outputDir: string;
  name: "baseline" | "current";
  rotation?: Params["rotation"];
  signal?: AbortSignal;
  captureScreenshot: CaptureScreenshot;
}): Promise<string> {
  // Full-res gives the best diff fidelity, but some Android emulators reject a
  // full-res frame ("wrong data size" framebuffer mismatch), which broke the whole
  // baselinePath + captureCurrent flow there. The server's default scale captures
  // reliably, and diffPngFiles' same-aspect normalization keeps a scaled capture
  // comparable to a baseline saved at any scale.
  let capture: Awaited<ReturnType<CaptureScreenshot>>;
  try {
    capture = await captureScreenshotUpright(
      params.api,
      params.device,
      params.rotation,
      params.signal,
      1.0,
      params.captureScreenshot,
      params.peekFor?.(params.device)
    );
  } catch {
    capture = await captureScreenshotUpright(
      params.api,
      params.device,
      params.rotation,
      params.signal,
      undefined,
      params.captureScreenshot,
      params.peekFor?.(params.device)
    );
  }
  const suffix = crypto.randomBytes(4).toString("hex");
  const destination = path.join(params.outputDir, `${params.name}-${suffix}.live.png`);
  await fs.mkdir(params.outputDir, { recursive: true });
  await fs.copyFile(capture.path, destination);
  return destination;
}
