import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { AGENTS_DIR, listBundledSkills, RULES_DIR, type McpServerEntry } from "@argent/installer";
import {
  claudeProjectKey,
  editorsSection,
  gitToplevel,
  isRejectedJson,
  linksToRemote,
} from "../src/doctor-editors.js";
import { type DoctorContext, type EntryToolsUrl } from "../src/doctor-shared.js";
import { skillsSection } from "../src/doctor-skills.js";

let projectRoot: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argent-doctor-"));
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe("claudeProjectKey", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd,
      stdio: "ignore",
    });

  it("is the git root, from any subfolder", () => {
    git(projectRoot, "init", "-q");
    const sub = path.join(projectRoot, "packages", "app");
    fs.mkdirSync(sub, { recursive: true });
    expect(claudeProjectKey(sub)).toBe(fs.realpathSync(projectRoot));
  });

  it("is the main checkout for a linked worktree", () => {
    const main = path.join(projectRoot, "repo");
    fs.mkdirSync(main);
    git(main, "init", "-q");
    git(main, "commit", "-q", "--allow-empty", "-m", "init");
    git(main, "worktree", "add", "-q", path.join(projectRoot, "wt"));
    expect(claudeProjectKey(path.join(projectRoot, "wt"))).toBe(fs.realpathSync(main));
  });

  it("is the directory itself outside git", () => {
    expect(claudeProjectKey(projectRoot)).toBe(fs.realpathSync(projectRoot));
  });

  const linkWorktree = (worktree: string, gitDir: string, commonDir?: string) => {
    fs.mkdirSync(gitDir, { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    if (commonDir) fs.writeFileSync(path.join(gitDir, "commondir"), commonDir);
  };

  it("is the bare repo for a worktree of one", () => {
    const bare = path.join(projectRoot, "repo.git");
    const wt = path.join(projectRoot, "wt-main");
    linkWorktree(wt, path.join(bare, "worktrees", "wt-main"), "../..");
    fs.mkdirSync(path.join(wt, "app"));
    expect(claudeProjectKey(path.join(wt, "app"))).toBe(fs.realpathSync(bare));
  });

  it("is the submodule's own checkout", () => {
    const sub = path.join(projectRoot, "super", "sub");
    fs.mkdirSync(path.join(projectRoot, "super", ".git"), { recursive: true });
    linkWorktree(sub, path.join(projectRoot, "super", ".git", "modules", "sub"));
    fs.mkdirSync(path.join(sub, "pkg"));
    expect(claudeProjectKey(path.join(sub, "pkg"))).toBe(fs.realpathSync(sub));
  });
});

describe("gitToplevel", () => {
  it("is the linked worktree's own root, not the main checkout", () => {
    const wt = path.join(projectRoot, "wt");
    fs.mkdirSync(path.join(wt, "src"), { recursive: true });
    fs.writeFileSync(path.join(wt, ".git"), "gitdir: /elsewhere\n");
    expect(gitToplevel(path.join(wt, "src"))).toBe(fs.realpathSync(wt));
  });
});

describe("isRejectedJson", () => {
  const rejects = (editor: string, text: string) => {
    const file = path.join(projectRoot, "x.json");
    fs.writeFileSync(file, text);
    return isRejectedJson(editor, file);
  };

  it("rejects what Claude Code can't parse, but allows a BOM", () => {
    expect(rejects("Claude Code", '{"a":1}')).toBe(false);
    expect(rejects("Claude Code", '﻿{"a":1}')).toBe(false);
    expect(rejects("Claude Code", '{"a":1,}')).toBe(true);
    expect(rejects("Claude Code", '{"a":1 // c\n}')).toBe(true);
  });

  it("allows Gemini comments but not trailing commas", () => {
    expect(rejects("Gemini", '{"a":1 // c\n}')).toBe(false);
    expect(rejects("Gemini", '{"a":{"b":1,},}')).toBe(true);
  });

  it("allows opencode comments and trailing commas, but not broken syntax", () => {
    expect(rejects("opencode", '{"a":1, // c\n}')).toBe(false);
    expect(rejects("opencode", '{"a":{"b":1}')).toBe(true);
  });

  it("leaves other editors' configs to the lenient read", () => {
    expect(rejects("Cursor", '{"a":{"b":1,},}')).toBe(false);
  });
});

describe("editor and skill sections", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "argent-doctor-home-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const doctorCtx = (): DoctorContext => ({
    projectRoot,
    cwd: projectRoot,
    mode: "global",
    global: { bin: "/usr/local/bin/argent", root: null, version: null },
    argentCmd: "argent",
    installCmd: "npm install",
    offPathGlobalBin: null,
  });
  const writeJson = (file: string, value: unknown) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  const localScope = (servers: unknown, extra: Record<string, unknown> = {}) =>
    writeJson(path.join(home, ".claude.json"), {
      projects: { [projectRoot]: { mcpServers: servers, ...extra } },
    });
  const argent = { command: "argent", args: ["mcp"] };

  it("judges a VS Code user-profile entry when there is no workspace entry", () => {
    const userDir =
      process.platform === "darwin"
        ? path.join(home, "Library", "Application Support", "Code", "User")
        : path.join(home, ".config", "Code", "User");
    writeJson(path.join(userDir, "mcp.json"), { servers: { argent } });
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.find((c) => c.label.startsWith("VS Code"))?.status).toBe("ok");
    expect(checks.some((c) => c.status === "error")).toBe(false);
  });

  it("does not fail a Claude Code project entry that a local-scope entry outranks", () => {
    writeJson(path.join(projectRoot, ".mcp.json"), {
      mcpServers: { argent: { command: "/nonexistent/argent", args: ["mcp"] } },
    });
    localScope({ argent });
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.some((c) => c.status === "error")).toBe(false);
    expect(checks.find((c) => c.label.includes("/nonexistent/argent"))?.label).toMatch(
      /unused: the local-scope entry wins/
    );
  });

  it("finds Codex and opencode project config at the git root above a package root", () => {
    const pkg = path.join(projectRoot, "packages", "app");
    fs.mkdirSync(path.join(pkg, ".vscode"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, ".codex"));
    fs.writeFileSync(
      path.join(projectRoot, ".codex", "config.toml"),
      '[mcp_servers.argent]\ncommand = "argent"\nargs = ["mcp"]\n'
    );
    writeJson(path.join(projectRoot, "opencode.json"), {
      mcp: { argent: { type: "local", command: ["argent", "mcp"] } },
    });
    const ctx = { ...doctorCtx(), projectRoot: pkg, cwd: pkg, gitRoot: projectRoot };
    const labels = editorsSection(ctx).checks.map((c) => `${c.status} ${c.label}`);
    expect(labels).toEqual(
      expect.arrayContaining(["ok Codex: argent mcp", "ok opencode: argent mcp"])
    );
  });

  it("ignores the cwd of a Claude Code entry, which Claude Code never applies", () => {
    const rel = "node_modules/@swmansion/argent/dist/cli.js";
    fs.mkdirSync(path.dirname(path.join(projectRoot, "apps", "mobile", rel)), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "apps", "mobile", rel), "");
    writeJson(path.join(projectRoot, ".mcp.json"), {
      mcpServers: { argent: { command: "node", args: [rel, "mcp"], cwd: "apps/mobile" } },
    });
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.find((c) => c.label.startsWith("Claude Code"))?.status).toBe("error");
  });

  describe("cwd an editor resolves differently", () => {
    const rel = "node_modules/@swmansion/argent/dist/cli.js";
    const nodeEntry = (cwd: string) => ({ command: "node", args: [rel, "mcp"], cwd });

    beforeEach(() => {
      fs.mkdirSync(path.dirname(path.join(projectRoot, "apps", "mobile", rel)), {
        recursive: true,
      });
      fs.writeFileSync(path.join(projectRoot, "apps", "mobile", rel), "");
    });

    it("leaves ${workspaceFolder} in a Gemini cwd unexpanded", () => {
      writeJson(path.join(projectRoot, ".gemini", "settings.json"), {
        mcpServers: { argent: nodeEntry("${workspaceFolder}/apps/mobile") },
      });
      const checks = editorsSection(doctorCtx()).checks;
      expect(checks.find((c) => c.label.startsWith("Gemini: node"))?.status).toBe("info");
    });

    it("does not resolve a relative Kiro cwd against the project", () => {
      writeJson(path.join(projectRoot, ".kiro", "settings", "mcp.json"), {
        mcpServers: { argent: nodeEntry("apps/mobile") },
      });
      const checks = editorsSection(doctorCtx()).checks;
      expect(checks.find((c) => c.label.startsWith("Kiro"))?.label).toMatch(
        /relative to the editor's own directory/
      );
    });
  });

  it("flags a .mcp.json Claude Code cannot parse", () => {
    fs.writeFileSync(
      path.join(projectRoot, ".mcp.json"),
      '{"mcpServers":{"argent":{"command":"argent","args":["mcp"]}},}'
    );
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.find((c) => c.status === "error")?.label).toMatch(/not valid JSON/);
    expect(checks.some((c) => c.label === "Claude Code: argent mcp")).toBe(false);
  });

  it("finds argent on the inherited PATH for a VS Code entry that only adds a dir to PATH", () => {
    const entry = { type: "stdio", ...argent, env: { PATH: path.join(projectRoot, "no-argent") } };
    writeJson(path.join(projectRoot, ".vscode", "mcp.json"), { servers: { argent: entry } });
    writeJson(path.join(projectRoot, ".cursor", "mcp.json"), { mcpServers: { argent: entry } });
    const checks = editorsSection(doctorCtx()).checks;
    expect(statusOf(checks, "VS Code: argent mcp")).toBe("ok");
    expect(statusOf(checks, "Cursor: argent mcp")).toBe("error");
  });

  it("flags a Gemini settings.json with a trailing comma, which Gemini refuses to load", () => {
    fs.mkdirSync(path.join(home, ".gemini"));
    fs.writeFileSync(
      path.join(home, ".gemini", "settings.json"),
      '{"mcpServers": {"argent": {"command":"argent","args":["mcp"],}},}'
    );
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.find((c) => c.status === "error")).toMatchObject({
      label: "Gemini: the config file is not valid JSON, so Gemini won't load it",
      detail: "~/.gemini/settings.json",
    });
    expect(checks.some((c) => c.label === "Gemini: argent mcp")).toBe(false);
  });

  it("ignores a leftover /mcp toggle when Claude Code has no argent entry", () => {
    writeJson(path.join(home, ".claude.json"), {
      projects: { [projectRoot]: { disabledMcpServers: ["argent"] } },
    });
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.some((c) => c.label.includes("switched off"))).toBe(false);
  });

  it("ignores a switch-off key the editor does not honour", () => {
    writeJson(path.join(projectRoot, ".mcp.json"), {
      mcpServers: { argent: { ...argent, disabled: true } },
    });
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.find((c) => c.label.startsWith("Claude Code"))?.status).toBe("ok");
  });

  it("warns about a Zed entry switched off with `enabled: false`", () => {
    writeJson(path.join(projectRoot, ".zed", "settings.json"), {
      context_servers: { argent: { source: "custom", enabled: false, ...argent } },
    });
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.find((c) => c.label.startsWith("Zed"))?.label).toMatch(/switched off/);
  });

  it("warns about a Kiro entry that carries both switch-off keys", () => {
    writeJson(path.join(projectRoot, ".kiro", "settings", "mcp.json"), {
      mcpServers: { argent: { ...argent, enabled: false, disabled: true } },
    });
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.find((c) => c.label.startsWith("Kiro"))?.label).toMatch(/switched off/);
  });

  it("judges the user entry Claude Code runs when the .mcp.json one is rejected", () => {
    writeJson(path.join(projectRoot, ".mcp.json"), { mcpServers: { argent } });
    writeJson(path.join(projectRoot, ".claude", "settings.local.json"), {
      disabledMcpjsonServers: ["argent"],
    });
    writeJson(path.join(home, ".claude.json"), {
      mcpServers: { argent: { command: "/opt/gone/bin/argent", args: ["mcp"] } },
    });
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.find((c) => c.label.includes("/opt/gone/bin/argent"))?.status).toBe("error");
    expect(
      checks.find((c) => c.label === "Claude Code: argent mcp (not loaded: rejected, see below)")
    ).toBeDefined();
    expect(checks.find((c) => /disabledMcpjsonServers/.test(c.label))?.fix).toMatch(
      /Remove "argent"/
    );
  });

  it("does not list an editor whose config is unparseable as detected without argent", () => {
    writeJson(path.join(home, ".claude", "settings.json"), { model: "x" });
    fs.writeFileSync(
      path.join(projectRoot, ".mcp.json"),
      '// argent\n{"mcpServers":{"argent":{"command":"argent","args":["mcp"]}}}'
    );
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.some((c) => /Detected without argent:.*Claude Code/.test(c.label))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("lists a config once when HOME is a symlink", () => {
    const link = path.join(os.tmpdir(), `argent-doctor-homelink-${process.pid}`);
    fs.rmSync(link, { force: true });
    fs.symlinkSync(projectRoot, link);
    try {
      vi.stubEnv("HOME", link);
      writeJson(path.join(projectRoot, ".cursor", "mcp.json"), { mcpServers: { argent } });
      const checks = editorsSection(doctorCtx()).checks;
      expect(checks.filter((c) => c.label.startsWith("Cursor")).length).toBe(1);
    } finally {
      fs.rmSync(link, { force: true });
    }
  });

  it("reads Claude Code's local scope under its own project key, matched exactly", () => {
    const repo = path.join(projectRoot, "repo");
    writeJson(path.join(home, ".claude.json"), {
      projects: { [repo]: { mcpServers: { argent } } },
    });
    const inPackage = {
      ...doctorCtx(),
      projectRoot: path.join(repo, "packages", "app"),
      claudeKey: repo,
    };
    expect(
      editorsSection(inPackage).checks.find((c) => c.label.startsWith("Claude Code"))?.status
    ).toBe("ok");
    const alias = { ...inPackage, claudeKey: `${repo}/` };
    expect(
      editorsSection(alias).checks.some((c) => c.label.startsWith("Claude Code: argent"))
    ).toBe(false);
  });

  it("warns about a Cursor entry switched off with `disabled: true`", () => {
    writeJson(path.join(projectRoot, ".cursor", "mcp.json"), {
      mcpServers: { argent: { ...argent, disabled: true } },
    });
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.find((c) => c.label.startsWith("Cursor"))?.label).toMatch(/switched off/);
  });

  it("warns that Gemini reads a project entry only when started from the project", () => {
    writeJson(path.join(projectRoot, ".gemini", "settings.json"), { mcpServers: { argent } });
    const sub = path.join(projectRoot, "sub");
    fs.mkdirSync(sub);
    const checks = editorsSection({ ...doctorCtx(), cwd: sub }).checks;
    expect(checks.some((c) => /only when started from it/.test(c.label))).toBe(true);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports a config file it can't read instead of calling argent unconfigured",
    () => {
      const file = path.join(home, ".claude.json");
      writeJson(file, { mcpServers: { argent } });
      fs.chmodSync(file, 0o000);
      try {
        const checks = editorsSection(doctorCtx()).checks;
        expect(checks.find((c) => c.status === "error")?.label).toMatch(/can't read/);
        expect(checks.some((c) => /not configured/.test(c.label))).toBe(false);
      } finally {
        fs.chmodSync(file, 0o644);
      }
    }
  );

  it("says a local install can't add argent to a global-only editor", () => {
    fs.mkdirSync(path.join(home, ".codeium", "windsurf", "memories"), { recursive: true });
    const checks = editorsSection({ ...doctorCtx(), mode: "local" }).checks;
    expect(checks.find((c) => c.label.startsWith("Windsurf"))).toMatchObject({
      status: "warn",
      label: expect.stringMatching(/local install can't add it/),
    });
  });

  it("does not add a not-configured error next to an unparseable config", () => {
    fs.writeFileSync(path.join(projectRoot, ".mcp.json"), "{,}");
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.filter((c) => c.status === "error")).toHaveLength(1);
  });

  const statusOf = (checks: { label: string; status: string }[], needle: string) =>
    checks.find((c) => c.label.includes(needle))?.status;
  const gone = { command: "/opt/gone/bin/argent", args: ["mcp"] };
  const vscodeUserDir = () =>
    process.platform === "darwin"
      ? path.join(home, "Library", "Application Support", "Code", "User")
      : path.join(home, ".config", "Code", "User");

  it("reports a Codex config.toml that does not parse instead of calling argent unconfigured", () => {
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".codex", "config.toml"),
      'model = "o3"\n[mcp_servers.argent]\ncommand = "argent"\nargs = ["mcp"]\n[mcp_servers.x]\nargs = ["a"\n'
    );
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.find((c) => c.status === "error")?.label).toMatch(/Codex: .*not valid TOML/);
    expect(checks.some((c) => /not configured/.test(c.label))).toBe(false);
  });

  it("holds only Claude Code to strict JSON", () => {
    fs.mkdirSync(path.join(projectRoot, ".vscode"));
    fs.writeFileSync(
      path.join(projectRoot, ".vscode", "mcp.json"),
      '{ // argent\n "servers": { "argent": { "command": "argent", "args": ["mcp"] }, }, }'
    );
    const checks = editorsSection(doctorCtx()).checks;
    expect(statusOf(checks, "VS Code: argent mcp")).toBe("ok");
    expect(checks.some((c) => c.status === "error")).toBe(false);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports an unreadable project .mcp.json",
    () => {
      const file = path.join(projectRoot, ".mcp.json");
      writeJson(file, { mcpServers: { argent } });
      fs.chmodSync(file, 0o000);
      try {
        const checks = editorsSection(doctorCtx()).checks;
        expect(checks.find((c) => c.status === "error")?.label).toBe(
          "Claude Code: can't read its config file"
        );
      } finally {
        fs.chmodSync(file, 0o644);
      }
    }
  );

  it("prints shadowing locations under ~ with their scope", () => {
    writeJson(path.join(vscodeUserDir(), "mcp.json"), { servers: { argent } });
    const app = path.join(home, "dev", "app");
    fs.mkdirSync(app, { recursive: true });
    writeJson(path.join(home, ".claude.json"), {
      projects: { [app]: { mcpServers: { argent } } },
    });
    const ctx = { ...doctorCtx(), projectRoot: app, cwd: app, claudeKey: app };
    const details = editorsSection(ctx).checks.map((c) => c.detail ?? "");
    expect(details.some((d) => d.startsWith("~/") && d.includes("mcp.json (global)"))).toBe(true);
    expect(details).toContain("~/.claude.json (local-scope entry for ~/dev/app)");
    expect(details.some((d) => d.includes(home))).toBe(false);
  });

  it("warns about Gemini's start folder only for a project entry, run from a subfolder", () => {
    const sub = path.join(projectRoot, "sub");
    fs.mkdirSync(sub);
    const warning = (ctx: DoctorContext) =>
      editorsSection(ctx).checks.find((c) => /only when started from it/.test(c.label));
    writeJson(path.join(home, ".gemini", "settings.json"), { mcpServers: { argent } });
    expect(warning({ ...doctorCtx(), cwd: sub })).toBeUndefined();
    writeJson(path.join(projectRoot, ".gemini", "settings.json"), { mcpServers: { argent } });
    expect(warning(doctorCtx())).toBeUndefined();
    expect(warning({ ...doctorCtx(), cwd: sub })?.fix).toBe(
      `Start Gemini from ${projectRoot.replace(home, "~")}`
    );
  });

  it("starts only Gemini's project entry when both scopes define one", () => {
    writeJson(path.join(home, ".gemini", "settings.json"), { mcpServers: { argent: gone } });
    writeJson(path.join(projectRoot, ".gemini", "settings.json"), { mcpServers: { argent } });
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.some((c) => c.status === "error")).toBe(false);
    expect(checks.find((c) => c.label.includes("/opt/gone"))?.label).toMatch(
      /unused: the project-scope entry wins/
    );
  });

  it("lets the project entry shadow the user one for opencode and Codex", () => {
    writeJson(path.join(home, ".config", "opencode", "opencode.json"), {
      mcp: { argent: { type: "local", command: ["/opt/gone/bin/argent", "mcp"] } },
    });
    writeJson(path.join(projectRoot, "opencode.json"), {
      mcp: { argent: { type: "local", command: ["argent", "mcp"] } },
    });
    const codexEntry = (command: string) =>
      `[mcp_servers.argent]\ncommand = "${command}"\nargs = ["mcp"]\n`;
    fs.mkdirSync(path.join(home, ".codex"));
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), codexEntry("/opt/gone/bin/argent"));
    fs.mkdirSync(path.join(projectRoot, ".codex"));
    fs.writeFileSync(path.join(projectRoot, ".codex", "config.toml"), codexEntry("argent"));
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.some((c) => c.status === "error")).toBe(false);
    const unused = checks.filter((c) => c.label.includes("/opt/gone")).map((c) => c.label);
    expect(unused).toEqual([
      "Codex: /opt/gone/bin/argent mcp (unused: the project-scope entry wins)",
      "opencode: /opt/gone/bin/argent mcp (unused: the project-scope entry wins)",
    ]);
  });

  it("lets a package's own Codex config shadow the one at the git root", () => {
    const pkg = path.join(projectRoot, "packages", "app");
    const codexEntry = (command: string) =>
      `[mcp_servers.argent]\ncommand = "${command}"\nargs = ["mcp"]\n`;
    fs.mkdirSync(path.join(projectRoot, ".codex"));
    fs.writeFileSync(
      path.join(projectRoot, ".codex", "config.toml"),
      codexEntry("/opt/gone/argent")
    );
    fs.mkdirSync(path.join(pkg, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(pkg, ".codex", "config.toml"), codexEntry("argent"));
    const ctx = { ...doctorCtx(), projectRoot: pkg, cwd: pkg, gitRoot: projectRoot };
    const checks = editorsSection(ctx).checks;
    expect(checks.some((c) => c.status === "error")).toBe(false);
    expect(checks.find((c) => c.label.includes("/opt/gone"))?.label).toBe(
      "Codex: /opt/gone/argent mcp (unused: the closer project config entry wins)"
    );
  });

  it("looks for a .mcp.json rejection only next to a project entry", () => {
    writeJson(path.join(home, ".claude.json"), { mcpServers: { argent } });
    writeJson(path.join(projectRoot, ".claude", "settings.local.json"), {
      disabledMcpjsonServers: ["argent"],
    });
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.some((c) => /disabledMcpjsonServers/.test(c.label))).toBe(false);
  });

  it("notes a VS Code user-profile entry only beside a workspace entry", () => {
    writeJson(path.join(vscodeUserDir(), "mcp.json"), { servers: { argent } });
    const note = () =>
      editorsSection(doctorCtx()).checks.find((c) => /can take precedence/.test(c.label));
    expect(note()).toBeUndefined();
    writeJson(path.join(projectRoot, ".vscode", "mcp.json"), { servers: { argent } });
    expect(note()?.status).toBe("warn");
  });

  it("calls a .mcp.json entry under a stock local-scope one unused, without a warning", () => {
    writeJson(path.join(projectRoot, ".mcp.json"), { mcpServers: { argent } });
    localScope({ argent });
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.some((c) => c.status === "warn")).toBe(false);
    expect(checks.find((c) => c.label.includes("unused"))?.status).toBe("info");
  });

  it("does not let an entry Claude Code skips as invalid outrank the one it runs", () => {
    writeJson(path.join(projectRoot, ".mcp.json"), { mcpServers: { argent: gone } });
    localScope({ argent: "x" });
    const checks = editorsSection(doctorCtx()).checks;
    expect(statusOf(checks, "/opt/gone/bin/argent")).toBe("error");
    expect(checks.some((c) => c.label.includes("unused"))).toBe(false);
  });

  it("ranks Claude Code's scopes: project over user, local over user", () => {
    writeJson(path.join(projectRoot, ".mcp.json"), { mcpServers: { argent: gone } });
    writeJson(path.join(home, ".claude.json"), { mcpServers: { argent } });
    expect(statusOf(editorsSection(doctorCtx()).checks, "/opt/gone")).toBe("error");

    fs.rmSync(path.join(projectRoot, ".mcp.json"));
    writeJson(path.join(home, ".claude.json"), {
      mcpServers: { argent: gone },
      projects: { [projectRoot]: { mcpServers: { argent } } },
    });
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.find((c) => c.label.includes("/opt/gone"))?.label).toMatch(
      /unused: the local-scope entry wins/
    );
    expect(checks.some((c) => c.status === "error")).toBe(false);
  });

  it("judges a broken local-scope entry beside a rejected .mcp.json, with Claude's own fix", () => {
    writeJson(path.join(projectRoot, ".mcp.json"), { mcpServers: { argent } });
    writeJson(path.join(projectRoot, ".claude", "settings.local.json"), {
      disabledMcpjsonServers: ["argent"],
    });
    localScope({ argent: gone });
    const broken = editorsSection(doctorCtx()).checks.find((c) => c.label.includes("/opt/gone"));
    expect(broken).toMatchObject({
      status: "error",
      fix: expect.stringMatching(/claude mcp remove -s local argent/),
    });
  });

  it("does not fail a rejected .mcp.json entry beside a healthy user entry", () => {
    writeJson(path.join(projectRoot, ".mcp.json"), { mcpServers: { argent: gone } });
    writeJson(path.join(projectRoot, ".claude", "settings.local.json"), {
      disabledMcpjsonServers: ["argent"],
    });
    writeJson(path.join(home, ".claude.json"), { mcpServers: { argent } });
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.some((c) => c.status === "error")).toBe(false);
    expect(statusOf(checks, "(not loaded: rejected")).toBe("info");
    expect(statusOf(checks, "Claude Code: argent mcp")).toBe("ok");
  });

  it("runs a Cursor project entry from the project root, wherever doctor runs", () => {
    fs.mkdirSync(path.join(projectRoot, "node_modules", ".bin"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "node_modules", ".bin", "argent"), "");
    writeJson(path.join(projectRoot, ".cursor", "mcp.json"), {
      mcpServers: { argent: { command: "./node_modules/.bin/argent", args: ["mcp"] } },
    });
    const sub = path.join(projectRoot, "sub");
    fs.mkdirSync(sub);
    expect(statusOf(editorsSection({ ...doctorCtx(), cwd: sub }).checks, "Cursor")).toBe("ok");
  });

  it("finds the .mcp.json Claude Code reads above the folder it starts in, the closest winning", () => {
    const src = path.join(projectRoot, "proj", "src");
    fs.mkdirSync(src, { recursive: true });
    writeJson(path.join(projectRoot, ".mcp.json"), { mcpServers: { argent: gone } });
    const ctx = { ...doctorCtx(), projectRoot: path.join(projectRoot, "proj"), cwd: src };
    expect(statusOf(editorsSection(ctx).checks, "/opt/gone")).toBe("error");

    writeJson(path.join(projectRoot, "proj", ".mcp.json"), { mcpServers: { argent } });
    const checks = editorsSection(ctx).checks;
    expect(checks.find((c) => c.label.includes("/opt/gone"))?.label).toMatch(
      /unused: the closer \.mcp\.json entry wins/
    );
    expect(checks.some((c) => c.status === "error")).toBe(false);
  });

  it("reads a linked worktree's own .mcp.json, not the main checkout's", () => {
    const main = path.join(projectRoot, "repo");
    const wt = path.join(projectRoot, "wt2");
    writeJson(path.join(main, ".mcp.json"), { mcpServers: { argent: gone } });
    writeJson(path.join(wt, ".mcp.json"), { mcpServers: { argent } });
    const ctx = { ...doctorCtx(), projectRoot: wt, cwd: wt, claudeRoot: wt, claudeKey: main };
    const checks = editorsSection(ctx).checks;
    expect(checks.some((c) => c.label.includes("/opt/gone"))).toBe(false);
    expect(statusOf(checks, "Claude Code: argent mcp")).toBe("ok");
  });

  it("reads Claude Code's /mcp toggle under its project key", () => {
    const repo = path.join(projectRoot, "repo");
    writeJson(path.join(home, ".claude.json"), {
      projects: { [repo]: { mcpServers: { argent }, disabledMcpServers: ["argent"] } },
    });
    const ctx = { ...doctorCtx(), projectRoot: path.join(repo, "app"), claudeKey: repo };
    expect(statusOf(editorsSection(ctx).checks, "switched off for this project")).toBe("warn");
  });

  it("probes the remote an entry links to with the values its server would see", () => {
    vi.stubEnv("ARGENT_TEST_REMOTE", "http://127.0.0.1:9");
    vi.stubEnv("ARGENT_AUTH_TOKEN", "good");
    writeJson(path.join(projectRoot, ".mcp.json"), {
      mcpServers: { argent: { ...argent, env: { ARGENT_TOOLS_URL: "${ARGENT_TEST_REMOTE}" } } },
    });
    const urls: EntryToolsUrl[] = [];
    editorsSection(doctorCtx(), urls);
    expect(urls).toEqual([{ editor: "Claude Code", url: "http://127.0.0.1:9", token: "good" }]);
  });

  it("marks a remote whose variable this shell can't fill in, and does not count it as remote", () => {
    vi.stubEnv("ARGENT_TOOLS_URL", undefined);
    vi.stubEnv("ARGENT_AUTH_TOKEN", undefined);
    const entry = { ...argent, env: { ARGENT_TOOLS_URL: "${ARGENT_TOOLS_URL}" } };
    writeJson(path.join(projectRoot, ".mcp.json"), { mcpServers: { argent: entry } });
    const urls: EntryToolsUrl[] = [];
    editorsSection(doctorCtx(), urls);
    expect(urls).toEqual([
      {
        editor: "Claude Code",
        url: "${ARGENT_TOOLS_URL}",
        token: undefined,
        unresolved: "ARGENT_TOOLS_URL",
      },
    ]);
    expect(linksToRemote(entry)).toBe(false);
    expect(linksToRemote({ ...argent, env: { ARGENT_TOOLS_URL: "http://h:1" } })).toBe(true);
  });

  it("does not probe the remote of a switched-off entry", () => {
    writeJson(path.join(projectRoot, ".cursor", "mcp.json"), {
      mcpServers: {
        argent: { ...argent, disabled: true, env: { ARGENT_TOOLS_URL: "http://127.0.0.1:9" } },
      },
    });
    const urls: EntryToolsUrl[] = [];
    editorsSection(doctorCtx(), urls);
    expect(urls).toEqual([]);
  });

  it("does not print an empty editor list", () => {
    for (const mode of ["local", "global"] as const) {
      const labels = editorsSection({ ...doctorCtx(), mode }).checks.map((c) => c.label);
      expect(labels.some((l) => /^: no argent|Detected without argent: $/.test(l))).toBe(false);
    }
  });

  it("names each editor's own switch-off key", () => {
    writeJson(path.join(projectRoot, ".zed", "settings.json"), {
      context_servers: { argent: { source: "custom", enabled: false, ...argent } },
    });
    writeJson(path.join(projectRoot, ".cursor", "mcp.json"), {
      mcpServers: { argent: { ...argent, disabled: true } },
    });
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.find((c) => c.label.startsWith("Zed"))?.detail).toMatch(/`enabled: false`/);
    expect(checks.find((c) => c.label.startsWith("Cursor"))?.detail).toMatch(/`disabled: true`/);
  });

  it("labels ~/.cursor as global when doctor runs from ~", () => {
    writeJson(path.join(home, ".cursor", "mcp.json"), { mcpServers: { argent } });
    const checks = editorsSection({ ...doctorCtx(), projectRoot: home, cwd: home }).checks;
    expect(checks.find((c) => c.label.startsWith("Cursor"))?.detail).toBe(
      "~/.cursor/mcp.json (global)"
    );
  });

  it("passes the project's install facts and commands to the entry checks", () => {
    writeJson(path.join(projectRoot, ".mcp.json"), {
      mcpServers: { argent: { command: "yarn", args: ["argent", "mcp"] } },
    });
    const ctx = { ...doctorCtx(), installCmd: "pnpm install" };
    expect(editorsSection(ctx).checks.find((c) => c.label.startsWith("Claude Code"))?.fix).toBe(
      "Add @swmansion/argent to devDependencies, then pnpm install"
    );
    writeJson(path.join(projectRoot, ".mcp.json"), {
      mcpServers: { argent: { command: "argent", args: [] } },
    });
    const local = { ...doctorCtx(), argentCmd: "npx argent" };
    expect(editorsSection(local).checks.find((c) => c.label.startsWith("Claude Code"))?.fix).toBe(
      "npx argent init"
    );
  });

  const installSkills = (dir: string) => {
    for (const skill of listBundledSkills())
      fs.mkdirSync(path.join(dir, skill), { recursive: true });
  };

  it("warns when the subagent the rules call is missing", () => {
    writeJson(path.join(projectRoot, ".mcp.json"), { mcpServers: { argent } });
    const checks = () => skillsSection(doctorCtx(), "reinstall").checks;
    expect(checks().find((c) => c.label.startsWith("Agents missing"))?.detail).toMatch(
      /argent-environment-inspector\.md/
    );
    const agents = path.join(projectRoot, ".claude", "agents");
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(path.join(agents, "argent-environment-inspector.md"), "");
    expect(checks().some((c) => c.label.startsWith("Agents missing"))).toBe(false);
  });

  it("warns when a Codex config lacks argent's rules", () => {
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".codex", "config.toml"),
      '[mcp_servers.argent]\ncommand = "argent"\nargs = ["mcp"]\n'
    );
    const checks = skillsSection(doctorCtx(), "reinstall").checks;
    expect(checks.find((c) => /developer_instructions/.test(c.label))?.status).toBe("warn");
  });

  it("finds skills for a Claude Code local-scope entry", () => {
    localScope({ argent });
    installSkills(path.join(projectRoot, ".claude", "skills"));
    const checks = skillsSection(doctorCtx(), "reinstall").checks;
    expect(checks[0]?.status).toBe("ok");
  });

  it("does not count .agents/skills for Claude Code", () => {
    writeJson(path.join(projectRoot, ".mcp.json"), { mcpServers: { argent } });
    installSkills(path.join(projectRoot, ".agents", "skills"));
    const checks = skillsSection(doctorCtx(), "reinstall").checks;
    expect(checks[0]).toMatchObject({ status: "error", label: "No argent skills installed" });
  });

  it("counts skills linked into .agents/skills only while the links resolve", () => {
    writeJson(path.join(projectRoot, ".mcp.json"), { mcpServers: { argent } });
    const shared = path.join(projectRoot, ".agents", "skills");
    installSkills(shared);
    const claudeSkills = path.join(projectRoot, ".claude", "skills");
    fs.mkdirSync(claudeSkills, { recursive: true });
    for (const skill of listBundledSkills()) {
      fs.symlinkSync(path.join(shared, skill), path.join(claudeSkills, skill));
    }
    expect(skillsSection(doctorCtx(), "reinstall").checks[0]?.status).toBe("ok");

    fs.rmSync(path.join(projectRoot, ".agents"), { recursive: true });
    expect(skillsSection(doctorCtx(), "reinstall").checks[0]).toMatchObject({
      status: "error",
      label: "No argent skills installed",
    });
  });

  it("warns when Claude Code's /mcp toggle switched argent off for the project", () => {
    writeJson(path.join(projectRoot, ".mcp.json"), { mcpServers: { argent } });
    writeJson(path.join(home, ".claude.json"), {
      projects: { [projectRoot]: { disabledMcpServers: ["argent"] } },
    });
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.find((c) => /switched off for this project/.test(c.label))?.status).toBe("warn");
  });

  it("collects the entries the editors start", () => {
    writeJson(path.join(projectRoot, ".mcp.json"), {
      mcpServers: { argent: { ...argent, env: { ARGENT_TOOLS_URL: "http://h:1" } } },
    });
    const started: McpServerEntry[] = [];
    editorsSection(doctorCtx(), [], started);
    expect(started).toEqual([{ ...argent, env: { ARGENT_TOOLS_URL: "http://h:1" } }]);
  });

  it("accepts Claude Code rules from either scope", () => {
    writeJson(path.join(projectRoot, ".mcp.json"), { mcpServers: { argent } });
    installSkills(path.join(home, ".claude", "skills"));
    const rules = path.join(home, ".claude", "rules");
    fs.mkdirSync(rules, { recursive: true });
    for (const f of fs.readdirSync(RULES_DIR))
      fs.copyFileSync(path.join(RULES_DIR, f), path.join(rules, f));
    const agents = path.join(home, ".claude", "agents");
    fs.mkdirSync(agents, { recursive: true });
    for (const f of fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md")))
      fs.copyFileSync(path.join(AGENTS_DIR, f), path.join(agents, f));
    const checks = skillsSection(doctorCtx(), "reinstall").checks;
    expect(checks.every((c) => c.status === "ok")).toBe(true);
  });
});
