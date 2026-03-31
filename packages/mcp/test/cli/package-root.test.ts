import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolvePackageRoot } from "../../src/cli/utils.js";
import { PACKAGE_NAME } from "../../src/cli/constants.js";

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
  writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name, version }),
  );
}

function writeSkills(pkgRoot: string): void {
  mkdirp(path.join(pkgRoot, "skills", "simulator-interact"));
  writeFile(
    path.join(pkgRoot, "skills", "simulator-interact", "SKILL.md"),
    "---\nname: simulator-interact\ndescription: test\n---\n",
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

// ── Global install layouts ────────────────────────────────────────────────────

describe("global install — npm", () => {
  // npm i -g: <prefix>/lib/node_modules/@software-mansion/argent/
  it("resolves from npm global layout", () => {
    const prefix = path.join(tmpDir, "usr", "lib", "node_modules");
    const pkgRoot = path.join(prefix, "@software-mansion", "argent");
    writePkg(pkgRoot, PACKAGE_NAME);
    writeSkills(pkgRoot);

    const resolved = resolveFrom(pkgRoot);
    expect(resolved).toBe(pkgRoot);
    expect(fs.existsSync(path.join(resolved, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(resolved, "skills"))).toBe(true);
  });
});

describe("global install — nvm", () => {
  // nvm: ~/.nvm/versions/node/v22.0.0/lib/node_modules/@software-mansion/argent/
  it("resolves from nvm global layout", () => {
    const pkgRoot = path.join(
      tmpDir,
      ".nvm", "versions", "node", "v22.0.0",
      "lib", "node_modules", "@software-mansion", "argent",
    );
    writePkg(pkgRoot, PACKAGE_NAME);
    writeSkills(pkgRoot);

    const resolved = resolveFrom(pkgRoot);
    expect(resolved).toBe(pkgRoot);
    expect(fs.existsSync(path.join(resolved, "skills"))).toBe(true);
  });
});

describe("global install — pnpm", () => {
  // pnpm add -g: ~/.local/share/pnpm/global/5/node_modules/@software-mansion/argent/
  it("resolves from pnpm global layout", () => {
    const pkgRoot = path.join(
      tmpDir,
      ".local", "share", "pnpm", "global", "5",
      "node_modules", "@software-mansion", "argent",
    );
    writePkg(pkgRoot, PACKAGE_NAME);
    writeSkills(pkgRoot);

    const resolved = resolveFrom(pkgRoot);
    expect(resolved).toBe(pkgRoot);
  });
});

describe("global install — yarn classic", () => {
  // yarn global add: ~/.config/yarn/global/node_modules/@software-mansion/argent/
  it("resolves from yarn global layout", () => {
    const pkgRoot = path.join(
      tmpDir,
      ".config", "yarn", "global",
      "node_modules", "@software-mansion", "argent",
    );
    writePkg(pkgRoot, PACKAGE_NAME);
    writeSkills(pkgRoot);

    const resolved = resolveFrom(pkgRoot);
    expect(resolved).toBe(pkgRoot);
  });
});

// ── Local install in monorepos ────────────────────────────────────────────────

describe("local install — npm workspaces (hoisted)", () => {
  // Hoisted: <monorepo>/node_modules/@software-mansion/argent/
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
      }),
    );

    const pkgRoot = path.join(
      monorepo, "node_modules", "@software-mansion", "argent",
    );
    writePkg(pkgRoot, PACKAGE_NAME);
    writeSkills(pkgRoot);

    const resolved = resolveFrom(pkgRoot);
    expect(resolved).toBe(pkgRoot);
    // Should NOT be the monorepo root
    expect(resolved).not.toBe(monorepo);
  });
});

describe("local install — pnpm (symlinked from store)", () => {
  // pnpm stores in a content-addressable store, then symlinks:
  //   <project>/node_modules/.pnpm/@software-mansion+argent@0.3.1/node_modules/@software-mansion/argent/
  // The symlink at <project>/node_modules/@software-mansion/argent -> above
  // import.meta.dirname follows the real path.
  it("resolves from pnpm .pnpm store layout", () => {
    const project = path.join(tmpDir, "my-project");
    writePkg(project, "my-project");

    const storePkg = path.join(
      project,
      "node_modules", ".pnpm",
      "@software-mansion+argent@0.3.1",
      "node_modules", "@software-mansion", "argent",
    );
    writePkg(storePkg, PACKAGE_NAME, "0.3.1");
    writeSkills(storePkg);

    const resolved = resolveFrom(storePkg);
    expect(resolved).toBe(storePkg);
    expect(fs.existsSync(path.join(resolved, "skills"))).toBe(true);
  });

  it("resolves correctly via symlink (realpath)", () => {
    const project = path.join(tmpDir, "symlink-project");
    writePkg(project, "my-project");

    // Real location in the .pnpm store
    const storePkg = path.join(
      project,
      "node_modules", ".pnpm",
      "@software-mansion+argent@0.3.1",
      "node_modules", "@software-mansion", "argent",
    );
    writePkg(storePkg, PACKAGE_NAME, "0.3.1");
    writeSkills(storePkg);
    mkdirp(path.join(storePkg, "dist", "cli"));

    // Create the symlink at the standard location
    const symlinkDir = path.join(
      project, "node_modules", "@software-mansion",
    );
    mkdirp(symlinkDir);
    fs.symlinkSync(storePkg, path.join(symlinkDir, "argent"), "dir");

    // When Node resolves import.meta.dirname, it uses the real path
    const realDistCli = fs.realpathSync(
      path.join(symlinkDir, "argent", "dist", "cli"),
    );

    const resolved = resolvePackageRoot(realDistCli);
    expect(fs.existsSync(path.join(resolved, "skills"))).toBe(true);
    expect(fs.existsSync(path.join(resolved, "package.json"))).toBe(true);
  });
});

describe("local install — yarn PnP (unplugged)", () => {
  // Yarn PnP unplugged packages:
  //   <project>/.yarn/unplugged/@software-mansion-argent-npm-0.3.1-<hash>/node_modules/@software-mansion/argent/
  it("resolves from yarn PnP unplugged layout", () => {
    const project = path.join(tmpDir, "pnp-project");
    writePkg(project, "pnp-project");

    const pkgRoot = path.join(
      project,
      ".yarn", "unplugged",
      "@software-mansion-argent-npm-0.3.1-abc123",
      "node_modules", "@software-mansion", "argent",
    );
    writePkg(pkgRoot, PACKAGE_NAME, "0.3.1");
    writeSkills(pkgRoot);

    const resolved = resolveFrom(pkgRoot);
    expect(resolved).toBe(pkgRoot);
    expect(fs.existsSync(path.join(resolved, "skills"))).toBe(true);
  });
});

// ── Development (monorepo source) ─────────────────────────────────────────────

describe("development — running from monorepo source", () => {
  // When developing, src/cli/utils.ts runs from packages/mcp/src/cli/
  // (or dist/cli/ after build). The package root is packages/mcp/.
  it("resolves from packages/mcp/dist/cli/ during development", () => {
    const monorepo = path.join(tmpDir, "argent-monorepo");
    writePkg(monorepo, "argent-workspace");

    const pkgRoot = path.join(monorepo, "packages", "mcp");
    writePkg(pkgRoot, PACKAGE_NAME, "0.3.1");
    writeSkills(pkgRoot);

    const resolved = resolveFrom(pkgRoot);
    expect(resolved).toBe(pkgRoot);
    expect(fs.existsSync(path.join(resolved, "skills"))).toBe(true);
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("skills/rules/agents dirs are siblings of package.json", () => {
    const pkgRoot = path.join(tmpDir, "edge-pkg");
    writePkg(pkgRoot, PACKAGE_NAME);
    writeSkills(pkgRoot);
    mkdirp(path.join(pkgRoot, "rules"));
    mkdirp(path.join(pkgRoot, "agents"));

    const resolved = resolveFrom(pkgRoot);
    expect(path.join(resolved, "skills")).toBe(path.join(pkgRoot, "skills"));
    expect(path.join(resolved, "rules")).toBe(path.join(pkgRoot, "rules"));
    expect(path.join(resolved, "agents")).toBe(path.join(pkgRoot, "agents"));
  });

  it("resolution is deterministic — same input always same output", () => {
    const pkgRoot = path.join(tmpDir, "deterministic");
    writePkg(pkgRoot, PACKAGE_NAME);
    mkdirp(path.join(pkgRoot, "dist", "cli"));

    const distCli = path.join(pkgRoot, "dist", "cli");
    const r1 = resolvePackageRoot(distCli);
    const r2 = resolvePackageRoot(distCli);
    const r3 = resolvePackageRoot(distCli);
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
    expect(r1).toBe(pkgRoot);
  });
});

// ── The actual running environment ────────────────────────────────────────────

describe("actual environment — this monorepo", () => {
  it("PACKAGE_ROOT from the live module points to packages/mcp", () => {
    // import.meta.dirname of utils.ts in test context is src/cli/
    // resolvePackageRoot("src/cli/") -> packages/mcp/
    // We can't test the exact constant (it's evaluated at import time),
    // but we can test the function with the known source layout.
    const srcCli = path.resolve(
      import.meta.dirname, "..", "..", "src", "cli",
    );
    const resolved = resolvePackageRoot(srcCli);
    const resolvedPkg = path.join(resolved, "package.json");

    // Should resolve to packages/mcp/ which has package.json
    expect(fs.existsSync(resolvedPkg)).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(resolvedPkg, "utf8"));
    expect(pkg.name).toBe(PACKAGE_NAME);
  });
});
