import crypto from "node:crypto";
import fs from "fs/promises";
import os from "node:os";
import path from "path";
import { z } from "zod";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import type {
  FileInputSpec,
  ServiceRef,
  ToolContext,
  ToolCapability,
  ToolDefinition,
} from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import {
  physicalIosAutomationRef,
  type PhysicalIosAutomationApi,
} from "../../blueprints/physical-ios-automation";
import { isPhysicalIos, resolveDevice } from "../../utils/device-info";
import { httpScreenshot } from "../../utils/simulator-client";
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

export interface ScreenshotDiffResult {
  summary: string;
  /**
   * Artifact handles (not raw host paths): the client materializes the diff
   * images to files on ITS machine, so the agent can open them — and the MCP
   * adapter can inline `contextDiff` — even when the tool-server is remote.
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
 * The saved PNGs live on the AGENT's machine (typically materialized there by
 * an earlier full-res `screenshot` call), so both path params cross the file
 * boundary as `file` inputs. `outputDir` is only probed: when the agent-chosen
 * directory doesn't exist on this host (remote mode), the tool quietly falls
 * back to its temp default rather than recreating an agent-side path here.
 */
const fileInputs: FileInputSpec[] = [
  { target: "baselinePath", path: "${baselinePath}", kind: "file", optional: true },
  { target: "currentPath", path: "${currentPath}", kind: "file", optional: true },
  { target: "outputDir", path: "${outputDir}", kind: "probe", optional: true },
];

export const screenshotDiffTool: ToolDefinition<Params, ScreenshotDiffResult> = {
  id: "screenshot-diff",
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
    // Only request the SimulatorServer when a live capture is actually needed.
    // Requesting it unconditionally causes it to be resolved (and started) even
    // for pure static-PNG diffs, which fails on tvOS simulators that have no
    // SimulatorServer backend.
    if (params.captureBaseline || params.captureCurrent) {
      const device = resolveDevice(params.udid);
      return isPhysicalIos(device)
        ? { physicalIos: physicalIosAutomationRef(device) }
        : { simulatorServer: simulatorServerRef(device) };
    }
    return {};
  },
  async execute(services, params, options) {
    return executeScreenshotDiffTool(services, params, options);
  },
};

export async function executeScreenshotDiffTool(
  services: Record<string, unknown>,
  params: Params,
  options?: Partial<ToolContext>,
  captureScreenshot: CaptureScreenshot = httpScreenshot
): Promise<ScreenshotDiffResult> {
  const outputDir = await resolveOutputDir(params, options);

  const { baselinePath, currentPath } = await resolveInputPaths(
    services,
    params,
    outputDir,
    options,
    captureScreenshot
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
      ? { diffPath: await artifacts.register(result.diffPath, { mimeType: "image/png" }) }
      : {}),
    ...(result.contextDiffPath
      ? {
          contextDiffPath: await artifacts.register(result.contextDiffPath, {
            mimeType: "image/png",
          }),
        }
      : {}),
  };
}

/**
 * Where diff artifacts (and live-capture intermediates) are written on this
 * host. An agent-supplied outputDir is honored when it is usable here — i.e.
 * not flagged absent by the boundary probe (a remote client's local directory).
 * Everything else gets a per-call temp dir; the diff images travel back as
 * artifacts, so the directory's location no longer matters to the agent.
 */
async function resolveOutputDir(params: Params, options?: Partial<ToolContext>): Promise<string> {
  const probe = options?.fileInputs?.outputDir;
  if (params.outputDir && (probe === undefined || probe.presentOnHost)) {
    return params.outputDir;
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
  captureScreenshot: CaptureScreenshot
): Promise<{ baselinePath: string; currentPath: string }> {
  validateInputSources(params);

  const baselinePath = params.captureBaseline
    ? await captureLiveInput({
        api: services.physicalIos ? undefined : requireSimulatorServer(services),
        physicalIos: services.physicalIos as PhysicalIosAutomationApi | undefined,
        outputDir,
        name: "baseline",
        rotation: params.rotation,
        signal: options?.signal,
        captureScreenshot,
      })
    : params.baselinePath!;

  const currentPath = params.captureCurrent
    ? await captureLiveInput({
        api: services.physicalIos ? undefined : requireSimulatorServer(services),
        physicalIos: services.physicalIos as PhysicalIosAutomationApi | undefined,
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

// simulatorServer is declared as an unconditional service dependency, so the
// registry resolves it before execute() runs. Guard anyway: executeScreenshotDiffTool
// is exported and a direct caller (e.g. a test) can pass a services map without it —
// a clear error beats a downstream TypeError on `.captureScreenshot`. Only the
// live-capture branches call this, so non-capture diffs never require the service.
// Because the service is always resolved on the registry path, this can only trip
// for a direct/test caller (never the telemetry path), so it stays a plain Error
// without a code — a code here could never bucket a real failure.
function requireSimulatorServer(services: Record<string, unknown>): SimulatorServerApi {
  const api = services.simulatorServer as SimulatorServerApi | undefined;
  if (!api) {
    throw new Error("Live screenshot capture requires a simulatorServer service.");
  }
  return api;
}

async function captureLiveInput(params: {
  // Resolved and validated by requireSimulatorServer at the call site, so it is
  // never undefined here.
  api?: SimulatorServerApi;
  physicalIos?: PhysicalIosAutomationApi;
  outputDir: string;
  name: "baseline" | "current";
  rotation?: Params["rotation"];
  signal?: AbortSignal;
  captureScreenshot: CaptureScreenshot;
}): Promise<string> {
  // Prefer a full-resolution capture for maximum diff fidelity. Some Android
  // emulator configurations cannot stream a full-res frame — the simulator-server
  // rejects it with a "wrong data size" framebuffer mismatch — which previously
  // made the entire baselinePath + captureCurrent flow unusable on Android. Fall
  // back to the server's default scale, which captures reliably; same-aspect
  // normalization in diffPngFiles keeps a scaled capture diff-compatible with a
  // baseline saved at any scale. Full-res is preserved wherever it works (iOS).
  let capture: Awaited<ReturnType<CaptureScreenshot>>;
  if (params.physicalIos) {
    if (params.rotation) await params.physicalIos.rotate(params.rotation);
    await params.physicalIos.flushControls();
    const physicalCapture = await params.physicalIos.screenshot();
    capture = { ...physicalCapture, url: "" };
  } else {
    if (!params.api) throw new Error("Live screenshot capture requires a device service.");
    try {
      capture = await params.captureScreenshot(params.api, params.rotation, params.signal, 1.0);
    } catch {
      capture = await params.captureScreenshot(params.api, params.rotation, params.signal);
    }
  }
  const suffix = crypto.randomBytes(4).toString("hex");
  const destination = path.join(params.outputDir, `${params.name}-${suffix}.live.png`);
  await fs.mkdir(params.outputDir, { recursive: true });
  await fs.copyFile(capture.path, destination);
  return destination;
}
