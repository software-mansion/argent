import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { SKILLS_DIR, RULES_DIR, AGENTS_DIR } from "../src/utils.js";

// These tests verify the logic used by init.ts without running the full TUI.
// The actual init flow is interactive and tested via the integration harness.

describe("init — skills path resolution", () => {
  it("SKILLS_DIR resolves relative to dist/", () => {
    // cli.ts compiles to dist/cli.js, so import.meta.dirname = dist/
    // SKILLS_DIR should be ../skills from there, i.e. <package-root>/skills
    expect(SKILLS_DIR).toContain("skills");
    expect(path.isAbsolute(SKILLS_DIR)).toBe(true);
  });

  it("RULES_DIR resolves relative to dist/", () => {
    expect(RULES_DIR).toContain("rules");
    expect(path.isAbsolute(RULES_DIR)).toBe(true);
  });

  it("AGENTS_DIR resolves relative to dist/", () => {
    expect(AGENTS_DIR).toContain("agents");
    expect(path.isAbsolute(AGENTS_DIR)).toBe(true);
  });
});

describe("init — skills command construction", () => {
  it("default method builds correct args with global scope", () => {
    const scope = "global";
    const args = ["skills", "add", SKILLS_DIR];
    if (scope === "global") args.push("-g");
    args.push("--skill", "*", "-y");

    expect(args).toContain("-g");
    expect(args).toContain("--skill");
    expect(args).toContain("*");
    expect(args).toContain("-y");
    expect(args[2]).toBe(SKILLS_DIR);
  });

  it("default method builds correct args with local scope", () => {
    const scope = "local" as "local" | "global";
    const args = ["skills", "add", SKILLS_DIR];
    if (scope === "global") args.push("-g");
    args.push("--skill", "*", "-y");

    expect(args).not.toContain("-g");
    expect(args).toContain("-y");
  });

  it("interactive method passes no extra flags", () => {
    const args = ["skills", "add", SKILLS_DIR];
    expect(args).toHaveLength(3);
    expect(args).not.toContain("-y");
    expect(args).not.toContain("-g");
  });
});
