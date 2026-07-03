import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { settleTree, invokeOnDevice, type ActionEnv } from "./flow-actions";
import { diffPngFiles } from "../screenshot-diff/screenshot-diff";
import { requireArtifacts, type ArtifactHandle } from "../../artifacts";

/** Default visual tolerance (percent of pixels) when a flow/step sets none. */
export const DEFAULT_MAX_MISMATCH = 0.5;

/**
 * Files a snapshot step produced, keyed by role so a renderer can pick what to
 * surface (e.g. inline only `diff` on failure). Artifact handles — not host
 * paths — so a client on another machine can materialize them.
 */
export interface SnapshotArtifacts {
  baseline?: ArtifactHandle;
  current?: ArtifactHandle;
  /** Annotated context diff (changed pixels highlighted), downscaled for inline rendering. */
  diff?: ArtifactHandle;
}

export interface VisualOutcome {
  status: "pass" | "fail" | "skip";
  reason?: string;
  /** Non-fatal caveat on a passed step. */
  warning?: string;
  artifacts?: SnapshotArtifacts;
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
 * platform + resolution. A missing baseline is written and the step passes:
 * silently under `updateBaselines`, with a `warning` otherwise (nothing was
 * compared).
 */
export async function runSnapshot(
  env: ActionEnv,
  opts: {
    flowsDir: string;
    flowName: string;
    name: string;
    maxMismatch: number;
    updateBaselines: boolean;
  }
): Promise<VisualOutcome> {
  // Wait for the UI to settle (a transition/reflow finished) so the capture is
  // stable run-to-run, rather than guessing a fixed delay. `settleTree` returns
  // undefined only on abort; a best-effort timeout still proceeds to capture.
  await settleTree(env);
  if (env.signal?.aborted) {
    return { status: "skip", reason: "run aborted during snapshot settle" };
  }

  const store = requireArtifacts(env.ctx);

  // Full-resolution capture, not attached to any agent context — a baseline.
  // The screenshot tool already registers the capture, so `shot.image` is a
  // ready-made handle for the `current` artifact.
  const shot = (await invokeOnDevice(env, "screenshot", {
    scale: 1.0,
    includeImageInContext: false,
  })) as { image: ArtifactHandle };
  const currentPath = shot.image.hostPath;

  const { w, h } = await pngDimensions(currentPath);
  const key = `${opts.name}__${env.device.platform}-${w}x${h}.png`;
  const dir = baselineDir(opts.flowsDir, opts.flowName);
  const baselinePath = path.join(dir, key);

  const exists = await fs
    .access(baselinePath)
    .then(() => true)
    .catch(() => false);

  if (!exists || opts.updateBaselines) {
    await fs.mkdir(dir, { recursive: true });
    await fs.copyFile(currentPath, baselinePath);
    const baseline = await store.register(baselinePath, { mimeType: "image/png" });
    if (opts.updateBaselines) {
      return {
        status: "pass",
        reason: exists ? `baseline updated (${key})` : `baseline written (${key})`,
        artifacts: { baseline },
      };
    }
    return {
      status: "pass",
      reason: `baseline created (${key})`,
      warning:
        `no baseline existed for "${opts.name}" on this device class — the current screen was ` +
        `saved as the new baseline and nothing was compared; review ${baselinePath} before ` +
        `trusting future runs`,
      artifacts: { baseline },
    };
  }

  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-flow-diff-"));
  const result = await diffPngFiles({ baselinePath, currentPath, outputDir });
  const within = result.mismatchPercentage <= opts.maxMismatch;
  const artifacts: SnapshotArtifacts = {
    baseline: await store.register(baselinePath, { mimeType: "image/png" }),
    current: shot.image,
  };
  // On failure, also expose the annotated context diff — the image a client
  // renders inline so the agent can see WHAT differed. (Absent when the diff
  // bailed early, e.g. on a dimension mismatch.)
  if (!within && result.contextDiffPath) {
    artifacts.diff = await store.register(result.contextDiffPath, {
      mimeType: "image/png",
      filename: `${key.replace(/\.png$/, "")}-diff.png`,
    });
  }
  return {
    status: within ? "pass" : "fail",
    reason: `diff ${result.mismatchPercentage.toFixed(2)}% ${within ? "≤" : ">"} ${opts.maxMismatch}% (${key})`,
    artifacts,
  };
}
