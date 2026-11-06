import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// packages/skills/scripts/install.js, run as `npm run install-skills`. It loads
// @argent/installer from its build output.
const SCRIPT = path.resolve(__dirname, "..", "..", "skills", "scripts", "install.js");
const BUNDLED_SKILLS = path.resolve(__dirname, "..", "..", "skills", "skills");

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
});
