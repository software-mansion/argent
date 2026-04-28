import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { SimulatorServerApi } from "../../../blueprints/simulator-server";
import { httpScreenshot } from "../../../utils/simulator-client";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";

const execFileAsync = promisify(execFile);

export interface ScreenshotParams {
  udid: string;
  rotation?: "Portrait" | "LandscapeLeft" | "LandscapeRight" | "PortraitUpsideDown";
  scale?: number;
}

export interface ScreenshotResult {
  url: string;
  path: string;
}

export interface ScreenshotServices {
  simulatorServer: SimulatorServerApi;
}

/**
 * Fallback that runs `xcrun simctl io <udid> screenshot <file>` and writes the
 * PNG to a stable temp path. Used when the simulator-server's `/api/screenshot`
 * is unavailable — e.g. radon's license-gated response
 * `{"error": "Screenshot is not available for your license plan"}`. The
 * resulting URL is `file://<path>`; consumers (MCP content adapter) read the
 * file directly when fetch can't resolve a `file://` URL.
 */
async function simctlScreenshot(
  udid: string,
  signal?: AbortSignal
): Promise<ScreenshotResult> {
  const dir = path.join(os.tmpdir(), "argent-screenshots");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${udid.slice(0, 8)}-${Date.now()}.png`);
  await execFileAsync("xcrun", ["simctl", "io", udid, "screenshot", file], {
    signal,
    timeout: 15_000,
  });
  return { url: `file://${file}`, path: file };
}

export const iosImpl: PlatformImpl<ScreenshotServices, ScreenshotParams, ScreenshotResult> = {
  handler: async (services, params, _device, options) => {
    const api = services.simulatorServer;
    const signal = options?.signal ?? AbortSignal.timeout(16_000);
    try {
      return await httpScreenshot(api, params.rotation, signal, params.scale);
    } catch (err) {
      // Any failure of the streaming-server screenshot path — license
      // restrictions, malformed response, missing endpoint — falls through to
      // simctl, which is always available. Rotation/scale aren't honored here
      // (simctl doesn't support them), but a working PNG beats a hard error.
      return simctlScreenshot(params.udid, signal);
    }
  },
};
