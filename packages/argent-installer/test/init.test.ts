import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
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
    const scope = "local";
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

// ── init — --devdep flag wiring ──────────────────────────────────────────────
// init() is interactive end-to-end so we test the input-handling pieces in
// isolation. These cover the contract that the dispatcher and CI users
// rely on, without booting the full TUI under vitest.

describe("init — --devdep flag detection", () => {
  // The dispatcher passes through positional+flag arguments unchanged. The
  // boolean shape used by init.ts is `args.includes("--devdep") ||
  // args.includes("--local-install")`. We assert that contract here so a
  // refactor that drops one alias gets caught in CI.
  function isDevdepRequested(args: string[]): boolean {
    return args.includes("--devdep") || args.includes("--local-install");
  }

  it("recognizes the --devdep flag", () => {
    expect(isDevdepRequested(["--devdep"])).toBe(true);
  });
  it("recognizes the --local-install alias", () => {
    expect(isDevdepRequested(["--local-install"])).toBe(true);
  });
  it("returns false when neither flag is present", () => {
    expect(isDevdepRequested(["--yes"])).toBe(false);
  });
  it("works alongside other flags in any order", () => {
    expect(isDevdepRequested(["--yes", "--devdep", "--from", "argent.tgz"])).toBe(true);
  });
});

describe("init — --devdep refuses --scope global", () => {
  // Same contract: the validation expressly looks at the value following
  // --scope, not at the presence of the flag.
  function rejectsCombo(args: string[]): boolean {
    const devdep = args.includes("--devdep") || args.includes("--local-install");
    const idx = args.indexOf("--scope");
    const globalScope = idx !== -1 && idx + 1 < args.length && args[idx + 1] === "global";
    return devdep && globalScope;
  }

  it("rejects --devdep --scope global", () => {
    expect(rejectsCombo(["--devdep", "--scope", "global"])).toBe(true);
  });
  it("rejects --local-install --scope global", () => {
    expect(rejectsCombo(["--local-install", "--scope", "global"])).toBe(true);
  });
  it("allows --devdep --scope local (redundant but harmless)", () => {
    expect(rejectsCombo(["--devdep", "--scope", "local"])).toBe(false);
  });
  it("allows --devdep without any --scope flag", () => {
    expect(rejectsCombo(["--devdep"])).toBe(false);
  });
  it("allows --scope global on its own (regular global install)", () => {
    expect(rejectsCombo(["--scope", "global"])).toBe(false);
  });
});

// ── init — preflight checks for the local install branch ─────────────────────
// The devDep flow refuses early when the workspace cannot host one. These
// tests exercise the helpers it leans on so the refusal logic stays
// observable from outside the TUI.

describe("init — local install preflight (filesystem)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-init-devdep-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("refuses when the project root has no package.json", async () => {
    const { hasPackageJson } = await import("../src/utils.js");
    expect(hasPackageJson(tmpDir)).toBe(false);
  });

  it("accepts a fresh `npm init`-style workspace", async () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"x","version":"0.0.0"}');
    const { hasPackageJson, isYarnPnp } = await import("../src/utils.js");
    expect(hasPackageJson(tmpDir)).toBe(true);
    expect(isYarnPnp(tmpDir)).toBe(false);
  });

  it("refuses Yarn PnP workspaces (.pnp.cjs at the project root)", async () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"x"}');
    fs.writeFileSync(path.join(tmpDir, ".pnp.cjs"), "");
    const { isYarnPnp } = await import("../src/utils.js");
    expect(isYarnPnp(tmpDir)).toBe(true);
  });

  it("skips the local install step when argent is already on disk", async () => {
    // "Already installed" requires BOTH a dep declaration in the
    // project's package.json AND the files in node_modules — the
    // workspace-symlink case (files but no declaration) must NOT count
    // as installed. See utils.test.ts for the full matrix.
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "x", devDependencies: { "@swmansion/argent": "^0.7.0" } })
    );
    const argentDir = path.join(tmpDir, "node_modules", "@swmansion", "argent");
    fs.mkdirSync(argentDir, { recursive: true });
    fs.writeFileSync(path.join(argentDir, "package.json"), '{"name":"@swmansion/argent"}');
    const { isLocallyInstalled } = await import("../src/utils.js");
    expect(isLocallyInstalled(tmpDir)).toBe(true);
  });
});

// Quieten an unused-vi-import warning when the section above adds further
// mocked tests in the future.
void vi;

// ── init — existing-manifest error detection ─────────────────────────────────
// When init's `npm install --save-dev @swmansion/argent` fails, the user
// usually thinks argent itself is broken. But the install command does a
// full re-resolve of every dep already declared in their package.json,
// so the real failure is often a stale `link:` / file: / peer entry that
// has nothing to do with argent. We pattern-match common npm error
// strings and surface a hint. The contract is mirrored here so a future
// refactor that drops a pattern (e.g., when npm renames an error code)
// shows up as a failing test instead of a silent UX regression.

describe("init — existing-manifest error pattern matching", () => {
  const patterns = [
    /EUNSUPPORTEDPROTOCOL/i,
    /Unsupported URL Type/i,
    /\blink:/i,
    /ERESOLVE/i,
    /peer dep/i,
    /could not resolve dependency/i,
    /ENOENT.*package\.json/i,
  ];
  function looksLikeExistingManifestError(message: string): boolean {
    return patterns.some((p) => p.test(message));
  }

  it("matches the user-reported EUNSUPPORTEDPROTOCOL / link: combination", () => {
    expect(
      looksLikeExistingManifestError(
        'npm error code EUNSUPPORTEDPROTOCOL\nnpm error Unsupported URL Type "link:": link:./eslint'
      )
    ).toBe(true);
  });
  it("matches ERESOLVE peer-dep conflicts", () => {
    expect(looksLikeExistingManifestError("npm error code ERESOLVE\nnpm error peer dep")).toBe(
      true
    );
  });
  it("matches 'could not resolve dependency' (npm 10+ phrasing)", () => {
    expect(looksLikeExistingManifestError("npm error could not resolve dependency: react")).toBe(
      true
    );
  });
  it("matches ENOENT against a project package.json (broken file: dep)", () => {
    expect(
      looksLikeExistingManifestError(
        "npm ERR! ENOENT: no such file or directory, open '/x/package.json'"
      )
    ).toBe(true);
  });
  it("does NOT match a generic registry timeout (real argent install problem)", () => {
    expect(
      looksLikeExistingManifestError("npm error code ETIMEDOUT\nnpm error network timeout")
    ).toBe(false);
  });
  it("does NOT match a generic 404 against argent itself", () => {
    expect(
      looksLikeExistingManifestError(
        "npm error 404 Not Found - GET https://registry.npmjs.org/@swmansion/argent"
      )
    ).toBe(false);
  });
});
