import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const prompts = vi.hoisted(() => ({
  confirm: vi.fn(),
  isCancel: vi.fn((value: unknown) => typeof value === "symbol"),
  warn: vi.fn(),
  note: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  confirm: prompts.confirm,
  isCancel: prompts.isCancel,
  log: { warn: prompts.warn },
  note: prompts.note,
}));

import { cleanupRetiredFiles, formatRetiredCleanup } from "../src/retired-files.js";
import { findRetiredFiles, hashBundledContent } from "../src/utils.js";
import type { RetiredTargetFiles } from "../src/mcp-configs.js";

const INSPECTOR = "---\nname: argent-environment-inspector\n---\n\nInspects.\n";
const CHECKLIST = "## Quality control checklist\n\nFields.\n";
const RETIRED = [
  {
    path: "argent-environment-inspector.md",
    shipped: [hashBundledContent(INSPECTOR)],
    marker: "name: argent-environment-inspector",
  },
  {
    path: "references/quality-control-checklist.md",
    shipped: [hashBundledContent(CHECKLIST)],
    marker: "## Quality control checklist",
  },
];

let tmpDir: string;
let agents: string;
const inspector = () => path.join(agents, "argent-environment-inspector.md");
const checklist = () => path.join(agents, "references", "quality-control-checklist.md");

function writeFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

// The inspector as argent shipped it, the checklist with the user's changes.
function stage(): RetiredTargetFiles[] {
  writeFile(inspector(), INSPECTOR);
  writeFile(checklist(), `${CHECKLIST}My own field.\n`);
  return find();
}

function find(): RetiredTargetFiles[] {
  const target = { editorName: "Claude Code", targetPath: agents, label: ".claude/agents" };
  const files = findRetiredFiles(RETIRED, path.join(tmpDir, "bundle"), agents);
  return files.length > 0 ? [{ kind: "agents", target, location: target.label, files }] : [];
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-retired-files-test-"));
  agents = path.join(tmpDir, ".claude", "agents");
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("cleanupRetiredFiles", () => {
  it("under --yes removes unedited copies without asking, and keeps edited ones", async () => {
    const result = await cleanupRetiredFiles(stage(), {
      interactive: false,
      confirmUnedited: true,
    });

    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(fs.existsSync(inspector())).toBe(false);
    expect(fs.existsSync(checklist())).toBe(true);
    expect(formatRetiredCleanup(result)).toEqual({
      removed: ["Removed retired agent argent-environment-inspector.md from .claude/agents"],
      kept: [
        "Kept, as they were edited. Delete them if no longer needed:",
        `  ${path.join(".claude/agents", "references", "quality-control-checklist.md")}`,
      ],
    });
  });

  it("lists the unedited copies and asks before removing them", async () => {
    writeFile(inspector(), INSPECTOR);
    prompts.confirm.mockResolvedValueOnce(true);

    const result = await cleanupRetiredFiles(find(), { interactive: true, confirmUnedited: true });

    expect(prompts.warn).toHaveBeenCalledWith(
      expect.stringContaining(path.join(".claude/agents", "argent-environment-inspector.md"))
    );
    expect(prompts.confirm).toHaveBeenCalledWith({ message: "Remove them?", initialValue: true });
    expect(fs.existsSync(inspector())).toBe(false);
    // The target held nothing else, so it went too.
    expect(result.removedRoots).toEqual([agents]);
  });

  it("keeps unedited copies the user declines", async () => {
    writeFile(inspector(), INSPECTOR);
    prompts.confirm.mockResolvedValueOnce(false);

    const result = await cleanupRetiredFiles(find(), { interactive: true, confirmUnedited: true });

    expect(fs.existsSync(inspector())).toBe(true);
    expect(result.declined).toEqual([
      path.join(".claude/agents", "argent-environment-inspector.md"),
    ]);
  });

  it("asks about edited copies on their own, defaulting to keep them", async () => {
    prompts.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);

    await cleanupRetiredFiles(stage(), { interactive: true, confirmUnedited: true });

    expect(prompts.confirm).toHaveBeenLastCalledWith({
      message: "Remove them too?",
      initialValue: false,
    });
    expect(fs.existsSync(inspector())).toBe(false);
    expect(fs.existsSync(checklist())).toBe(false);
  });

  it("reads a cancelled prompt as no", async () => {
    prompts.confirm.mockResolvedValue(Symbol("cancel"));

    await cleanupRetiredFiles(stage(), { interactive: true, confirmUnedited: true });

    expect(fs.existsSync(inspector())).toBe(true);
    expect(fs.existsSync(checklist())).toBe(true);
  });

  it("does not ask about unedited copies when the caller already has", async () => {
    writeFile(inspector(), INSPECTOR);

    await cleanupRetiredFiles(find(), { interactive: true, confirmUnedited: false });

    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(fs.existsSync(inspector())).toBe(false);
  });

  it("keeps a file the user changed while the prompt was open", async () => {
    writeFile(inspector(), INSPECTOR);
    prompts.confirm.mockImplementationOnce(async () => {
      fs.appendFileSync(inspector(), "Changed meanwhile.\n");
      return true;
    });

    const result = await cleanupRetiredFiles(find(), { interactive: true, confirmUnedited: true });

    expect(fs.existsSync(inspector())).toBe(true);
    expect(result.failed).toEqual([path.join(".claude/agents", "argent-environment-inspector.md")]);
  });
});
