import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { DeviceInfo, Registry, ToolContext } from "@argent/registry";
import { invokeSubTool } from "../../utils/sub-invoke";
import { settleTree } from "./flow-actions";
import { bindDeviceArgs } from "./flow-device";
import { diffPngFiles } from "../screenshot-diff/screenshot-diff";

/** Default visual tolerance (percent of pixels) when a flow/step sets none. */
export const DEFAULT_MAX_MISMATCH = 0.5;

export interface VisualOutcome {
  status: "pass" | "fail" | "skip";
  reason?: string;
  artifacts?: string[];
}

/** Read width/height from a PNG IHDR (bytes 16–23, big-endian). */
async function pngDimensions(file: string): Promise<{ w: number; h: number }> {
  const fh = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(24);
    await fh.read(buf, 0, 24, 0);
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  } finally {
    await fh.close();
  }
}

function baselineDir(flowsDir: string, flowName: string): string {
  return path.join(flowsDir, "__baselines__", flowName);
}

/**
 * Capture the current screen and compare it to a stored baseline keyed by
 * platform + resolution. Writes (and passes) when the baseline is missing under
 * `updateBaselines`; otherwise a missing baseline is a `skip` with a warning so
 * a portable flow doesn't hard-fail on an un-baselined device class.
 */
export async function runSnapshot(
  registry: Registry,
  ctx: ToolContext | undefined,
  device: DeviceInfo,
  opts: {
    flowsDir: string;
    flowName: string;
    name: string;
    maxMismatch: number;
    updateBaselines: boolean;
  },
  signal?: AbortSignal
): Promise<VisualOutcome> {
  // Wait for the UI to settle (a transition/reflow finished) so the capture is
  // stable run-to-run, rather than guessing a fixed delay. `settleTree` returns
  // undefined only on abort; a best-effort timeout still proceeds to capture.
  await settleTree(registry, device, signal);
  if (signal?.aborted) {
    return { status: "skip", reason: "run aborted during snapshot settle" };
  }

  // Full-resolution capture, not attached to any agent context — a baseline.
  const shot = (await invokeSubTool(
    registry,
    ctx,
    "screenshot",
    bindDeviceArgs(registry, "screenshot", device.id, {
      scale: 1.0,
      includeImageInContext: false,
    })
  )) as { image: { hostPath: string } };
  const currentPath = shot.image.hostPath;

  const { w, h } = await pngDimensions(currentPath);
  const key = `${opts.name}__${device.platform}-${w}x${h}.png`;
  const dir = baselineDir(opts.flowsDir, opts.flowName);
  const baselinePath = path.join(dir, key);

  const exists = await fs
    .access(baselinePath)
    .then(() => true)
    .catch(() => false);

  if (!exists || opts.updateBaselines) {
    await fs.mkdir(dir, { recursive: true });
    await fs.copyFile(currentPath, baselinePath);
    return {
      status: "pass",
      reason: exists ? `baseline updated (${key})` : `baseline written (${key})`,
      artifacts: [baselinePath],
    };
  }

  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-flow-diff-"));
  const result = await diffPngFiles({ baselinePath, currentPath, outputDir });
  const within = result.mismatchPercentage <= opts.maxMismatch;
  return {
    status: within ? "pass" : "fail",
    reason: `diff ${result.mismatchPercentage.toFixed(2)}% ${within ? "≤" : ">"} ${opts.maxMismatch}% (${key})`,
    artifacts: [baselinePath, currentPath],
  };
}
