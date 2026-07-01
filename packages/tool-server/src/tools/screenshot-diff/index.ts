import crypto from "node:crypto";
import fs from "fs/promises";
import os from "node:os";
import path from "path";
import { z } from "zod";
import type {
  FileInputSpec,
  ServiceRef,
  ToolContext,
  ToolCapability,
  ToolDefinition,
} from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { resolveDevice } from "../../utils/device-info";
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
      return { simulatorServer: simulatorServerRef(resolveDevice(params.udid)) };
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
        api: services.simulatorServer as SimulatorServerApi,
        outputDir,
        name: "baseline",
        rotation: params.rotation,
        signal: options?.signal,
        captureScreenshot,
      })
    : params.baselinePath!;

  const currentPath = params.captureCurrent
    ? await captureLiveInput({
        api: services.simulatorServer as SimulatorServerApi,
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
  if (params.captureBaseline && params.captureCurrent) {
    throw new Error(
      "captureBaseline and captureCurrent cannot both be true; provide one saved image path and capture the other side live."
    );
  }
  if (params.captureBaseline && params.baselinePath) {
    throw new Error("Provide either baselinePath or captureBaseline, not both.");
  }
  if (params.captureCurrent && params.currentPath) {
    throw new Error("Provide either currentPath or captureCurrent, not both.");
  }
  if (!params.captureBaseline && !params.baselinePath) {
    throw new Error("baselinePath is required unless captureBaseline is true.");
  }
  if (!params.captureCurrent && !params.currentPath) {
    throw new Error("currentPath is required unless captureCurrent is true.");
  }
}

async function captureLiveInput(params: {
  api: SimulatorServerApi | undefined;
  outputDir: string;
  name: "baseline" | "current";
  rotation?: Params["rotation"];
  signal?: AbortSignal;
  captureScreenshot: CaptureScreenshot;
}): Promise<string> {
  if (!params.api) {
    throw new Error("Live screenshot capture requires a simulatorServer service.");
  }

  // Prefer a full-resolution capture for maximum diff fidelity. Some Android
  // emulator configurations cannot stream a full-res frame — the simulator-server
  // rejects it with a "wrong data size" framebuffer mismatch — which previously
  // made the entire baselinePath + captureCurrent flow unusable on Android. Fall
  // back to the server's default scale, which captures reliably; same-aspect
  // normalization in diffPngFiles keeps a scaled capture diff-compatible with a
  // baseline saved at any scale. Full-res is preserved wherever it works (iOS).
  let capture: Awaited<ReturnType<CaptureScreenshot>>;
  try {
    capture = await params.captureScreenshot(params.api, params.rotation, params.signal, 1.0);
  } catch {
    capture = await params.captureScreenshot(params.api, params.rotation, params.signal);
  }
  const suffix = crypto.randomBytes(4).toString("hex");
  const destination = path.join(params.outputDir, `${params.name}-${suffix}.live.png`);
  await fs.mkdir(params.outputDir, { recursive: true });
  await fs.copyFile(capture.path, destination);
  return destination;
}
