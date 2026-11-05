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
  },
  {
    path: "references/quality-control-checklist.md",
    shipped: [hashBundledContent(CHECKLIST)],
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
  it("removes without asking when told not to ask, as under --yes", async () => {
    const result = await cleanupRetiredFiles(stage(), { ask: false });

    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(fs.existsSync(inspector())).toBe(false);
    expect(formatRetiredCleanup(result)).toEqual({
      removed: ["Removed retired agent argent-environment-inspector.md from .claude/agents"],
      kept: [],
    });
  });

  it("leaves an edited copy alone and does not mention it", async () => {
    const found = stage();

    expect(found[0].files.map((f) => f.relativePath)).toEqual(["argent-environment-inspector.md"]);
    prompts.confirm.mockResolvedValueOnce(true);
    await cleanupRetiredFiles(found, { ask: true });

    expect(prompts.warn).toHaveBeenCalledWith(expect.not.stringContaining("quality-control"));
    expect(fs.existsSync(inspector())).toBe(false);
    expect(fs.readFileSync(checklist(), "utf8")).toBe(`${CHECKLIST}My own field.\n`);
  });

  it("lists the copies and asks before removing them", async () => {
    writeFile(inspector(), INSPECTOR);
    prompts.confirm.mockResolvedValueOnce(true);

    const result = await cleanupRetiredFiles(find(), { ask: true });

    expect(prompts.warn).toHaveBeenCalledWith(
      expect.stringContaining(path.join(".claude/agents", "argent-environment-inspector.md"))
    );
    expect(prompts.confirm).toHaveBeenCalledTimes(1);
    expect(prompts.confirm).toHaveBeenCalledWith({ message: "Remove them?", initialValue: true });
    expect(fs.existsSync(inspector())).toBe(false);
    // The target held nothing else, so it went too.
    expect(result.removedRoots).toEqual([agents]);
  });

  it("keeps the copies the user declines", async () => {
    writeFile(inspector(), INSPECTOR);
    prompts.confirm.mockResolvedValueOnce(false);

    const result = await cleanupRetiredFiles(find(), { ask: true });

    expect(fs.existsSync(inspector())).toBe(true);
    expect(formatRetiredCleanup(result)).toEqual({
      removed: [],
      kept: [
        "Kept, as you chose (rename one to keep it for good):",
        `  ${path.join(".claude/agents", "argent-environment-inspector.md")}`,
      ],
    });
  });

  it("reads a cancelled prompt as no", async () => {
    writeFile(inspector(), INSPECTOR);
    prompts.confirm.mockResolvedValue(Symbol("cancel"));

    await cleanupRetiredFiles(find(), { ask: true });

    expect(fs.existsSync(inspector())).toBe(true);
  });

  it("keeps a file the user changed while the prompt was open", async () => {
    writeFile(inspector(), INSPECTOR);
    prompts.confirm.mockImplementationOnce(async () => {
      fs.appendFileSync(inspector(), "Changed meanwhile.\n");
      return true;
    });

    const result = await cleanupRetiredFiles(find(), { ask: true });

    expect(fs.existsSync(inspector())).toBe(true);
    expect(result.failed).toEqual([path.join(".claude/agents", "argent-environment-inspector.md")]);
  });
});
