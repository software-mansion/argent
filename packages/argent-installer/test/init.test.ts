import { describe, it, expect } from "vitest";
import * as path from "node:path";
import {
  SKILLS_DIR,
  RULES_DIR,
  AGENTS_DIR,
  ARGENT_SKILLS_REPO,
  buildArgentSkillsSource,
} from "../src/utils.js";

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

describe("buildArgentSkillsSource", () => {
  it("returns the github shorthand pinned to v<version> for a clean semver", () => {
    expect(buildArgentSkillsSource("0.7.1")).toBe(`${ARGENT_SKILLS_REPO}#v0.7.1`);
  });

  it("preserves pre-release identifiers in the pinned tag", () => {
    expect(buildArgentSkillsSource("0.6.0-next.0")).toBe(`${ARGENT_SKILLS_REPO}#v0.6.0-next.0`);
  });

  it("falls back to SKILLS_DIR when the version is unknown", () => {
    expect(buildArgentSkillsSource("unknown")).toBe(SKILLS_DIR);
  });

  it("falls back to SKILLS_DIR when no version is supplied", () => {
    expect(buildArgentSkillsSource(null)).toBe(SKILLS_DIR);
    expect(buildArgentSkillsSource(undefined)).toBe(SKILLS_DIR);
    expect(buildArgentSkillsSource("")).toBe(SKILLS_DIR);
  });
});

// Mirrors the args construction in init.ts Step 2. Kept as a regression check
// against accidental flag reorders that would change `skills add` semantics
// (e.g. dropping `-y` flipping into an interactive prompt during CI).
describe("init — skills command construction", () => {
  function buildArgs(
    skillsSource: string,
    scope: "local" | "global",
    method: "default" | "interactive"
  ): string[] {
    const args = ["skills", "add", skillsSource];
    if (scope === "global") args.push("-g");
    if (method === "default") args.push("--skill", "*", "-y");
    return args;
  }

  it("default method builds correct args with global scope", () => {
    const source = buildArgentSkillsSource("0.7.1");
    const args = buildArgs(source, "global", "default");

    expect(args[2]).toBe(source);
    expect(args).toContain("-g");
    expect(args).toContain("--skill");
    expect(args).toContain("*");
    expect(args).toContain("-y");
  });

  it("default method omits -g for local scope", () => {
    const args = buildArgs(buildArgentSkillsSource("0.7.1"), "local", "default");

    expect(args).not.toContain("-g");
    expect(args).toContain("-y");
  });

  it("interactive method passes no extra flags", () => {
    const args = buildArgs(buildArgentSkillsSource("0.7.1"), "local", "interactive");

    expect(args).toHaveLength(3);
    expect(args).not.toContain("-y");
    expect(args).not.toContain("-g");
  });

  it("falls back to SKILLS_DIR when the version is unknown (e.g. dev tarball)", () => {
    const args = buildArgs(buildArgentSkillsSource("unknown"), "local", "default");

    expect(args[2]).toBe(SKILLS_DIR);
  });
});
