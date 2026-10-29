import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AGENTS_DIR, RULES_DIR, listBundledSkills } from "@argent/installer";
import { skillsSection } from "../src/doctor-skills.js";
import type { DoctorCheck, DoctorContext } from "../src/doctor-shared.js";

let tmp: string;
let home: string;
let projectRoot: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-doctor-skills-")));
  home = path.join(tmp, "home");
  projectRoot = path.join(home, "proj");
  fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ctx = (overrides: Partial<DoctorContext> = {}): DoctorContext => ({
  projectRoot,
  cwd: projectRoot,
  mode: "global",
  global: { bin: "/usr/local/bin/argent", root: null, version: null },
  argentCmd: "argent",
  installCmd: "npm install",
  offPathGlobalBin: null,
  ...overrides,
});
const writeFile = (file: string, text = "") => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const writeJson = (file: string, value: unknown) => writeFile(file, JSON.stringify(value));
const argent = { command: "argent", args: ["mcp"] };
const bundled = listBundledSkills();
const installSkills = (dir: string, except: string[] = []) => {
  for (const skill of bundled.filter((s) => !except.includes(s))) {
    fs.mkdirSync(path.join(dir, skill), { recursive: true });
  }
};
const copyMd = (from: string, to: string) => {
  fs.mkdirSync(to, { recursive: true });
  for (const f of fs.readdirSync(from).filter((f) => f.endsWith(".md"))) {
    fs.copyFileSync(path.join(from, f), path.join(to, f));
  }
};
const checksOf = (c: DoctorContext = ctx()) => skillsSection(c, "reinstall").checks;
const find = (checks: DoctorCheck[], re: RegExp) => checks.filter((c) => re.test(c.label));
const userScopeClaude = () =>
  writeJson(path.join(home, ".claude.json"), { mcpServers: { argent } });
const projectClaude = (root = projectRoot) =>
  writeJson(path.join(root, ".mcp.json"), { mcpServers: { argent } });

describe("skills", () => {
  it("reports no skills when no editor is configured", () => {
    expect(checksOf()[0]).toMatchObject({ status: "error", label: "No argent skills installed" });
  });

  it("names the editor and the missing skill when only one editor lacks it", () => {
    projectClaude();
    writeJson(path.join(projectRoot, ".cursor", "mcp.json"), { mcpServers: { argent } });
    installSkills(path.join(projectRoot, ".claude", "skills"));
    const [missing] = bundled;
    installSkills(path.join(projectRoot, ".cursor", "skills"), [missing!]);
    const checks = checksOf();
    expect(find(checks, /argent skills installed/)).toEqual([
      {
        status: "warn",
        label: `Cursor: ${bundled.length - 1}/${bundled.length} argent skills installed`,
        detail: `missing: ${missing}`,
        fix: "argent update",
      },
    ]);
  });

  it("names the one editor with no skills when another has them all", () => {
    projectClaude();
    writeJson(path.join(projectRoot, ".cursor", "mcp.json"), { mcpServers: { argent } });
    installSkills(path.join(projectRoot, ".claude", "skills"));
    expect(find(checksOf(), /argent skills installed/)).toEqual([
      { status: "error", label: "Cursor: No argent skills installed", fix: "argent init" },
    ]);
  });

  it("reports one unprefixed line when no editor has any skill", () => {
    projectClaude();
    writeJson(path.join(projectRoot, ".cursor", "mcp.json"), { mcpServers: { argent } });
    expect(find(checksOf(), /argent skills installed/)).toEqual([
      { status: "error", label: "No argent skills installed", fix: "argent init" },
    ]);
  });

  it("finds Codex skills in a monorepo package below the git root, as Codex does", () => {
    const app = path.join(projectRoot, "packages", "app");
    writeFile(
      path.join(projectRoot, ".codex", "config.toml"),
      '[mcp_servers.argent]\ncommand = "argent"\nargs = ["mcp"]\n'
    );
    installSkills(path.join(app, ".agents", "skills"));
    const checks = checksOf(ctx({ projectRoot: app, cwd: app, gitRoot: projectRoot }));
    expect(find(checks, /argent skills installed/)[0]?.status).toBe("ok");
  });

  it("expects the skills of a local-mode project's own argent", () => {
    const pkg = path.join(projectRoot, "node_modules", "@swmansion", "argent");
    writeJson(path.join(pkg, "package.json"), { name: "@swmansion/argent", version: "0.29.0" });
    for (const name of ["argent-create-flow", "argent-qa-flows"]) {
      writeFile(path.join(pkg, "skills", name, "SKILL.md"));
    }
    writeJson(path.join(projectRoot, "package.json"), {
      devDependencies: { "@swmansion/argent": "0.29.0" },
    });
    projectClaude();
    installSkills(path.join(projectRoot, ".claude", "skills"));
    fs.mkdirSync(path.join(projectRoot, ".claude", "skills", "argent-create-flow"));
    fs.mkdirSync(path.join(projectRoot, ".claude", "skills", "argent-qa-flows"));
    expect(find(checksOf(ctx({ mode: "local" })), /argent skills installed/)).toEqual([
      { status: "ok", label: "2/2 argent skills installed" },
    ]);
  });

  it("reports editors that share a skills dir on one line", () => {
    writeJson(path.join(projectRoot, ".gemini", "settings.json"), { mcpServers: { argent } });
    writeFile(
      path.join(projectRoot, ".codex", "config.toml"),
      '[mcp_servers.argent]\ncommand = "argent"\nargs = ["mcp"]\n'
    );
    const [missing] = bundled;
    installSkills(path.join(projectRoot, ".agents", "skills"), [missing!]);
    const lines = find(checksOf(), /argent skills installed/);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ status: "warn", detail: `missing: ${missing}` });
  });

  it("finds skills in an ancestor of cwd, as Claude Code does", () => {
    const deep = path.join(projectRoot, "src", "deep");
    fs.mkdirSync(deep, { recursive: true });
    userScopeClaude();
    installSkills(path.join(projectRoot, ".claude", "skills"));
    copyMd(RULES_DIR, path.join(projectRoot, ".claude", "rules"));
    const checks = checksOf(ctx({ projectRoot: deep, cwd: deep }));
    expect(checks[0]?.label).toBe(`${bundled.length}/${bundled.length} argent skills installed`);
    expect(find(checks, /Rules missing/)).toEqual([]);
  });

  it("finds skills in a monorepo package that has its own .claude", () => {
    const app = path.join(projectRoot, "packages", "app");
    projectClaude();
    installSkills(path.join(app, ".claude", "skills"));
    const checks = checksOf(ctx({ projectRoot: app, cwd: app, claudeRoot: projectRoot }));
    expect(checks[0]?.status).toBe("ok");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "still finds skills when an editor config can't be read",
    () => {
      userScopeClaude();
      installSkills(path.join(home, ".claude", "skills"));
      fs.chmodSync(path.join(home, ".claude.json"), 0o000);
      try {
        expect(checksOf()[0]?.status).toBe("ok");
      } finally {
        fs.chmodSync(path.join(home, ".claude.json"), 0o644);
      }
    }
  );
});

describe("rules and agents", () => {
  it("reports missing rules for a plain .mcp.json project, with argent update as the fix", () => {
    projectClaude();
    writeFile(path.join(projectRoot, ".claude", "rules", "mine.md"));
    expect(find(checksOf(), /^Rules/)).toEqual([
      expect.objectContaining({
        status: "warn",
        label: "Rules missing in ~/proj/.claude/rules",
        fix: "argent update",
      }),
    ]);
  });

  it("accepts complete project rules for a user-scope Claude Code entry", () => {
    userScopeClaude();
    copyMd(RULES_DIR, path.join(projectRoot, ".claude", "rules"));
    expect(find(checksOf(), /^Rules/)).toEqual([
      expect.objectContaining({ status: "ok", label: "Rules present in ~/proj/.claude/rules" }),
    ]);
  });

  it("names the user-scope agents dir and argent update for a user-scope entry", () => {
    userScopeClaude();
    expect(find(checksOf(), /^Agents missing/)).toEqual([
      expect.objectContaining({
        status: "warn",
        label: "Agents missing in ~/.claude/agents",
        fix: "argent update",
      }),
    ]);
  });

  it("gives a copy command for a local-scope entry, which argent update does not refresh", () => {
    writeJson(path.join(home, ".claude.json"), {
      projects: { [projectRoot]: { mcpServers: { argent } } },
    });
    const checks = checksOf();
    expect(find(checks, /^Rules missing/)[0]?.fix).toMatch(
      /^mkdir -p ~\/proj\/\.claude\/rules && cp /
    );
    expect(find(checks, /^Agents missing/)[0]?.fix).toMatch(
      /^mkdir -p ~\/proj\/\.claude\/agents && cp /
    );
  });

  it("quotes a path with a space in the copy command", () => {
    const spaced = path.join(home, "my proj");
    fs.mkdirSync(path.join(spaced, ".git"), { recursive: true });
    writeJson(path.join(home, ".claude.json"), {
      projects: { [spaced]: { mcpServers: { argent } } },
    });
    const fix = find(checksOf(ctx({ projectRoot: spaced, cwd: spaced })), /^Rules missing/)[0]?.fix;
    expect(fix).toBe(
      `mkdir -p '${spaced}/.claude/rules' && cp ${RULES_DIR.replace(home, "~")}/*.md '${spaced}/.claude/rules'/`
    );
  });

  it("reads Codex rules from the package config that holds the entry", () => {
    const app = path.join(projectRoot, "packages", "app");
    writeFile(
      path.join(app, ".codex", "config.toml"),
      'developer_instructions = """\n# --- argent rules (managed by argent init — do not edit) ---\nrules\n"""\n\n' +
        '[mcp_servers.argent]\ncommand = "argent"\nargs = ["mcp"]\n'
    );
    const checks = checksOf(ctx({ projectRoot: app, cwd: app, gitRoot: projectRoot }));
    expect(find(checks, /developer_instructions/)).toEqual([
      {
        status: "ok",
        label: "Rules present in ~/proj/packages/app/.codex/config.toml (developer_instructions)",
      },
    ]);
  });

  it("points argent update at the git root for Codex rules missing there", () => {
    const pkg = path.join(projectRoot, "pkg");
    writeFile(
      path.join(projectRoot, ".codex", "config.toml"),
      '[mcp_servers.argent]\ncommand = "argent"\nargs = ["mcp"]\n'
    );
    projectClaude(pkg);
    writeJson(path.join(pkg, "package.json"), {});
    const checks = checksOf(
      ctx({ projectRoot: pkg, cwd: pkg, gitRoot: projectRoot, claudeRoot: projectRoot })
    );
    expect(find(checks, /developer_instructions/)[0]).toMatchObject({
      status: "warn",
      fix: "argent update --project-root ~/proj",
    });
  });

  it("points argent update at the monorepo root that holds the entry", () => {
    const app = path.join(projectRoot, "packages", "app");
    fs.mkdirSync(path.join(app, ".vscode"), { recursive: true });
    projectClaude();
    const checks = checksOf(ctx({ projectRoot: app, cwd: app, claudeRoot: projectRoot }));
    expect(find(checks, /^Rules missing/)[0]).toMatchObject({
      label: "Rules missing in ~/proj/.claude/rules",
      fix: "argent update --project-root ~/proj",
    });
  });

  it("passes a Codex config that carries argent's rules", () => {
    writeFile(
      path.join(home, ".codex", "config.toml"),
      'developer_instructions = """\n# --- argent rules (managed by argent init — do not edit) ---\nrules\n"""\n\n' +
        '[mcp_servers.argent]\ncommand = "argent"\nargs = ["mcp"]\n'
    );
    expect(find(checksOf(), /developer_instructions/)).toEqual([
      { status: "ok", label: "Rules present in ~/.codex/config.toml (developer_instructions)" },
    ]);
  });

  it("passes complete agents", () => {
    projectClaude();
    copyMd(AGENTS_DIR, path.join(projectRoot, ".claude", "agents"));
    expect(find(checksOf(), /^Agents/)).toEqual([]);
  });
});
