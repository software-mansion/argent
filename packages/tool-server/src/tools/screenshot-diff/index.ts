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
import { resolveDevice } from "../../utils/device-info";
import { httpScreenshot } from "../../utils/simulator-client";
import { captureScreenshotUpright } from "../../utils/rotation-aware-capture";
import { androidDevtoolsRotationPeek } from "../../utils/android-devtools-rotation-peek";
import type { RotationPeek } from "../../utils/device-orientation";
import { requireArtifacts, type ArtifactHandle } from "../../artifacts";
import { diffPngFiles } from "./screenshot-diff";

const zodSchema = z
  .object({
    baselinePath: z
      .string()
      .min(1)
      .optional()
      .describe("Path to the baseline PNG file. Required unless captureBaseline is true."),
    currentPath: z
      .string()
      .min(1)
      .optional()
      .describe("Path to the current PNG file. Required unless captureCurrent is true."),
    udid: z
      .string()
      .min(1)
      .describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
    captureBaseline: z.coerce
      .boolean()
      .optional()
      .describe(
        "Capture the baseline screenshot live at full resolution before diffing. Cannot be combined with captureCurrent."
      ),
    captureCurrent: z.coerce
      .boolean()
      .optional()
      .describe(
        "Capture the current screenshot live at full resolution before diffing. Cannot be combined with captureBaseline."
      ),
    rotation: z
      .enum(["Portrait", "LandscapeLeft", "LandscapeRight", "PortraitUpsideDown"])
      .optional()
      .describe("Orientation override for live baseline/current captures."),
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
  description: `Compare two PNG screenshots and return a compact visual-diff summary.
Accepts saved baseline/current PNG paths, or one saved PNG plus one live full-resolution capture from a device. Always provide udid so the simulator-server dependency can be resolved.
Use when stable before/after screenshots exist and the expected result is pixel-visible: layout, spacing, color, typography, image/icon rendering, clipping, overflow, or text rendering.
For live captures, set exactly one of captureBaseline or captureCurrent; use baselinePath + captureCurrent for the common visual-regression flow.
Returns { summary, diffPath, contextDiffPath }. The summary uses normalized [0,1] screen locations matching describe coordinates; diffPath is the full-size diff image and contextDiffPath is a downscaled image for MCP/agent display.
Ignores the fixed top status-bar band for both pixel and OCR text comparisons.
Fails if the input sources are invalid, PNG files cannot be read, outputDir cannot be written, or the simulator-server / emulator backend is not reachable.`,
  searchHint:
    "compare screenshots png diff visual UI changes UI regression visual regression screenshot diff changed regions text ocr live capture",
  zodSchema,
  capability,
  fileInputs,
  services: (params): Record<string, ServiceRef> => {
    // Requesting the SimulatorServer unconditionally would resolve (and start) it
    // even for pure static-PNG diffs, which fails on tvOS simulators that have no
    // SimulatorServer backend.
    if (params.captureBaseline || params.captureCurrent) {
      return { simulatorServer: simulatorServerRef(resolveDevice(params.udid)) };
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

  const { baselinePath, currentPath } = await resolveInputPaths(
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
    summary: result.summary,
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
): Promise<{ baselinePath: string; currentPath: string }> {
  validateInputSources(params);

  const baselinePath = params.captureBaseline
    ? await captureLiveInput({
        api: requireSimulatorServer(services),
        device: resolveDevice(params.udid),
        peekFor,
        outputDir,
        name: "baseline",
        rotation: params.rotation,
        signal: options?.signal,
        captureScreenshot,
      })
    : params.baselinePath!;

  const currentPath = params.captureCurrent
    ? await captureLiveInput({
        api: requireSimulatorServer(services),
        device: resolveDevice(params.udid),
        peekFor,
        outputDir,
        name: "current",
        rotation: params.rotation,
        signal: options?.signal,
        captureScreenshot,
      })
    : params.currentPath!;

  return { baselinePath, currentPath };
}

function validateInputSources(params: Params): void {
  const invalid = (message: string, stage: string): FailureError =>
    new FailureError(message, {
      error_code: FAILURE_CODES.SCREENSHOT_DIFF_INPUT_INVALID,
      failure_stage: stage,
      failure_area: "tool_server",
      error_kind: "validation",
    });
  if (params.captureBaseline && params.captureCurrent) {
    throw invalid(
      "captureBaseline and captureCurrent cannot both be true; provide one saved image path and capture the other side live.",
      "screenshot_diff_both_captures"
    );
  }
  if (params.captureBaseline && params.baselinePath) {
    throw invalid(
      "Provide either baselinePath or captureBaseline, not both.",
      "screenshot_diff_baseline_conflict"
    );
  }
  if (params.captureCurrent && params.currentPath) {
    throw invalid(
      "Provide either currentPath or captureCurrent, not both.",
      "screenshot_diff_current_conflict"
    );
  }
  if (!params.captureBaseline && !params.baselinePath) {
    throw invalid(
      "baselinePath is required unless captureBaseline is true.",
      "screenshot_diff_baseline_missing"
    );
  }
  if (!params.captureCurrent && !params.currentPath) {
    throw invalid(
      "currentPath is required unless captureCurrent is true.",
      "screenshot_diff_current_missing"
    );
  }
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
