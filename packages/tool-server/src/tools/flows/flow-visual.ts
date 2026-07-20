import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import type { DescribeFrame } from "../describe/contract";
import {
  settleTree,
  invokeOnDevice,
  waitForFrame,
  offscreenHint,
  type ActionEnv,
} from "./flow-actions";
import { describeSelector, type FlowSelector } from "./flow-utils";
import { diffPngFiles } from "../screenshot-diff/screenshot-diff";
import { requireArtifacts, type ArtifactHandle } from "../../artifacts";

/** Default visual tolerance (percent of pixels) when a flow/step sets none. */
export const DEFAULT_MAX_MISMATCH = 0.5;

/**
 * Files a snapshot step produced, keyed by role so a renderer can pick what to
 * surface (e.g. inline only `diff` on failure). Artifact handles — not host
 * paths — so a client on another machine can materialize them. Present only
 * when there is something to look at: a failed comparison (all roles), a
 * missing-baseline failure (`current` only), or a baseline write (`baseline`
 * only) — a clean pass carries none, so renderers never fetch full-res PNGs
 * just to print paths nobody needs.
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
  /**
   * Baseline key stem (`<name>__<platform>-WxH`) — present whenever
   * `artifacts` is, so a consumer exporting the files to a durable location
   * (the CLI's `--output`) can name them by the same collision-free key the
   * baseline store uses.
   */
  snapshotKey?: string;
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
 * Remove the differ's scratch directory, sparing only `keep` — the file
 * registered as an artifact, whose host path must stay readable for a client
 * to materialize it later. Best-effort: a failed cleanup never fails the
 * snapshot itself.
 */
async function cleanupDiffDir(dir: string, keep?: string): Promise<void> {
  try {
    if (!keep) {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    }
    for (const entry of await fs.readdir(dir)) {
      const entryPath = path.join(dir, entry);
      if (entryPath !== keep) await fs.rm(entryPath, { recursive: true, force: true });
    }
  } catch {
    // best-effort cleanup
  }
}

/**
 * Crop `src` to the pixel rect of a normalized frame and write it to `dest`.
 * Frames are fractions of the capture, so the rect is just frame × capture
 * dimensions — DPR never enters. Edges are rounded independently (not
 * left + rounded width) so the rect tracks the element as closely as sub-pixel
 * frames allow, then clamped to the capture — Android trees can report frames
 * that overhang the screen. Returns null for a degenerate (sub-pixel) region
 * instead of writing an invalid zero-extent PNG.
 */
async function cropPngFile(
  src: string,
  dest: string,
  frame: DescribeFrame
): Promise<{ w: number; h: number } | null> {
  const png = PNG.sync.read(await fs.readFile(src));
  const left = Math.max(0, Math.round(frame.x * png.width));
  const top = Math.max(0, Math.round(frame.y * png.height));
  const right = Math.min(png.width, Math.round((frame.x + frame.width) * png.width));
  const bottom = Math.min(png.height, Math.round((frame.y + frame.height) * png.height));
  const w = right - left;
  const h = bottom - top;
  if (w < 1 || h < 1) return null;
  const out = new PNG({ width: w, height: h });
  PNG.bitblt(png, out, left, top, w, h, 0, 0);
  await fs.writeFile(dest, PNG.sync.write(out));
  return { w, h };
}

/**
 * Capture the current screen and compare it to a stored baseline keyed by
 * platform + resolution. A missing baseline FAILS the step — adopting one is
 * always an explicit `updateBaselines` gesture. The key is derived from the
 * capture, so any device-class drift (another simulator model, a rotation, an
 * auto-detected device) lands here too; passing instead would let a CI run go
 * green having compared nothing.
 *
 * `cropOn` narrows the comparison to one element's region: the selector
 * resolves to a frame before the capture (settle + auto-wait, like the
 * directives), and the CROPPED image is what gets compared, stored as the
 * baseline, and registered as the `current` artifact — the artifact must be
 * what was actually compared.
 */
export async function runSnapshot(
  env: ActionEnv,
  opts: {
    flowsDir: string;
    flowName: string;
    name: string;
    maxMismatch: number;
    updateBaselines: boolean;
    cropOn?: FlowSelector;
  }
): Promise<VisualOutcome> {
  // Wait for the UI to settle (a transition/reflow finished) so the capture is
  // stable run-to-run, rather than guessing a fixed delay. `settleTree` returns
  // undefined only on abort and throws only on a sustained tree-source outage
  // (e.g. native devtools disconnected). The capture reads pixels, not the
  // describe tree — so short of an explicit abort, proceed best-effort; a
  // genuinely dead device still surfaces via the screenshot invoke below.
  if (opts.cropOn === undefined) {
    try {
      await settleTree(env);
    } catch {
      // tree-source outage — capture anyway, see above
    }
  }
  if (env.signal?.aborted) {
    return { status: "skip", reason: "run aborted during snapshot settle" };
  }

  // `cropOn`: resolve the crop element's frame BEFORE capturing, so the pixels
  // captured are the state the frame was resolved from. `waitForFrame` settles
  // internally (the plain settle above is skipped) and auto-waits like the
  // directives, with their standard not-found reason. Unlike the best-effort
  // settle, a tree-source outage propagates as a step error here: without a
  // tree there is no frame, and degrading to a full-screen capture would
  // "compare" the whole screen against a cropped baseline.
  let cropFrame: DescribeFrame | undefined;
  if (opts.cropOn !== undefined) {
    const frame = await waitForFrame(env, opts.cropOn);
    if (frame === "aborted") {
      return { status: "skip", reason: "run aborted while resolving cropOn" };
    }
    if (frame === undefined) {
      return { status: "fail", reason: offscreenHint(opts.cropOn) };
    }
    cropFrame = frame;
  }

  const store = requireArtifacts(env.ctx);

  // Full-resolution capture, not attached to any agent context — a baseline.
  // The screenshot tool already registers the capture, so `shot.image` is a
  // ready-made handle for the `current` artifact.
  const shot = (await invokeOnDevice(env, "screenshot", {
    scale: 1.0,
    includeImageInContext: false,
  })) as { image: ArtifactHandle };

  // The key stays on the FULL capture's dimensions even under cropOn: its job
  // is device-class identity (wrong-simulator/rotation detection), which
  // cropped dimensions — a function of layout — would destroy.
  const { w, h } = await pngDimensions(shot.image.hostPath);
  const snapshotKey = `${opts.name}__${env.device.platform}-${w}x${h}`;
  const key = `${snapshotKey}.png`;
  const dir = baselineDir(opts.flowsDir, opts.flowName);
  const baselinePath = path.join(dir, key);

  // Under cropOn everything downstream (compare, baseline write, `current`
  // artifact) operates on the cropped image, written to its own scratch dir.
  // It is registered lazily, only in branches that return it — the finally
  // sweeps whatever was not registered, and a registered file's host path must
  // outlive this call (same contract as the context diff below).
  let currentPath = shot.image.hostPath;
  let cropDir: string | undefined;
  let keepCropped = false;
  const currentArtifact = async (): Promise<ArtifactHandle> => {
    if (cropDir === undefined) return shot.image;
    keepCropped = true;
    return store.register(currentPath, { mimeType: "image/png" });
  };

  try {
    if (cropFrame !== undefined) {
      cropDir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-flow-crop-"));
      const croppedPath = path.join(cropDir, key);
      const cropped = await cropPngFile(shot.image.hostPath, croppedPath, cropFrame);
      if (cropped === null) {
        return {
          status: "fail",
          reason:
            `cropOn matched ${describeSelector(opts.cropOn!)} but its on-screen region is ` +
            `empty at this resolution — nothing was compared`,
        };
      }
      currentPath = croppedPath;
    }

    const exists = await fs
      .access(baselinePath)
      .then(() => true)
      .catch(() => false);

    if (opts.updateBaselines) {
      await fs.mkdir(dir, { recursive: true });
      await fs.copyFile(currentPath, baselinePath);
      const baseline = await store.register(baselinePath, { mimeType: "image/png" });
      return {
        status: "pass",
        reason: exists ? `baseline updated (${key})` : `baseline written (${key})`,
        snapshotKey,
        artifacts: { baseline },
      };
    }

    if (!exists) {
      // Fail WITHOUT seeding: writing here would make this unreviewed capture
      // the truth a re-run silently passes against, and a workspace that never
      // persists baselines (ephemeral CI) would gate nothing forever.
      return {
        status: "fail",
        reason:
          `no baseline for "${opts.name}" on this device class — expected ${baselinePath}, ` +
          `nothing was compared. Run with updateBaselines (--update-baselines) to adopt the ` +
          `current screen, then review and commit it`,
        snapshotKey,
        artifacts: { current: await currentArtifact() },
      };
    }

    // Scratch directory for the differ's full-res diff and downscaled context
    // diff. Nothing in it may outlive this call except a file registered as an
    // artifact below (its host path is materialized later) — the finally sweeps
    // the rest, or a long-lived tool-server running snapshot flows would accrete
    // argent-flow-diff-* directories forever.
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-flow-diff-"));
    let keepInOutputDir: string | undefined;
    try {
      const result = await diffPngFiles({
        baselinePath,
        currentPath,
        outputDir,
        topMask: cropFrame === undefined ? "status-bar" : "none",
      });

      // The differ reports an aspect-ratio bail as mismatchPercentage 0, which
      // the threshold below would read as a clean pass — but nothing was
      // compared. Unreachable for a full-screen snapshot while the key embeds
      // the capture's dimensions; load-bearing under cropOn, where the crop's
      // dimensions track the element, not the device class — an element that
      // moved or resized lands here instead of producing a bogus pixel diff.
      if (result.dimensionMismatch) {
        const { expected, actual } = result.dimensionMismatch;
        return {
          status: "fail",
          reason:
            `baseline is ${expected.width}x${expected.height} but the ` +
            `${opts.cropOn ? "cropOn region" : "capture"} is ` +
            `${actual.width}x${actual.height} (${key}) — nothing was compared` +
            (opts.cropOn
              ? `. The element's size drifted — crop a fixed-size container, or re-adopt ` +
                `with updateBaselines`
              : ""),
          snapshotKey,
          artifacts: {
            baseline: await store.register(baselinePath, { mimeType: "image/png" }),
            current: await currentArtifact(),
          },
        };
      }

      const within = result.mismatchPercentage <= opts.maxMismatch;
      const reason = `diff ${result.mismatchPercentage.toFixed(2)}% ${within ? "≤" : ">"} ${opts.maxMismatch}% (${key})`;
      if (within) {
        return { status: "pass", reason };
      }

      const artifacts: SnapshotArtifacts = {
        baseline: await store.register(baselinePath, { mimeType: "image/png" }),
        current: await currentArtifact(),
      };
      // Also expose the annotated context diff — the image a client renders inline
      // so the agent can see WHAT differed. (Absent when the diff bailed early,
      // e.g. on a dimension mismatch.)
      if (result.contextDiffPath) {
        artifacts.diff = await store.register(result.contextDiffPath, {
          mimeType: "image/png",
          filename: `${snapshotKey}-diff.png`,
        });
        keepInOutputDir = result.contextDiffPath;
      }
      return { status: "fail", reason, snapshotKey, artifacts };
    } finally {
      await cleanupDiffDir(outputDir, keepInOutputDir);
    }
  } finally {
    if (cropDir !== undefined) {
      await cleanupDiffDir(cropDir, keepCropped ? currentPath : undefined);
    }
  }
}
