import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { chooseAdapters } from "../src/init-adapters.js";
import { ALL_ADAPTERS, getMcpEntry } from "../src/mcp-configs.js";

// Redirect homedir() to a temp path so detection never sees the real machine.
let homedirOverride: string | undefined;

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return {
    ...original,
    homedir: vi.fn(() => homedirOverride ?? original.homedir()),
  };
});

// opencode detects by probing for its binary; make the probe fail so the
// selection logic under test sees a machine without it.
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    execFileSync: vi.fn(() => {
      throw new Error("not found");
    }),
  };
});

describe("chooseAdapters (non-interactive)", () => {
  let tmpDir: string;
  let home: string;
  let proj: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  const cursor = ALL_ADAPTERS.find((a) => a.name === "Cursor")!;
  const claude = ALL_ADAPTERS.find((a) => a.name === "Claude Code")!;
  const vscode = ALL_ADAPTERS.find((a) => a.name === "VS Code")!;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-init-adapters-"));
    home = path.join(tmpDir, "home");
    proj = path.join(tmpDir, "proj");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(proj, { recursive: true });
    homedirOverride = home;
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(proj);
  });

  afterEach(() => {
    homedirOverride = undefined;
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("falls back to all eligible editors when nothing is detected or configured", async () => {
    const { selected, detected } = await chooseAdapters({
      nonInteractive: true,
      installMode: "local",
    });
    expect(detected).toEqual([]);
    // Local mode: every adapter with a project-level config.
    expect(selected.map((a) => a.name)).toEqual(
      ALL_ADAPTERS.filter((a) => a.projectPath(proj) != null).map((a) => a.name)
    );
  });

  it("selects only the previously configured editor on a teammate clone (committed argent-only .cursor)", async () => {
    // The repo commits exactly what local-mode Team Setup tells it to: an
    // argent-only .cursor/mcp.json. The evidence check correctly detects
    // nothing, but the committed argent entry must select Cursor — NOT fall
    // through to the configure-everything fallback.
    cursor.write(path.join(proj, ".cursor", "mcp.json"), getMcpEntry());

    const { selected, detected } = await chooseAdapters({
      nonInteractive: true,
      installMode: "local",
    });
    expect(detected).toEqual([]);
    expect(selected.map((a) => a.name)).toEqual(["Cursor"]);
  });

  it("keeps maintaining every previously configured editor on a re-run (no orphaning)", async () => {
    // First-run state: argent wrote project configs for several editors. A
    // re-run must keep ALL of them selected — including the ones whose dirs
    // are argent-only and therefore no longer "detected" — so their configs
    // keep being rewritten on version bumps.
    cursor.write(path.join(proj, ".cursor", "mcp.json"), getMcpEntry());
    claude.write(path.join(proj, ".mcp.json"), getMcpEntry());
    vscode.write(path.join(proj, ".vscode", "mcp.json"), getMcpEntry());

    const { selected } = await chooseAdapters({ nonInteractive: true, installMode: "local" });
    expect(selected.map((a) => a.name).sort()).toEqual(["Claude Code", "Cursor", "VS Code"]);
  });

  it("unions detected and previously configured editors", async () => {
    cursor.write(path.join(proj, ".cursor", "mcp.json"), getMcpEntry());
    // Real user evidence for VS Code, no argent entry.
    fs.mkdirSync(path.join(proj, ".vscode"), { recursive: true });
    fs.writeFileSync(path.join(proj, ".vscode", "settings.json"), "{}");

    const { selected, detected } = await chooseAdapters({
      nonInteractive: true,
      installMode: "local",
    });
    expect(detected.map((a) => a.name)).toEqual(["VS Code"]);
    expect(selected.map((a) => a.name).sort()).toEqual(["Cursor", "VS Code"]);
  });

  it("local mode ignores global-scope argent entries (a global install is not project intent)", async () => {
    cursor.write(path.join(home, ".cursor", "mcp.json"), getMcpEntry());

    const { selected, detected } = await chooseAdapters({
      nonInteractive: true,
      installMode: "local",
    });
    expect(detected).toEqual([]);
    // Nothing project-scoped exists → the eligible-fallback applies as before.
    expect(selected.map((a) => a.name)).toEqual(
      ALL_ADAPTERS.filter((a) => a.projectPath(proj) != null).map((a) => a.name)
    );
  });

  it("global mode selects editors with a global-scope argent entry", async () => {
    cursor.write(path.join(home, ".cursor", "mcp.json"), getMcpEntry());

    const { selected, detected } = await chooseAdapters({
      nonInteractive: true,
      installMode: "global",
    });
    expect(detected).toEqual([]);
    expect(selected.map((a) => a.name)).toEqual(["Cursor"]);
  });
});
