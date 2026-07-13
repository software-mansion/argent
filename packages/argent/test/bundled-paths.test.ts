import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findStablePackageDir } from "../src/bundled-paths.js";

// findStablePackageDir resolves the version-STABLE node_modules symlink for the
// running package — the one that survives a pnpm store prune. The bug it fixes:
// in a pnpm workspace the symlink lives in the DECLARING member's node_modules,
// a level below the workspace root where the .pnpm store (the realpath target)
// lives, so a probe that only checks the root misses it and falls back to the
// version-pinned store path.

const PKG = "@swmansion/argent";

let tmpDir: string;

// Creates a real "store" dir standing in for the resolved package, and a
// node_modules/<pkg> SYMLINK to it under `linkParent`.
function linkTo(linkParent: string, realPkgDir: string): string {
  const nm = path.join(linkParent, "node_modules", "@swmansion");
  fs.mkdirSync(nm, { recursive: true });
  const link = path.join(nm, "argent");
  fs.symlinkSync(realPkgDir, link);
  return path.join(linkParent, "node_modules", PKG);
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-stable-path-")));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("findStablePackageDir", () => {
  it("finds the symlink at cwd for a single-package layout", () => {
    const store = path.join(tmpDir, "store", "argent");
    fs.mkdirSync(store, { recursive: true });
    const proj = path.join(tmpDir, "proj");
    const link = linkTo(proj, store);

    expect(findStablePackageDir(proj, store)).toBe(link);
  });

  it("scans up to find the DECLARING member's symlink in a pnpm workspace", () => {
    // The version-pinned store lives at the workspace root; the stable symlink
    // is only in the member's node_modules, a level below where the store sits.
    const store = path.join(tmpDir, "root", "node_modules", ".pnpm", "argent");
    fs.mkdirSync(store, { recursive: true });
    const member = path.join(tmpDir, "root", "packages", "app");
    const memberLink = linkTo(member, store);
    // Root has a .pnpm store but NO top-level @swmansion/argent symlink.

    // cwd is the member root.
    expect(findStablePackageDir(member, store)).toBe(memberLink);
    // ...and the returned path is NOT the version-pinned store dir.
    expect(findStablePackageDir(member, store)).not.toContain(".pnpm");
  });

  it("prefers the deepest (closest-to-cwd) alias when several resolve to the package", () => {
    const store = path.join(tmpDir, "store", "argent");
    fs.mkdirSync(store, { recursive: true });
    const root = path.join(tmpDir, "root");
    const member = path.join(root, "packages", "app");
    linkTo(root, store);
    const memberLink = linkTo(member, store);

    expect(findStablePackageDir(member, store)).toBe(memberLink);
  });

  it("returns undefined when no symlink resolves to the running package", () => {
    const store = path.join(tmpDir, "store", "argent");
    fs.mkdirSync(store, { recursive: true });
    const proj = path.join(tmpDir, "proj");
    // A node_modules/<pkg> that points somewhere ELSE must not be accepted.
    const other = path.join(tmpDir, "other", "argent");
    fs.mkdirSync(other, { recursive: true });
    linkTo(proj, other);

    expect(findStablePackageDir(proj, store)).toBeUndefined();
  });
});
