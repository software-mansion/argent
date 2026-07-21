import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  settleTree,
  invokeOnDevice,
  DEFAULT_ACTION_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  type ActionEnv,
} from "./flow-actions";
import { FlowTreeSourceUnavailableError } from "./flow-errors";
import { settlePixels, type PixelSettleOutcome } from "./flow-pixels";
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
 * only) — a clean pass carries none, so renderers
 * never fetch full-res PNGs just to print paths nobody needs.
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

type SnapshotSettleOutcome = Exclude<PixelSettleOutcome, "aborted"> | "aborted";

/** A snapshot's settle verdict: the visual outcome plus tree freshness. */
interface SnapshotSettle {
  outcome: SnapshotSettleOutcome;
  /**
   * Whether the settle ended on a current tree. Nothing reads this yet — the
   * planned `cropOn` snapshot option will resolve its crop frame from the
   * settled tree and must demand freshness (which the pixels-only outage
   * fallback, reading no tree, can never provide).
   */
  treeFresh: boolean;
}

/**
 * Prefer a fully converged tree + pixel settle: a visually-settled but
 * stale result (the post-pixel revalidation read ran long) is re-settled for
 * freshness on the shared action deadline and accepted only at exhaustion —
 * safe while the comparison consumes pixels only, since `settled` always
 * describes the captured screen (see {@link SnapshotSettle.treeFresh}).
 * Outcomes short of `settled` map directly with no retry, and a sustained
 * tree-source outage degrades to a bounded pixel-only settle.
 */
async function settleSnapshot(env: ActionEnv): Promise<SnapshotSettle> {
  const deadline = Date.now() + DEFAULT_ACTION_TIMEOUT_MS;
  // Set once a settle proves the pixels stopped without the confirming tree
  // read; later retries only chase freshness, and no worse reading may take
  // back that established stability.
  let staleSettled = false;
  try {
    for (;;) {
      const settled = await settleTree(env, { absoluteDeadline: deadline });
      if (!settled) return { outcome: "aborted", treeFresh: false };
      if (settled.visual === "settled" && settled.treeFresh) {
        return { outcome: "settled", treeFresh: true };
      }
      if (settled.visual === "settled") {
        staleSettled = true;
      } else if (!staleSettled) {
        // Never visually settled: map the outcome directly, with no retry —
        // the settle already spent its bounded budget failing to converge. A
        // non-converged `unavailable` hides an earlier pixel timeout, so only
        // the converged form stays distinct from `timed-out`.
        if (settled.visual === "unavailable" && settled.converged) {
          return { outcome: "unavailable", treeFresh: settled.treeFresh };
        }
        return { outcome: "timed-out", treeFresh: settled.treeFresh };
      }
      if (Date.now() >= deadline) return { outcome: "settled", treeFresh: false };
      const sleepMs = Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()));
      if (!(await sleepOrAbort(sleepMs, env.signal))) {
        return { outcome: "aborted", treeFresh: false };
      }
      // The sleep can land exactly on the deadline, and a zero-budget settle
      // would misreport a healthy tree source as an outage.
      if (Date.now() >= deadline) return { outcome: "settled", treeFresh: false };
    }
  } catch (err) {
    if (err instanceof FlowTreeSourceUnavailableError) {
      // A dark retry cannot un-prove the stillness an earlier settle
      // established — accept it rather than re-derive it from extra captures.
      if (staleSettled) return { outcome: "settled", treeFresh: false };
      return { outcome: await settlePixels(env), treeFresh: false };
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
 * Capture the current screen and compare it to a stored baseline keyed by
 * platform + resolution. A missing baseline FAILS the step — adopting one is
 * always an explicit `updateBaselines` gesture. The key is derived from the
 * capture, so any device-class drift (another simulator model, a rotation, an
 * auto-detected device) lands here too; passing instead would let a CI run go
 * green having compared nothing.
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
  const settle = await settleSnapshot(env);
  if (settle.outcome === "aborted" || env.signal?.aborted) {
    return { status: "skip", reason: "run aborted during snapshot settle" };
  }
  const degradation = degradedReason(settle.outcome);

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
  const snapshotKey = `${opts.name}__${env.device.platform}-${w}x${h}`;
  const key = `${snapshotKey}.png`;
  const dir = baselineDir(opts.flowsDir, opts.flowName);
  const baselinePath = path.join(dir, key);

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
      artifacts: { current: shot.image },
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
    const result = await diffPngFiles({ baselinePath, currentPath, outputDir });

    // The differ reports an aspect-ratio bail as mismatchPercentage 0, which the
    // threshold below would read as a clean pass — but nothing was compared.
    // Unreachable while the key embeds the capture's dimensions; load-bearing
    // the moment a baseline file is renamed or the key scheme changes.
    if (result.dimensionMismatch) {
      const { expected, actual } = result.dimensionMismatch;
      return {
        status: "fail",
        reason: withDegradation(
          `baseline is ${expected.width}x${expected.height} but the capture is ` +
            `${actual.width}x${actual.height} (${key}) — nothing was compared`,
          degradation
        ),
        snapshotKey,
        artifacts: {
          baseline: await store.register(baselinePath, { mimeType: "image/png" }),
          current: shot.image,
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
      current: shot.image,
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
}
