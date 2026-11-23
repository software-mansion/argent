import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolvePackageRoot } from "../src/utils.js";
import { PACKAGE_NAME } from "../src/constants.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string;

function mkdirp(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

function writeFile(p: string, content: string): void {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, content);
}

function writePkg(dir: string, name: string, version = "1.0.0"): void {
  writeFile(path.join(dir, "package.json"), JSON.stringify({ name, version }));
}

function writeSkills(pkgRoot: string): void {
  mkdirp(path.join(pkgRoot, "skills", "simulator-interact"));
  writeFile(
    path.join(pkgRoot, "skills", "simulator-interact", "SKILL.md"),
    "---\nname: simulator-interact\ndescription: test\n---\n"
  );
}

/**
 * Given a simulated package root, return what resolvePackageRoot produces
 * when called from the dist/cli/ directory inside that package.
 */
function resolveFrom(pkgRoot: string): string {
  const distCli = path.join(pkgRoot, "dist", "cli");
  mkdirp(distCli);
  return resolvePackageRoot(distCli);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-pkgroot-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Local install in monorepos ────────────────────────────────────────────────

describe("local install — npm workspaces (hoisted)", () => {
  // Hoisted: <monorepo>/node_modules/@swmansion/argent/
  // Monorepo root has its own package.json with a different name
  it("resolves to the argent package, not the monorepo root", () => {
    const monorepo = path.join(tmpDir, "my-monorepo");
    writePkg(monorepo, "my-monorepo");
    writeFile(
      path.join(monorepo, "package.json"),
      JSON.stringify({
        name: "my-monorepo",
        private: true,
        workspaces: ["packages/*"],
      })
    );

    const pkgRoot = path.join(monorepo, "node_modules", "@swmansion", "argent");
    writePkg(pkgRoot, PACKAGE_NAME);
    writeSkills(pkgRoot);

    const resolved = resolveFrom(pkgRoot);
    expect(resolved).toBe(pkgRoot);
    // Should NOT be the monorepo root
    expect(resolved).not.toBe(monorepo);
  });
});

describe("local install — pnpm (symlinked from store)", () => {
  it("resolves correctly via symlink (realpath)", () => {
    const project = path.join(tmpDir, "symlink-project");
    writePkg(project, "my-project");

    // Real location in the .pnpm store
    const storePkg = path.join(
      project,
      "node_modules",
      ".pnpm",
      "@swmansion+argent@0.3.1",
      "node_modules",
      "@swmansion",
      "argent"
    );
    writePkg(storePkg, PACKAGE_NAME, "0.3.1");
    writeSkills(storePkg);
    mkdirp(path.join(storePkg, "dist", "cli"));

    // Create the symlink at the standard location
    const symlinkDir = path.join(project, "node_modules", "@swmansion");
    mkdirp(symlinkDir);
    fs.symlinkSync(storePkg, path.join(symlinkDir, "argent"), "dir");

    // When Node resolves import.meta.dirname, it uses the real path
    const realDistCli = fs.realpathSync(path.join(symlinkDir, "argent", "dist", "cli"));

    const resolved = resolvePackageRoot(realDistCli);
    expect(fs.existsSync(path.join(resolved, "skills"))).toBe(true);
    expect(fs.existsSync(path.join(resolved, "package.json"))).toBe(true);
  });
});

// ── The actual running environment ────────────────────────────────────────────

describe("actual environment — this monorepo", () => {
  it("PACKAGE_ROOT from the live module points to its package directory", () => {
    // After bundling, the installer ships as a single dist/installer.cjs inside
    // the published package, so resolvePackageRoot(dist/) -> the published
    // package root. During monorepo development the function still walks two
    // dirs up; given the test file lives at packages/argent-installer/test/,
    // we exercise the function from a known location inside the package.
    const fakeDistCli = path.resolve(import.meta.dirname, "..", "dist", "cli");
    const resolved = resolvePackageRoot(fakeDistCli);
    expect(resolved).toBe(path.resolve(import.meta.dirname, ".."));
    const resolvedPkg = path.join(resolved, "package.json");
    expect(fs.existsSync(resolvedPkg)).toBe(true);
  });
});
