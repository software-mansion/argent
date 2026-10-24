import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { AGENTS_DIR, listBundledSkills, RULES_DIR } from "@argent/installer";
import { claudeProjectKey, editorsSection, isStrictJson } from "../src/doctor-editors.js";
import { type DoctorContext } from "../src/doctor-shared.js";
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
});

describe("isStrictJson", () => {
  it("rejects what Claude Code can't parse, but allows a BOM", () => {
    const file = path.join(projectRoot, "x.json");
    for (const [text, ok] of [
      ['{"a":1}', true],
      ['﻿{"a":1}', true],
      ['{"a":1,}', false],
      ['{"a":1 // c\n}', false],
    ] as const) {
      fs.writeFileSync(file, text);
      expect(isStrictJson(file)).toBe(ok);
    }
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

  it("flags a .mcp.json Claude Code cannot parse", () => {
    fs.writeFileSync(
      path.join(projectRoot, ".mcp.json"),
      '{"mcpServers":{"argent":{"command":"argent","args":["mcp"]}},}'
    );
    const checks = editorsSection(doctorCtx()).checks;
    expect(checks.find((c) => c.status === "error")?.label).toMatch(/not valid JSON/);
    expect(checks.some((c) => c.label === "Claude Code: argent mcp")).toBe(false);
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
      claudeRoot: repo,
    };
    expect(
      editorsSection(inPackage).checks.find((c) => c.label.startsWith("Claude Code"))?.status
    ).toBe("ok");
    const alias = { ...inPackage, claudeRoot: `${repo}/` };
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
