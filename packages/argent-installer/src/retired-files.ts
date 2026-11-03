import * as path from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import type { RetiredTargetFiles } from "./mcp-configs.js";
import { removeRetiredFiles, type RetiredFile } from "./utils.js";

interface RetiredCleanupOptions {
  /** Ask before removing. False under --yes, and where the caller already asked. */
  ask: boolean;
}

export interface RetiredCleanup {
  removed: string[];
  /** Paths the user chose to keep. */
  declined: string[];
  /** Paths approved for removal that changed since, or could not be deleted. */
  failed: string[];
  /** Target dirs the cleanup emptied and removed. */
  removedRoots: string[];
}

function displayPath(entry: RetiredTargetFiles, file: RetiredFile): string {
  return path.join(entry.location, ...file.relativePath.split("/"));
}

// Files argent once installed and no longer ships. Each is a copy of a version
// argent shipped, so removing it loses nothing of the user's.
export async function cleanupRetiredFiles(
  found: RetiredTargetFiles[],
  options: RetiredCleanupOptions
): Promise<RetiredCleanup> {
  const result: RetiredCleanup = { removed: [], declined: [], failed: [], removedRoots: [] };
  const paths = found.flatMap((entry) => entry.files.map((file) => displayPath(entry, file)));
  if (paths.length === 0) return result;

  if (options.ask) {
    p.log.warn(
      "Argent no longer ships these files, but your editors still load them:\n" +
        paths.map((item) => `  ${pc.cyan(item)}`).join("\n")
    );
    const answer = await p.confirm({ message: "Remove them?", initialValue: true });
    if (p.isCancel(answer) || answer !== true) {
      result.declined = paths;
      return result;
    }
  }

  for (const entry of found) {
    const label = entry.kind === "rules" ? "rule" : "agent";
    const { removedPaths, removedRoot } = removeRetiredFiles(entry.target.targetPath, entry.files);
    if (removedRoot) result.removedRoots.push(entry.target.targetPath);

    for (const file of entry.files) {
      if (removedPaths.includes(file.relativePath)) {
        result.removed.push(`Removed retired ${label} ${file.relativePath} from ${entry.location}`);
      } else {
        result.failed.push(displayPath(entry, file));
      }
    }
  }

  return result;
}

// Read by the user, or by an agent that ran the command: what stayed, and why.
export function formatRetiredCleanup(result: RetiredCleanup): {
  removed: string[];
  kept: string[];
} {
  const kept: string[] = [];
  const group = (heading: string, paths: string[]) => {
    if (paths.length > 0) kept.push(heading, ...paths.map((item) => `  ${item}`));
  };
  group("Kept, as you chose (rename one to keep it for good):", result.declined);
  group("Could not remove (changed since listed, or not deletable):", result.failed);
  return { removed: result.removed, kept };
}

// init and update: find, ask, remove, report.
export async function reportRetiredFiles(
  found: RetiredTargetFiles[],
  interactive: boolean
): Promise<void> {
  if (found.length === 0) return;
  const { removed, kept } = formatRetiredCleanup(
    await cleanupRetiredFiles(found, { ask: interactive })
  );
  const lines = [...removed, ...kept];
  if (lines.length > 0)
    p.note(lines.map((line) => `  ${line}`).join("\n"), "Files Argent No Longer Ships");
}
