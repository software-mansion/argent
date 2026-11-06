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
