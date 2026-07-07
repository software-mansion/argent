import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getAdapterByName } from "../src/mcp-configs.js";
import { cleanupStaleMcpConfigs } from "../src/init-stale-config.js";

// ── homedir mock ──────────────────────────────────────────────────────────────
// Same pattern as mcp-configs.test.ts: redirect homedir() to a temp path so
// hidden-scope probes (~/.claude.json, VS Code user profile) never touch the
// real home directory.

let homedirOverride: string | undefined;

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return {
    ...original,
    homedir: vi.fn(() => homedirOverride ?? original.homedir()),
  };
});

// The cleanup policy's "provably dead" check probes PATH via
// isGloballyInstalled; pin it per test instead of depending on whether the
// machine running the suite has argent installed.
let globallyInstalled = false;

vi.mock("../src/utils.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/utils.js")>();
  return {
    ...original,
    isGloballyInstalled: vi.fn(() => globallyInstalled),
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string;
let home: string;
let root: string;

function readJsonFile(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonFile(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

const claude = getAdapterByName("Claude Code")!;
const cursor = getAdapterByName("Cursor")!;
const vscode = getAdapterByName("VS Code")!;
const windsurf = getAdapterByName("Windsurf")!;

const ARGENT_GLOBAL_ENTRY = { type: "stdio", command: "argent", args: ["mcp"] };

function claudeJsonPath(): string {
  return path.join(home, ".claude.json");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-stale-test-"));
  home = path.join(tmpDir, "home");
  root = path.join(tmpDir, "project");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  homedirOverride = home;
  globallyInstalled = false;
});

afterEach(() => {
  homedirOverride = undefined;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Claude Code hidden scopes ─────────────────────────────────────────────────

describe("claudeAdapter.findShadowingConfigs", () => {
  it("finds and removes a local-scope entry keyed to the project root", () => {
    writeJsonFile(claudeJsonPath(), {
      oauthAccount: { email: "user@example.com" },
      projects: {
        [root]: {
          mcpServers: {
            argent: ARGENT_GLOBAL_ENTRY,
            other: { command: "other", args: [] },
          },
          hasTrustDialogAccepted: true,
        },
      },
    });

    const findings = claude.findShadowingConfigs!(root, "local");
    expect(findings).toHaveLength(1);
    expect(findings[0].autoRemove).toBe(true);
    expect(findings[0].entry).toEqual({ command: "argent", args: ["mcp"] });

    expect(findings[0].remove()).toBe(true);

    const after = readJsonFile(claudeJsonPath());
    const project = (after.projects as Record<string, any>)[root];
    // Only the argent key goes; sibling servers and unrelated state survive.
    expect(project.mcpServers.argent).toBeUndefined();
    expect(project.mcpServers.other).toBeDefined();
    expect(project.hasTrustDialogAccepted).toBe(true);
    expect(after.oauthAccount).toEqual({ email: "user@example.com" });
  });

  it("prunes an mcpServers object left empty by the removal", () => {
    writeJsonFile(claudeJsonPath(), {
      projects: { [root]: { mcpServers: { argent: ARGENT_GLOBAL_ENTRY }, trusted: true } },
    });

    const findings = claude.findShadowingConfigs!(root, "local");
    expect(findings[0].remove()).toBe(true);

    const project = (readJsonFile(claudeJsonPath()).projects as Record<string, any>)[root];
    expect(project.mcpServers).toBeUndefined();
    expect(project.trusted).toBe(true);
  });

  it("matches a project key that is a symlink/path variant of the root", () => {
    const link = path.join(tmpDir, "project-link");
    fs.symlinkSync(root, link);
    writeJsonFile(claudeJsonPath(), {
      projects: { [link]: { mcpServers: { argent: ARGENT_GLOBAL_ENTRY } } },
    });

    const findings = claude.findShadowingConfigs!(root, "local");
    expect(findings).toHaveLength(1);
    expect(findings[0].location).toContain(link);
  });

  it("returns nothing and never writes when ~/.claude.json is malformed", () => {
    fs.writeFileSync(claudeJsonPath(), "{ this is not json");

    const findings = claude.findShadowingConfigs!(root, "local");
    expect(findings).toHaveLength(0);
    expect(fs.readFileSync(claudeJsonPath(), "utf8")).toBe("{ this is not json");
  });

  it("returns nothing when no stale state exists", () => {
    writeJsonFile(claudeJsonPath(), { projects: { [root]: { hasTrustDialogAccepted: true } } });
    expect(claude.findShadowingConfigs!(root, "local")).toHaveLength(0);
  });

  it("finds and removes a recorded .mcp.json rejection, keeping other names", () => {
    const settingsPath = path.join(root, ".claude", "settings.json");
    writeJsonFile(settingsPath, { disabledMcpjsonServers: ["argent", "other"] });

    const findings = claude.findShadowingConfigs!(root, "local");
    expect(findings).toHaveLength(1);
    expect(findings[0].entry).toBeNull();
    expect(findings[0].autoRemove).toBe(true);

    expect(findings[0].remove()).toBe(true);
    expect(readJsonFile(settingsPath).disabledMcpjsonServers).toEqual(["other"]);
  });

  it("checks rejections only for a project-scope write", () => {
    const settingsPath = path.join(root, ".claude", "settings.local.json");
    writeJsonFile(settingsPath, { disabledMcpjsonServers: ["argent"] });

    // disabledMcpjsonServers gates .mcp.json entries only; a global (user
    // scope) write is not affected by it.
    expect(claude.findShadowingConfigs!(root, "global")).toHaveLength(0);
    expect(claude.findShadowingConfigs!(root, "local")).toHaveLength(1);
  });
});

// ── VS Code user-profile scope ────────────────────────────────────────────────

describe("vscodeAdapter.findShadowingConfigs", () => {
  function userMcpJsonPath(): string {
    const base =
      process.platform === "darwin"
        ? path.join(home, "Library", "Application Support")
        : process.platform === "win32"
          ? process.env.APPDATA!
          : path.join(home, ".config");
    return path.join(base, "Code", "User", "mcp.json");
  }

  it("reports a user-profile entry as not auto-removable", () => {
    writeJsonFile(userMcpJsonPath(), {
      servers: { argent: { type: "stdio", command: "argent", args: ["mcp"] } },
    });

    const findings = vscode.findShadowingConfigs!(root, "local");
    expect(findings).toHaveLength(1);
    expect(findings[0].autoRemove).toBe(false);
    expect(findings[0].entry).toEqual({ command: "argent", args: ["mcp"] });

    expect(findings[0].remove()).toBe(true);
    expect(fs.existsSync(userMcpJsonPath())).toBe(false);
  });

  it("returns nothing when no user-profile config exists", () => {
    expect(vscode.findShadowingConfigs!(root, "local")).toHaveLength(0);
  });
});

// ── Shared cleanup policy ─────────────────────────────────────────────────────

describe("cleanupStaleMcpConfigs", () => {
  it("auto-removes a Claude local-scope entry even when argent is on PATH", async () => {
    globallyInstalled = true;
    writeJsonFile(claudeJsonPath(), {
      projects: { [root]: { mcpServers: { argent: ARGENT_GLOBAL_ENTRY } } },
    });

    const result = await cleanupStaleMcpConfigs({
      writtenAdapters: [claude],
      detectedAdapters: [claude],
      installMode: "local",
      scope: "local",
      effectiveRoot: root,
    });

    expect(result.removedCount).toBe(1);
    expect(result.warnedCount).toBe(0);
    const project = (readJsonFile(claudeJsonPath()).projects as Record<string, any>)[root];
    expect(project.mcpServers).toBeUndefined();
  });

  it("removes a dead bare-argent global entry on a local install", async () => {
    globallyInstalled = false;
    const cursorGlobal = path.join(home, ".cursor", "mcp.json");
    writeJsonFile(cursorGlobal, { mcpServers: { argent: { command: "argent", args: ["mcp"] } } });

    const result = await cleanupStaleMcpConfigs({
      writtenAdapters: [cursor],
      detectedAdapters: [cursor],
      installMode: "local",
      scope: "local",
      effectiveRoot: root,
    });

    expect(result.removedCount).toBe(1);
    // The entry was the file's only content, so the file itself is pruned.
    expect(fs.existsSync(cursorGlobal)).toBe(false);
  });

  it("leaves a working bare-argent global entry alone, silently", async () => {
    globallyInstalled = true;
    const cursorGlobal = path.join(home, ".cursor", "mcp.json");
    writeJsonFile(cursorGlobal, { mcpServers: { argent: { command: "argent", args: ["mcp"] } } });

    const result = await cleanupStaleMcpConfigs({
      writtenAdapters: [cursor],
      detectedAdapters: [cursor],
      installMode: "local",
      scope: "local",
      effectiveRoot: root,
    });

    expect(result.lines).toHaveLength(0);
    expect(fs.existsSync(cursorGlobal)).toBe(true);
  });

  it("warns about (but never removes) a custom-command global entry", async () => {
    globallyInstalled = false;
    const cursorGlobal = path.join(home, ".cursor", "mcp.json");
    writeJsonFile(cursorGlobal, {
      mcpServers: { argent: { command: "node", args: ["/old/checkout/cli.js", "mcp"] } },
    });

    const result = await cleanupStaleMcpConfigs({
      writtenAdapters: [cursor],
      detectedAdapters: [cursor],
      installMode: "local",
      scope: "local",
      effectiveRoot: root,
    });

    expect(result.removedCount).toBe(0);
    expect(result.warnedCount).toBe(1);
    expect(readJsonFile(cursorGlobal).mcpServers).toBeDefined();
  });

  it("sweeps dead global entries of detected-but-not-written adapters", async () => {
    // Windsurf has no project config, so local mode drops it from the written
    // set — its dead global entry must still be pruned via the detected set.
    globallyInstalled = false;
    const windsurfGlobal = path.join(home, ".codeium", "windsurf", "mcp_config.json");
    writeJsonFile(windsurfGlobal, { mcpServers: { argent: { command: "argent", args: ["mcp"] } } });

    const result = await cleanupStaleMcpConfigs({
      writtenAdapters: [],
      detectedAdapters: [windsurf],
      installMode: "local",
      scope: "local",
      effectiveRoot: root,
    });

    expect(result.removedCount).toBe(1);
    expect(fs.existsSync(windsurfGlobal)).toBe(false);
  });

  it("does not sweep global entries on a global-mode install", async () => {
    globallyInstalled = false;
    const cursorGlobal = path.join(home, ".cursor", "mcp.json");
    writeJsonFile(cursorGlobal, { mcpServers: { argent: { command: "argent", args: ["mcp"] } } });

    const result = await cleanupStaleMcpConfigs({
      writtenAdapters: [cursor],
      detectedAdapters: [cursor],
      installMode: "global",
      scope: "local",
      effectiveRoot: root,
    });

    expect(result.removedCount).toBe(0);
    expect(fs.existsSync(cursorGlobal)).toBe(true);
  });

  it("warns when a local-command project entry outranks a fresh global write", async () => {
    const cursorProject = path.join(root, ".cursor", "mcp.json");
    writeJsonFile(cursorProject, {
      mcpServers: { argent: { command: "node", args: ["node_modules/x/cli.js", "mcp"] } },
    });

    const result = await cleanupStaleMcpConfigs({
      writtenAdapters: [cursor],
      detectedAdapters: [cursor],
      installMode: "global",
      scope: "global",
      effectiveRoot: root,
    });

    expect(result.removedCount).toBe(0);
    expect(result.warnedCount).toBe(1);
    // Potentially a committed team file — must survive untouched.
    expect(readJsonFile(cursorProject).mcpServers).toBeDefined();
  });

  it("stays silent about a bare-argent project entry under a global write", async () => {
    const cursorProject = path.join(root, ".cursor", "mcp.json");
    writeJsonFile(cursorProject, { mcpServers: { argent: { command: "argent", args: ["mcp"] } } });

    const result = await cleanupStaleMcpConfigs({
      writtenAdapters: [cursor],
      detectedAdapters: [cursor],
      installMode: "global",
      scope: "global",
      effectiveRoot: root,
    });

    expect(result.lines).toHaveLength(0);
  });

  it("survives an adapter whose shadow probe throws", async () => {
    const throwing = {
      ...claude,
      findShadowingConfigs: () => {
        throw new Error("broken yaml");
      },
    };

    const result = await cleanupStaleMcpConfigs({
      writtenAdapters: [throwing],
      detectedAdapters: [],
      installMode: "local",
      scope: "local",
      effectiveRoot: root,
    });

    expect(result.warnedCount).toBe(1);
    expect(result.removedCount).toBe(0);
  });

  it("asks once before cross-project removals, listing each entry", async () => {
    globallyInstalled = false;
    const cursorGlobal = path.join(home, ".cursor", "mcp.json");
    writeJsonFile(cursorGlobal, { mcpServers: { argent: { command: "argent", args: ["mcp"] } } });
    const windsurfGlobal = path.join(home, ".codeium", "windsurf", "mcp_config.json");
    writeJsonFile(windsurfGlobal, { mcpServers: { argent: { command: "argent", args: ["mcp"] } } });

    const confirm = vi.fn(async (items: string[]) => {
      expect(items).toHaveLength(2);
      expect(items.join("\n")).toContain(cursorGlobal);
      expect(items.join("\n")).toContain(windsurfGlobal);
      return true;
    });

    const result = await cleanupStaleMcpConfigs({
      writtenAdapters: [cursor],
      detectedAdapters: [cursor, windsurf],
      installMode: "local",
      scope: "local",
      effectiveRoot: root,
      confirmCrossProjectRemovals: confirm,
    });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(result.removedCount).toBe(2);
    expect(fs.existsSync(cursorGlobal)).toBe(false);
    expect(fs.existsSync(windsurfGlobal)).toBe(false);
  });

  it("keeps every dead global entry when the confirmation is declined", async () => {
    globallyInstalled = false;
    const cursorGlobal = path.join(home, ".cursor", "mcp.json");
    writeJsonFile(cursorGlobal, { mcpServers: { argent: { command: "argent", args: ["mcp"] } } });

    const result = await cleanupStaleMcpConfigs({
      writtenAdapters: [cursor],
      detectedAdapters: [cursor],
      installMode: "local",
      scope: "local",
      effectiveRoot: root,
      confirmCrossProjectRemovals: async () => false,
    });

    expect(result.removedCount).toBe(0);
    expect(result.warnedCount).toBe(1);
    expect(readJsonFile(cursorGlobal).mcpServers).toBeDefined();
  });

  it("never prompts for project-confined removals", async () => {
    // Claude's local-scope entry is keyed to this project; removing it cannot
    // affect other workspaces, so it must not be gated on the confirmation.
    globallyInstalled = true;
    writeJsonFile(claudeJsonPath(), {
      projects: { [root]: { mcpServers: { argent: ARGENT_GLOBAL_ENTRY } } },
    });
    const confirm = vi.fn(async () => true);

    const result = await cleanupStaleMcpConfigs({
      writtenAdapters: [claude],
      detectedAdapters: [claude],
      installMode: "local",
      scope: "local",
      effectiveRoot: root,
      confirmCrossProjectRemovals: confirm,
    });

    expect(confirm).not.toHaveBeenCalled();
    expect(result.removedCount).toBe(1);
  });

  it("gates a dead VS Code user-profile entry behind the confirmation", async () => {
    globallyInstalled = false;
    const base =
      process.platform === "darwin"
        ? path.join(home, "Library", "Application Support")
        : process.platform === "win32"
          ? process.env.APPDATA!
          : path.join(home, ".config");
    const userMcpJson = path.join(base, "Code", "User", "mcp.json");
    writeJsonFile(userMcpJson, {
      servers: { argent: { type: "stdio", command: "argent", args: ["mcp"] } },
    });
    const confirm = vi.fn(async () => true);

    const result = await cleanupStaleMcpConfigs({
      writtenAdapters: [vscode],
      detectedAdapters: [vscode],
      installMode: "local",
      scope: "local",
      effectiveRoot: root,
      confirmCrossProjectRemovals: confirm,
    });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(result.removedCount).toBe(1);
    expect(fs.existsSync(userMcpJson)).toBe(false);
  });
});
