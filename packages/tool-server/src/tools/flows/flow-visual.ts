import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import type { DescribeFrame } from "../describe/contract";
import {
  settleTree,
  invokeOnDevice,
  waitForFrameResult,
  offscreenHint,
  DEFAULT_ACTION_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  type ActionEnv,
  type SettleResult,
} from "./flow-actions";
import { FlowTreeSettleTimeoutError, FlowTreeSourceUnavailableError } from "./flow-errors";
import { settlePixels, type PixelSettleOutcome } from "./flow-pixels";
import { describeSelector, type FlowSelector } from "./flow-utils";
import { sleepOrAbort } from "../../utils/timing";
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
   * Baseline key stem (`<name>__<platform>-WxH`, plus `-crop-<hash>` for
   * cropOn snapshots) — present whenever `artifacts` is, so a consumer
   * exporting the files to a durable location (the CLI's `--output`) can name
   * them by the same collision-free key the baseline store uses.
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

/**
 * Canonical crop identity for a selector: fixed field order, so the key is
 * immune to YAML key order and to describeSelector's human-readable format
 * (owned by failure prose). `loose` is included because it changes resolution
 * (identifier-first fallback).
 */
function cropIdentity(s: FlowSelector): string {
  return JSON.stringify([
    s.text ?? null,
    s.textMatches ?? null,
    s.identifier ?? null,
    s.role ?? null,
    s.loose ?? false,
  ]);
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
 * The pixel-settle outcomes plus `skipped`: a combined settle converged with
 * no pixel phase to run (no capture backend on the platform) — complete, not
 * degraded, so {@link degradedReason} maps it to nothing.
 */
type SnapshotSettleOutcome = Exclude<PixelSettleOutcome, "aborted"> | "aborted" | "skipped";

/** Map one combined settle into the degradation vocabulary snapshots expose. */
function snapshotSettleFromResult(settled: SettleResult): SnapshotSettleOutcome {
  if (settled.visual === "settled") {
    return "settled";
  }
  if (settled.visual === "skipped" && settled.converged) {
    return "skipped";
  }
  if (settled.visual === "unavailable" && settled.converged) {
    return "unavailable";
  }
  return "timed-out";
}

/**
 * Prefer a fully converged tree + pixel settle: a visually-settled but
 * stale result (the post-pixel revalidation read ran long) is re-settled for
 * freshness on the shared action deadline and accepted only at exhaustion —
 * but only while nothing contradicts it. A freshness retry is a full settle:
 * when its pixel phase launches captures without ever producing a matching
 * pair (`timed-out`), the earlier stale claim no longer describes the screen
 * the upcoming capture will see, so the retry's degradation wins; only
 * pixel-dark retries (outages, hard tree timeouts) cannot un-prove the
 * established stillness. Outcomes short of `settled` map directly with no
 * retry, and a sustained tree-source outage degrades to a bounded pixel-only
 * settle.
 */
async function settleSnapshot(env: ActionEnv): Promise<SnapshotSettleOutcome> {
  const deadline = Date.now() + DEFAULT_ACTION_TIMEOUT_MS;
  // Set once a settle proves the pixels stopped without the confirming tree
  // read; later retries only chase freshness, and no pixel-DARK reading (an
  // outage, a hard tree timeout) may take back that established stability. A
  // retry whose pixel phase runs without re-proving stillness does — see the
  // `timed-out` arm below.
  let staleSettled = false;
  try {
    for (;;) {
      const settled = await settleTree(env, { absoluteDeadline: deadline });
      if (!settled) return "aborted";
      if (settled.visual === "settled" && settled.treeFresh) {
        return "settled";
      }
      // Combined mode converges with `skipped` only when the platform has no
      // capture backend (see SettleResult.visual): tree stability is the whole
      // settle there, and no retry could produce anything more.
      if (settled.visual === "skipped" && settled.converged) {
        return "skipped";
      }
      if (settled.visual === "settled") {
        staleSettled = true;
      } else if (settled.visual === "timed-out") {
        // A completed settle whose pixel phase ran and could not produce a
        // matching pair: stillness could not be re-proven strictly AFTER any
        // stale-settled pair matched, and the capture happens after this
        // returns — honest degradation overrides the earlier stale claim,
        // the same way settleTree discards a pre-restart `settled` pair.
        return "timed-out";
      } else if (!staleSettled) {
        // Pixel-dark shortfalls (`skipped` without convergence, `unavailable`)
        // map directly, with no retry — the settle already spent its bounded
        // budget failing to converge. A non-converged `unavailable` hides an
        // earlier pixel timeout, so only the converged form stays distinct
        // from `timed-out`.
        if (settled.visual === "unavailable" && settled.converged) {
          return "unavailable";
        }
        return "timed-out";
      }
      if (Date.now() >= deadline) return "settled";
      const sleepMs = Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()));
      if (!(await sleepOrAbort(sleepMs, env.signal))) {
        return "aborted";
      }
      // The sleep can land exactly on the deadline. A zero-budget settle is a
      // doomed round — no read can start, so it can only throw
      // FlowTreeSettleTimeoutError — and this tail is reached only
      // stale-settled, where the catch below answers "settled" anyway; return
      // that directly instead of paying for the wasted call.
      if (Date.now() >= deadline) return "settled";
    }
  } catch (err) {
    if (err instanceof FlowTreeSettleTimeoutError) {
      // A hard timeout does not prove the hierarchy source is down. Preserve
      // any pixel stillness an earlier retry established; otherwise surface
      // honest degradation instead of switching to the outage-only pixels
      // fallback and potentially writing an apparently settled baseline.
      return staleSettled ? "settled" : "timed-out";
    }
    if (err instanceof FlowTreeSourceUnavailableError) {
      // A dark retry cannot un-prove the stillness an earlier settle
      // established — accept it rather than re-derive it from extra captures.
      if (staleSettled) return "settled";
      return settlePixels(env, { absoluteDeadline: deadline });
    }
    throw err;
  }
}

function degradedReason(outcome: SnapshotSettleOutcome): string | undefined {
  if (outcome === "timed-out") {
    return "capture is best-effort/degraded because visual settling timed out";
  }
  if (outcome === "unavailable") {
    return "capture is best-effort/degraded because visual settling was unavailable";
  }
  return undefined;
}

function withDegradation(reason: string, degradation?: string): string {
  return degradation ? `${reason}; ${degradation}` : reason;
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
  let settle: SnapshotSettleOutcome;
  let cropFrame: DescribeFrame | undefined;

  if (opts.cropOn === undefined) {
    // Full-screen snapshots settle directly because they consume no selector
    // coordinates and can fall back to pixels alone on a proven tree outage.
    settle = await settleSnapshot(env);
    if (settle === "aborted" || env.signal?.aborted) {
      return { status: "skip", reason: "run aborted during snapshot settle" };
    }
  } else {
    // Resolve the crop frame BEFORE capturing, and retain the visual verdict
    // from that exact settle. A second settle could observe another screen;
    // discarding this verdict would make timed-out/unavailable crop captures
    // look undegraded. Tree-source outages still propagate: without a tree
    // there is no frame, and a full-screen fallback would compare the wrong
    // pixels against the cropped baseline.
    const resolved = await waitForFrameResult(env, opts.cropOn);
    if (resolved.frame === "aborted") {
      return { status: "skip", reason: "run aborted while resolving cropOn" };
    }
    if (resolved.frame === undefined) {
      return { status: "fail", reason: offscreenHint(opts.cropOn) };
    }
    cropFrame = resolved.frame;
    settle = snapshotSettleFromResult(resolved.settle);
  }
  const degradation = degradedReason(settle);

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
  // cropped dimensions — a function of layout — would destroy. A cropOn key
  // additionally hashes the selector, so same-name snapshots cropping
  // different elements never share a baseline file.
  const { w, h } = await pngDimensions(shot.image.hostPath);
  const cropSuffix =
    opts.cropOn === undefined
      ? ""
      : `-crop-${createHash("sha256").update(cropIdentity(opts.cropOn)).digest("hex").slice(0, 8)}`;
  const snapshotKey = `${opts.name}__${env.device.platform}-${w}x${h}${cropSuffix}`;
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
    // Explicit filename: the crop file's basename IS the baseline's `key`, and
    // a remote client materializes downloads by filename — defaulting to the
    // basename would land `current` on the same cache path as `baseline` and
    // clobber it (the diff artifact below disambiguates the same way).
    return store.register(currentPath, {
      mimeType: "image/png",
      filename: `${snapshotKey}-current.png`,
    });
  };

  try {
    if (cropFrame !== undefined) {
      cropDir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-flow-crop-"));
      const croppedPath = path.join(cropDir, key);
      const cropped = await cropPngFile(shot.image.hostPath, croppedPath, cropFrame);
      if (cropped === null) {
        return {
          status: "fail",
          reason: withDegradation(
            `cropOn matched ${describeSelector(opts.cropOn!)} but its on-screen region is ` +
              `empty at this resolution — nothing was compared`,
            degradation
          ),
          snapshotKey,
          // No crop exists to show, so attach the full capture (already registered).
          artifacts: { current: shot.image },
        };
      }
      currentPath = croppedPath;
    }

    const exists = await fs
      .access(baselinePath)
      .then(() => true)
      .catch(() => false);

    if (opts.updateBaselines) {
      // Best-effort even after a degraded settle: the write proceeds, with the
      // degradation noted so a reviewer knows the adopted baseline may show
      // mid-animation pixels.
      await fs.mkdir(dir, { recursive: true });
      await fs.copyFile(currentPath, baselinePath);
      const baseline = await store.register(baselinePath, { mimeType: "image/png" });
      return {
        status: "pass",
        reason: withDegradation(
          exists ? `baseline updated (${key})` : `baseline written (${key})`,
          degradation
        ),
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
        reason: withDegradation(
          `no baseline for "${opts.name}" on this device class — expected ${baselinePath}, ` +
            `nothing was compared. Run with updateBaselines (--update-baselines) to adopt the ` +
            `current screen, then review and commit it`,
          degradation
        ),
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
        // A crop compares EVERY pixel of the element's region — no masking,
        // wherever the crop sits. Masking a crop's overlap with the screen's
        // top status-bar band would degenerate into comparing nothing for an
        // element inside the band (a vacuous pass); a crop overlapping the
        // band leans on best-effort pinStatusBar until frame resolution
        // asserts the element clears it.
        topMask: cropFrame === undefined ? "status-bar" : "none",
        // Crop dimensions track the element — size drift must hard-fail below
        // instead of being resampled away like a full-screen scale difference.
        ...(cropFrame !== undefined && { normalizeSizes: false }),
      });

      // The differ reports a dimension bail as mismatchPercentage 0, which the
      // threshold below would read as a clean pass — but nothing was compared.
      // Under cropOn the differ hard-fails ANY size difference (normalizeSizes:
      // false), so proportional element drift lands here too; full-screen
      // snapshots keep normalization, and this branch stays unreachable for
      // them since the key embeds the capture's dimensions.
      if (result.dimensionMismatch) {
        const { expected, actual } = result.dimensionMismatch;
        return {
          status: "fail",
          reason: withDegradation(
            `baseline is ${expected.width}x${expected.height} but the ` +
              `${opts.cropOn ? "cropOn region" : "capture"} is ` +
              `${actual.width}x${actual.height} (${key}) — nothing was compared` +
              (opts.cropOn
                ? `. The element's size drifted — crop a fixed-size container, or re-adopt ` +
                  `with updateBaselines`
                : ""),
            degradation
          ),
          snapshotKey,
          artifacts: {
            baseline: await store.register(baselinePath, { mimeType: "image/png" }),
            current: await currentArtifact(),
          },
        };
      }

      const within = result.mismatchPercentage <= opts.maxMismatch;
      const reason = withDegradation(
        `diff ${result.mismatchPercentage.toFixed(2)}% ${within ? "≤" : ">"} ${opts.maxMismatch}% (${key})`,
        degradation
      );
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
