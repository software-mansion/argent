/**
 * Baselines captured by a `screenshot-diff` call that set `captureBaseline` and
 * gave no current side, held until a later call for the same device supplies the
 * current side.
 *
 * Process memory rather than disk, for two reasons. The staged PNG sits in the
 * staging call's `outputDir`, which defaults to a temp directory the OS is free
 * to reap, so a durable index would have to survive a dangling path anyway. And
 * an entry that cannot outlive the tool-server can never be served as the
 * known-good screen after a restart that rebuilt the app underneath it.
 */

export interface StagedBaseline {
  path: string;
  /** Reported as the baseline's age by every diff that uses it. */
  capturedAt: number;
}

const stagedBaselines = new Map<string, StagedBaseline>();

export function stageBaseline(udid: string, path: string): StagedBaseline {
  const staged: StagedBaseline = { path, capturedAt: Date.now() };
  stagedBaselines.set(udid, staged);
  return staged;
}

export function getStagedBaseline(udid: string): StagedBaseline | undefined {
  return stagedBaselines.get(udid);
}
