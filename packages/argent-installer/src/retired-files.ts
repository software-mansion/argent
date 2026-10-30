import * as path from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import type { RetiredTargetFiles } from "./mcp-configs.js";
import { removeRetiredFiles, type RetiredFile } from "./utils.js";

interface RetiredCleanupOptions {
  /** False under --yes: unedited copies then go unasked, edited ones stay. */
  interactive: boolean;
  /** Ask before removing unedited copies. Uninstall's prune prompt already did. */
  confirmUnedited: boolean;
}

export interface RetiredCleanup {
  removed: string[];
  /** Paths of unedited copies the user chose to keep. */
  declined: string[];
  /** Paths of edited copies, kept unless the user chose otherwise. */
  edited: string[];
  /** Paths approved for removal that changed since, or could not be deleted. */
  failed: string[];
  /** Target dirs the cleanup emptied and removed. */
  removedRoots: string[];
}

interface FoundFile {
  found: RetiredTargetFiles;
  file: RetiredFile;
}

function displayPath({ found, file }: FoundFile): string {
  return path.join(found.location, ...file.relativePath.split("/"));
}

async function confirmRemoval(
  heading: string,
  files: FoundFile[],
  message: string,
  initialValue: boolean
): Promise<boolean> {
  p.log.warn(`${heading}\n${files.map((f) => `  ${pc.cyan(displayPath(f))}`).join("\n")}`);
  const answer = await p.confirm({ message, initialValue });
  return !p.isCancel(answer) && answer === true;
}

// Files argent once installed and no longer ships. A copy of a version argent
// shipped holds nothing of the user's; an edited copy might, so it goes only
// when the user says so, and never under --yes.
export async function cleanupRetiredFiles(
  found: RetiredTargetFiles[],
  options: RetiredCleanupOptions
): Promise<RetiredCleanup> {
  const all = found.flatMap((entry) => entry.files.map((file) => ({ found: entry, file })));
  const unedited = all.filter(({ file }) => !file.edited);
  const edited = all.filter(({ file }) => file.edited);

  let removeUnedited = unedited.length > 0;
  if (removeUnedited && options.interactive && options.confirmUnedited) {
    removeUnedited = await confirmRemoval(
      "Argent no longer ships these files, but your editors still load them:",
      unedited,
      "Remove them?",
      true
    );
  }
  let removeEdited = false;
  if (edited.length > 0 && options.interactive) {
    removeEdited = await confirmRemoval(
      "Argent no longer ships these files either, but they differ from the copy it installed, " +
        "so they may hold your changes:",
      edited,
      "Remove them too?",
      false
    );
  }

  const approved = new Set<FoundFile>([
    ...(removeUnedited ? unedited : []),
    ...(removeEdited ? edited : []),
  ]);
  const result: RetiredCleanup = {
    removed: [],
    declined: [],
    edited: [],
    failed: [],
    removedRoots: [],
  };

  for (const entry of found) {
    const label = entry.kind === "rules" ? "rule" : "agent";
    const files = all.filter((f) => f.found === entry);
    const { removedPaths, removedRoot } = removeRetiredFiles(
      entry.target.targetPath,
      files.filter((f) => approved.has(f)).map((f) => f.file)
    );
    if (removedRoot) result.removedRoots.push(entry.target.targetPath);

    for (const f of files) {
      if (removedPaths.includes(f.file.relativePath)) {
        result.removed.push(
          `Removed retired ${label} ${f.file.relativePath} from ${entry.location}`
        );
      } else if (approved.has(f)) {
        result.failed.push(displayPath(f));
      } else if (f.file.edited) {
        result.edited.push(displayPath(f));
      } else {
        result.declined.push(displayPath(f));
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
  group("Kept, as they were edited. Delete them if no longer needed:", result.edited);
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
    await cleanupRetiredFiles(found, { interactive, confirmUnedited: true })
  );
  const lines = [...removed, ...kept];
  if (lines.length > 0)
    p.note(lines.map((line) => `  ${line}`).join("\n"), "Files Argent No Longer Ships");
}
