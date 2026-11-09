import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// packages/skills/scripts/install.js, run as `npm run install-skills`.
const SKILLS_PKG = path.resolve(__dirname, "..", "..", "skills");
const SCRIPT = path.join(SKILLS_PKG, "scripts", "install.js");
const BUNDLED_SKILLS = path.join(SKILLS_PKG, "skills");

let project: string;

beforeEach(() => {
  project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-install-skills-")));
  execFileSync("git", ["init", "-q"], { cwd: project });
});

afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true });
});

describe("install-skills script", () => {
  it("writes through a .claude/skills symlink into the canonical dir", () => {
    const canonical = path.join(project, ".agents", "skills");
    fs.mkdirSync(canonical, { recursive: true });
    fs.mkdirSync(path.join(project, ".claude"));
    fs.symlinkSync(path.join("..", ".agents", "skills"), path.join(project, ".claude", "skills"));

    execFileSync(process.execPath, [SCRIPT], { cwd: project, stdio: "pipe" });

    expect(fs.lstatSync(path.join(project, ".claude", "skills")).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(canonical).sort()).toEqual(fs.readdirSync(BUNDLED_SKILLS).sort());
  });

  it("writes through per-skill and per-file links into their canonical targets", () => {
    const [dirSkill, fileSkill] = fs.readdirSync(BUNDLED_SKILLS).sort();
    const canonical = path.join(project, ".agents", "skills");
    fs.mkdirSync(path.join(canonical, dirSkill), { recursive: true });
    fs.writeFileSync(path.join(canonical, dirSkill, "SKILL.md"), "stale");
    fs.writeFileSync(path.join(canonical, "canonical.md"), "stale");
    const skills = path.join(project, ".claude", "skills");
    fs.mkdirSync(path.join(skills, fileSkill), { recursive: true });
    fs.symlinkSync(
      path.join("..", "..", ".agents", "skills", dirSkill),
      path.join(skills, dirSkill)
    );
    fs.symlinkSync(
      path.join("..", "..", "..", ".agents", "skills", "canonical.md"),
      path.join(skills, fileSkill, "SKILL.md")
    );

    execFileSync(process.execPath, [SCRIPT], { cwd: project, stdio: "pipe" });

    expect(fs.lstatSync(path.join(skills, dirSkill)).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(skills, fileSkill, "SKILL.md")).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(canonical, dirSkill, "SKILL.md"), "utf8")).toBe(
      fs.readFileSync(path.join(BUNDLED_SKILLS, dirSkill, "SKILL.md"), "utf8")
    );
    expect(fs.readFileSync(path.join(canonical, "canonical.md"), "utf8")).toBe(
      fs.readFileSync(path.join(BUNDLED_SKILLS, fileSkill, "SKILL.md"), "utf8")
    );
  });

  it("creates the missing target of a dangling .claude/skills link", () => {
    // `.claude` is a link too, so the relative target resolves against the real dir.
    fs.mkdirSync(path.join(project, ".agents"));
    fs.mkdirSync(path.join(project, "config", "claude"), { recursive: true });
    fs.symlinkSync(path.join("config", "claude"), path.join(project, ".claude"));
    fs.symlinkSync(
      path.join("..", "..", ".agents", "skills"),
      path.join(project, "config", "claude", "skills")
    );
    // A chain: `.agents/skills` is a dangling link too.
    fs.mkdirSync(path.join(project, "store"));
    fs.symlinkSync(path.join("..", "store", "skills"), path.join(project, ".agents", "skills"));

    execFileSync(process.execPath, [SCRIPT], { cwd: project, stdio: "pipe" });

    expect(fs.lstatSync(path.join(project, ".claude", "skills")).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(path.join(project, "store", "skills")).sort()).toEqual(
      fs.readdirSync(BUNDLED_SKILLS).sort()
    );
  });

  // A fresh clone runs it before any build, so it must not import a workspace package.
  it("runs from a copy outside the workspace, writing through linked skills and agents dirs", () => {
    const pkg = path.join(project, "pkg");
    for (const entry of ["package.json", "scripts", "skills"]) {
      fs.cpSync(path.join(SKILLS_PKG, entry), path.join(pkg, entry), { recursive: true });
    }
    fs.mkdirSync(path.join(pkg, "agents"));
    fs.writeFileSync(path.join(pkg, "agents", "inspector.md"), "agent");
    fs.mkdirSync(path.join(project, ".claude"));
    for (const kind of ["skills", "agents"]) {
      fs.mkdirSync(path.join(project, ".agents", kind), { recursive: true });
      fs.symlinkSync(path.join("..", ".agents", kind), path.join(project, ".claude", kind));
    }

    execFileSync(process.execPath, [path.join(pkg, "scripts", "install.js")], {
      cwd: project,
      stdio: "pipe",
    });

    expect(fs.readdirSync(path.join(project, ".agents", "skills")).sort()).toEqual(
      fs.readdirSync(BUNDLED_SKILLS).sort()
    );
    expect(fs.readdirSync(path.join(project, ".agents", "agents"))).toEqual(["inspector.md"]);
  });
});
