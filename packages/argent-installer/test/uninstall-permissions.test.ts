import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const execSyncMock = vi.hoisted(() => vi.fn(() => ""));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, default: { ...actual, execSync: execSyncMock }, execSync: execSyncMock };
});

import { probeGlobalPackageRemoval } from "../src/topology.js";
import { PACKAGE_NAME } from "../src/constants.js";

/**
 * The preflight behind issue #622: `uninstall` prunes the workspace before it
 * removes the package, so a removal that dies on permissions leaves the user
 * with no config and a package that is still installed. The probe answers
 * "could the removal even work?" while nothing has been touched.
 *
 * The bug it prevents is destructive, but a WRONG probe is worse: a false
 * "blocked" refuses an uninstall that would have succeeded. Hence the bias —
 * everything inconclusive must read "unknown", which callers treat as
 * "writable".
 */
describe("probeGlobalPackageRemoval", () => {
  let tmpDir: string;
  let originalAgent: string | undefined;

  /**
   * The layout npm actually creates: a bin symlink into
   * <prefix>/lib/node_modules/<pkg>/dist. Returns the staged bin path.
   */
  function stageInstall(root: string, opts: { linked?: boolean } = {}): string {
    const pkgRoot = path.join(root, "lib", "node_modules", PACKAGE_NAME);
    const binDir = path.join(root, "bin");
    fs.mkdirSync(binDir, { recursive: true });

    if (opts.linked) {
      // `npm link`: the package dir is a symlink to a source checkout.
      const checkout = path.join(root, "checkout");
      fs.mkdirSync(path.join(checkout, "dist"), { recursive: true });
      fs.writeFileSync(
        path.join(checkout, "package.json"),
        JSON.stringify({ name: PACKAGE_NAME, version: "0.0.0" })
      );
      fs.mkdirSync(path.dirname(pkgRoot), { recursive: true });
      fs.symlinkSync(checkout, pkgRoot);
    } else {
      fs.mkdirSync(path.join(pkgRoot, "dist"), { recursive: true });
      fs.writeFileSync(
        path.join(pkgRoot, "package.json"),
        JSON.stringify({ name: PACKAGE_NAME, version: "0.0.0" })
      );
    }

    const binPath = path.join(binDir, "argent");
    fs.writeFileSync(binPath, "#!/usr/bin/env node\n");
    fs.chmodSync(binPath, 0o755);
    return binPath;
  }

  /** The scope directory npm renames inside — the one whose mode decides it. */
  function scopeDir(root: string): string {
    return path.dirname(path.join(root, "lib", "node_modules", PACKAGE_NAME));
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-removal-probe-"));
    originalAgent = process.env.npm_config_user_agent;
    process.env.npm_config_user_agent = "npm/10.0.0 node/v22.0.0";
    execSyncMock.mockReset();
  });

  afterEach(() => {
    if (originalAgent === undefined) delete process.env.npm_config_user_agent;
    else process.env.npm_config_user_agent = originalAgent;
    // Restore write permission first or the cleanup itself throws.
    try {
      fs.chmodSync(scopeDir(tmpDir), 0o755);
    } catch {
      // Never staged, or already writable.
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const skipUnlessPosixUser = process.platform === "win32" || process.getuid?.() === 0;

  it.skipIf(skipUnlessPosixUser)("reports blocked when the scope dir is not writable", () => {
    const binPath = stageInstall(tmpDir);
    execSyncMock.mockReturnValue(`${binPath}\n`);
    fs.chmodSync(scopeDir(tmpDir), 0o555);

    const probe = probeGlobalPackageRemoval();

    expect(probe.verdict).toBe("blocked");
    expect(probe.parentDir).toBe(scopeDir(tmpDir));
  });

  it.skipIf(skipUnlessPosixUser)("reports writable for the same layout at 0o755", () => {
    const binPath = stageInstall(tmpDir);
    execSyncMock.mockReturnValue(`${binPath}\n`);

    expect(probeGlobalPackageRemoval().verdict).toBe("writable");
  });

  it.skipIf(skipUnlessPosixUser)(
    "stays unknown for a linked install, whose parent npm never renames",
    () => {
      // Under `npm link` the resolved package root is the source checkout, so a
      // realpath-based probe would measure the checkout's parent — a directory
      // npm does not touch. If that checkout happened to be read-only we would
      // refuse an uninstall that works. Bail on the symlink instead.
      const binPath = stageInstall(tmpDir, { linked: true });
      execSyncMock.mockReturnValue(`${binPath}\n`);
      fs.chmodSync(scopeDir(tmpDir), 0o555);

      expect(probeGlobalPackageRemoval().verdict).toBe("unknown");
    }
  );

  it("stays unknown when argent is not on PATH", () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("which: no argent");
    });

    expect(probeGlobalPackageRemoval().verdict).toBe("unknown");
  });

  it.skipIf(skipUnlessPosixUser)("stays unknown when the package dir is absent", () => {
    const binDir = path.join(tmpDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const binPath = path.join(binDir, "argent");
    fs.writeFileSync(binPath, "#!/usr/bin/env node\n");
    execSyncMock.mockReturnValue(`${binPath}\n`);

    // Nothing at the logical path: the layout is not what we assumed, which is
    // a reason to stay quiet rather than to block.
    expect(probeGlobalPackageRemoval().verdict).toBe("unknown");
  });

  it.skipIf(skipUnlessPosixUser)(
    "stays unknown under a non-npm manager even when the dir is unwritable",
    () => {
      // pnpm/yarn/bun globals live in their own stores; the rename-in-parent
      // mechanic this probe measures is npm's alone.
      const binPath = stageInstall(tmpDir);
      execSyncMock.mockReturnValue(`${binPath}\n`);
      fs.chmodSync(scopeDir(tmpDir), 0o555);
      process.env.npm_config_user_agent = "pnpm/9.0.0 node/v22.0.0";

      expect(probeGlobalPackageRemoval().verdict).toBe("unknown");
    }
  );

  it.skipIf(process.platform !== "win32")("stays unknown on Windows", () => {
    // access(W_OK) there reflects only the read-only attribute, which says
    // nothing about a directory's ACL — it would read "writable" for a dir the
    // user cannot touch.
    const binPath = stageInstall(tmpDir);
    execSyncMock.mockReturnValue(`${binPath}\n`);

    expect(probeGlobalPackageRemoval().verdict).toBe("unknown");
  });
});
