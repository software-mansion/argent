import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Its own file: mcp-configs caches the bundled names on first use, so the
// stand-in bundle has to be in place before any detection runs.
const fixture = vi.hoisted(() => ({ agentsDir: "", home: "" }));

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, homedir: vi.fn(() => fixture.home || original.homedir()) };
});

// A release whose agents bundle no longer ships the inspector.
vi.mock("../src/utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils.js")>();
  return {
    ...actual,
    get AGENTS_DIR() {
      return fixture.agentsDir;
    },
  };
});

import { ALL_ADAPTERS } from "../src/mcp-configs.js";

const gemini = ALL_ADAPTERS.find((a) => a.name === "Gemini")!;
let bundleRoot: string;
let tmpDir: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;

function writeFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

beforeAll(() => {
  bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argent-retired-bundle-"));
  fixture.agentsDir = path.join(bundleRoot, "agents");
  writeFile(path.join(fixture.agentsDir, "argent-current.md"), "current");
});

afterAll(() => {
  fs.rmSync(bundleRoot, { recursive: true, force: true });
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-retired-detect-"));
  fixture.home = path.join(tmpDir, "home");
  fs.mkdirSync(path.join(tmpDir, "proj"), { recursive: true });
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(path.join(tmpDir, "proj"));
});

afterEach(() => {
  cwdSpy.mockRestore();
  fixture.home = "";
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("detection with a retired agent left behind", () => {
  function stageArgentOnlyGemini(): string {
    const agents = path.join(fixture.home, ".gemini", "agents");
    writeFile(path.join(agents, "argent-current.md"), "current");
    writeFile(path.join(agents, "argent-environment-inspector.md"), "old");
    writeFile(path.join(agents, "references", "quality-control-checklist.md"), "old");
    return agents;
  }

  it("does not count a retired agent as evidence the editor is installed", () => {
    stageArgentOnlyGemini();

    expect(gemini.detect()).toBe(false);
  });

  it("still counts the user's own agent as evidence", () => {
    const agents = stageArgentOnlyGemini();
    writeFile(path.join(agents, "my-agent.md"), "mine");

    expect(gemini.detect()).toBe(true);
  });
});
