import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import type {
  InvokeToolOptions,
  ServiceRef,
  ToolCapability,
  ToolDefinition,
} from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { resolveDevice } from "../../utils/device-info";
import { httpScreenshot } from "../../utils/simulator-client";
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
    outputDir: z.string().min(1).describe("Directory where diff artifacts should be written."),
  })
  .strict();

type Params = z.infer<typeof zodSchema>;

export interface ScreenshotDiffResult {
  summary: string;
  diffPath?: string;
  contextDiffPath?: string;
}

type CaptureScreenshot = typeof httpScreenshot;

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
};

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
  outputHint: "screenshot-diff",
  capability,
  services: (params): Record<string, ServiceRef> => ({
    simulatorServer: simulatorServerRef(resolveDevice(params.udid)),
  }),
  async execute(services, params, options) {
    return executeScreenshotDiffTool(services, params, options);
  },
};

export async function executeScreenshotDiffTool(
  services: Record<string, unknown>,
  params: Params,
  options?: InvokeToolOptions,
  captureScreenshot: CaptureScreenshot = httpScreenshot
): Promise<ScreenshotDiffResult> {
  const { baselinePath, currentPath } = await resolveInputPaths(
    services,
    params,
    options,
    captureScreenshot
  );

  const result = await diffPngFiles({
    baselinePath,
    currentPath,
    outputDir: params.outputDir,
  });

  return {
    summary: result.summary,
    ...(result.diffPath ? { diffPath: result.diffPath } : {}),
    ...(result.contextDiffPath ? { contextDiffPath: result.contextDiffPath } : {}),
  };
}

async function resolveInputPaths(
  services: Record<string, unknown>,
  params: Params,
  options: InvokeToolOptions | undefined,
  captureScreenshot: CaptureScreenshot
): Promise<{ baselinePath: string; currentPath: string }> {
  validateInputSources(params);

  const baselinePath = params.captureBaseline
    ? await captureLiveInput({
        api: services.simulatorServer as SimulatorServerApi,
        outputDir: params.outputDir,
        name: "baseline",
        rotation: params.rotation,
        signal: options?.signal,
        captureScreenshot,
      })
    : params.baselinePath!;

  const currentPath = params.captureCurrent
    ? await captureLiveInput({
        api: services.simulatorServer as SimulatorServerApi,
        outputDir: params.outputDir,
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

  const capture = await params.captureScreenshot(params.api, params.rotation, params.signal, 1.0);
  const destination = path.join(params.outputDir, `${params.name}.live.png`);
  await fs.mkdir(params.outputDir, { recursive: true });
  await fs.copyFile(capture.path, destination);
  return destination;
}
