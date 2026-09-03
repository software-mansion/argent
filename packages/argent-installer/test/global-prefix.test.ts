import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const { mockExecFileSync, mockAccessSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockAccessSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFileSync: mockExecFileSync }));

// Real fs everywhere except accessSync, whose errno is the whole verdict and
// whose interesting values (a read-only mount) no chmod can produce.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  mockAccessSync.mockImplementation(actual.accessSync);
  return { ...actual, accessSync: mockAccessSync };
});

import {
  blockedGlobalTargetCause,
  canRecoverBlockedGlobal,
  forgetInheritedNpmPrefix,
  isNixStorePath,
  npmGlobalBinDir,
  provenUnwritableDir,
  npmUserConfigPath,
  probeGlobalInstallTarget,
  unwritableGlobalTargetMessage,
} from "../src/global-prefix.js";

// A chmod'd directory is the only honest test of the writability probe, and
// root bypasses the mode bits (as it does on a real machine, correctly).
// Windows fs.access(W_OK) only reflects the read-only attribute, never ACLs.
const canTestUnwritable = process.platform !== "win32" && process.getuid?.() !== 0;

// The messages are styled with picocolors, which stays on under FORCE_COLOR.
// eslint-disable-next-line no-control-regex
const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");

let tmpRoot: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argent-global-prefix-"));
});

afterEach(() => {
  fs.chmodSync(tmpRoot, 0o755);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("probeGlobalInstallTarget", () => {
  it("asks each package manager for its own global directory", () => {
    mockExecFileSync.mockReturnValue(`${tmpRoot}\n`);

    for (const [pm, args] of [
      ["npm", ["root", "-g"]],
      ["pnpm", ["root", "-g"]],
      ["yarn", ["global", "dir"]],
      ["bun", ["pm", "bin", "-g"]],
    ] as const) {
      mockExecFileSync.mockClear();
      probeGlobalInstallTarget(pm);
      expect(mockExecFileSync).toHaveBeenCalledWith(pm, args, expect.anything());
    }
  });

  it("leaves a writable directory unblocked", () => {
    mockExecFileSync.mockReturnValue(`${tmpRoot}\n`);

    expect(probeGlobalInstallTarget("npm")).toEqual({
      dir: tmpRoot,
      blocked: false,
      nixStore: false,
    });
  });

  it.skipIf(!canTestUnwritable)("reports a read-only directory as blocked", () => {
    const globalDir = path.join(tmpRoot, "lib", "node_modules");
    fs.mkdirSync(globalDir, { recursive: true });
    fs.chmodSync(globalDir, 0o555);
    mockExecFileSync.mockReturnValue(`${globalDir}\n`);

    expect(probeGlobalInstallTarget("npm")?.blocked).toBe(true);
  });

  // access(W_OK) on Windows reflects only the read-only attribute, which is
  // routinely set on directories the user can write to — a reading there would
  // refuse installs that work.
  it("declines to answer on Windows", () => {
    const platform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      mockExecFileSync.mockReturnValue(`${tmpRoot}\n`);
      expect(probeGlobalInstallTarget("npm")).toBeNull();
    } finally {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
    }
  });

  it("probes the nearest EXISTING ancestor of a directory the install would create", () => {
    // `<prefix>/lib/node_modules` exists long before the `@swmansion` scope dir
    // under it; the verdict has to be about the directory that really gets the
    // mkdir, not about a path that is simply absent.
    const globalDir = path.join(tmpRoot, "lib", "node_modules");
    fs.mkdirSync(globalDir, { recursive: true });
    mockExecFileSync.mockReturnValue(`${globalDir}\n`);

    expect(probeGlobalInstallTarget("npm")?.dir).toBe(globalDir);
  });

  it.skipIf(!canTestUnwritable)(
    "blocks on a read-only scope directory under a writable global root",
    () => {
      // What `sudo npm install -g` leaves behind: node_modules still belongs to
      // the user, `@swmansion` under it does not — and that is the directory
      // npm renames inside, so the install dies there with EACCES.
      const globalDir = path.join(tmpRoot, "lib", "node_modules");
      const scopeDir = path.join(globalDir, "@swmansion");
      fs.mkdirSync(scopeDir, { recursive: true });
      fs.chmodSync(scopeDir, 0o555);
      mockExecFileSync.mockReturnValue(`${globalDir}\n`);

      try {
        expect(probeGlobalInstallTarget("npm")).toEqual({
          dir: scopeDir,
          blocked: true,
          nixStore: false,
        });
      } finally {
        fs.chmodSync(scopeDir, 0o755);
      }
    }
  );

  it("falls back to the installed package's parent when the manager query fails", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("npm not found");
    });
    // The installed package's own directory exists, and is not the answer: an
    // install replaces that entry, which takes write access to the parent.
    const packageDir = path.join(tmpRoot, "lib", "node_modules", "@swmansion", "argent");
    fs.mkdirSync(packageDir, { recursive: true });

    expect(probeGlobalInstallTarget("npm", packageDir)?.dir).toBe(path.dirname(packageDir));
  });

  it("returns null when neither the query nor a fallback yields a directory", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("npm not found");
    });

    expect(probeGlobalInstallTarget("npm")).toBeNull();
  });

  // The store is a read-only MOUNT on NixOS and nix-darwin, where access(W_OK)
  // answers EROFS rather than EACCES — the motivating case, and root is no
  // more exempt from it than anyone else.
  it("treats a read-only filesystem as blocked", () => {
    mockExecFileSync.mockReturnValue(`${tmpRoot}\n`);
    mockAccessSync.mockImplementationOnce(() => {
      throw Object.assign(new Error("EROFS"), { code: "EROFS" });
    });

    expect(probeGlobalInstallTarget("npm")?.blocked).toBe(true);
  });

  it("blocks on EPERM, which is what a protected directory answers", () => {
    mockExecFileSync.mockReturnValue(`${tmpRoot}\n`);
    mockAccessSync.mockImplementationOnce(() => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    });

    expect(probeGlobalInstallTarget("npm")?.blocked).toBe(true);
  });

  it("stays silent when the directory cannot be read for some other reason", () => {
    mockExecFileSync.mockReturnValue(`${tmpRoot}\n`);
    mockAccessSync.mockImplementationOnce(() => {
      throw Object.assign(new Error("EIO"), { code: "EIO" });
    });

    expect(probeGlobalInstallTarget("npm")).toBeNull();
  });

  it("reads the path off the last line, past whatever the manager printed first", () => {
    mockExecFileSync.mockReturnValue(` WARN  deprecated config\n${tmpRoot}\n`);

    expect(probeGlobalInstallTarget("npm")?.dir).toBe(tmpRoot);
  });

  it("bounds the query and keeps the manager's own chatter off the screen", () => {
    mockExecFileSync.mockReturnValue(`${tmpRoot}\n`);

    probeGlobalInstallTarget("npm");

    const [, , options] = mockExecFileSync.mock.calls[0] as [
      string,
      string[],
      { timeout: number; stdio: string[] },
    ];
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.stdio).toEqual(["ignore", "pipe", "ignore"]);
  });

  it("ignores a relative path from the manager rather than resolving it against cwd", () => {
    mockExecFileSync.mockReturnValue("lib/node_modules\n");

    expect(probeGlobalInstallTarget("npm")).toBeNull();
  });
});

describe("canRecoverBlockedGlobal", () => {
  it("has something to carry out for npm, whether or not a project can hold it", () => {
    expect(canRecoverBlockedGlobal("npm", true)).toBe(true);
    expect(canRecoverBlockedGlobal("npm", false)).toBe(true);
  });

  it("falls back to the project install for a manager argent cannot relocate", () => {
    expect(canRecoverBlockedGlobal("pnpm", true)).toBe(true);
    expect(canRecoverBlockedGlobal("yarn", true)).toBe(true);
    expect(canRecoverBlockedGlobal("bun", true)).toBe(true);
  });

  // Nothing to move and nothing to install into: a prompt here would offer one
  // option that fails and "Cancel".
  it("has nothing to offer without npm's prefix or a package.json", () => {
    expect(canRecoverBlockedGlobal("pnpm", false)).toBe(false);
    expect(canRecoverBlockedGlobal("yarn", false)).toBe(false);
    expect(canRecoverBlockedGlobal("bun", false)).toBe(false);
  });
});

describe("isNixStorePath", () => {
  it("recognizes the default store and rejects lookalike prefixes", () => {
    expect(isNixStorePath("/nix/store/abc123-nodejs-22.16.0/lib/node_modules")).toBe(true);
    expect(isNixStorePath("/nix/store")).toBe(true);
    expect(isNixStorePath("/nix/storeroom/abc")).toBe(false);
    expect(isNixStorePath("/usr/local/lib/node_modules")).toBe(false);
  });

  it("honors NIX_STORE_DIR, which relocated installs set", () => {
    const previous = process.env.NIX_STORE_DIR;
    process.env.NIX_STORE_DIR = "/opt/nixstore";
    try {
      expect(isNixStorePath("/opt/nixstore/abc123-nodejs/lib")).toBe(true);
      expect(isNixStorePath("/nix/store/abc123-nodejs/lib")).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.NIX_STORE_DIR;
      else process.env.NIX_STORE_DIR = previous;
    }
  });
});

describe("unwritableGlobalTargetMessage", () => {
  const nixTarget = {
    dir: "/nix/store/abc-nodejs-22.16.0/lib/node_modules",
    blocked: true,
    nixStore: true,
  };
  const plainTarget = { dir: "/usr/local/lib/node_modules", blocked: true, nixStore: false };
  // The reader already has argent on PATH (update, or a reinstall over an
  // existing global install) and a package.json to install into.
  const installed = { localViable: true, argentOnPath: true };

  it("names the Nix store, rules out sudo, and offers the per-project install", () => {
    const message = plain(unwritableGlobalTargetMessage(nixTarget, "npm", "update", installed));

    expect(message).toContain("cannot update @swmansion/argent globally");
    expect(message).toContain("read-only Nix store");
    expect(message).toContain(nixTarget.dir);
    // Root can write a single-user store's 0555 paths — Nix undoing the write
    // is what actually rules sudo out, and it rules it out everywhere.
    expect(message).toContain("sudo install into it is undone");
    // Anchored: `npx @swmansion/argent init --local` contains the bare form.
    expect(message).toMatch(/^\s*argent init --local$/m);
  });

  it("claims nothing about a run that has not happened yet", () => {
    // Also printed as the preamble to the prompt offering the ways out.
    expect(plain(blockedGlobalTargetCause(plainTarget, "npm", "install"))).not.toContain(
      "Nothing was installed"
    );
  });

  it("offers the writable-prefix fix for npm only", () => {
    expect(plain(unwritableGlobalTargetMessage(nixTarget, "npm", "install", installed))).toContain(
      'npm config set prefix "$HOME/.npm-global"'
    );
    expect(
      plain(unwritableGlobalTargetMessage(nixTarget, "pnpm", "install", installed))
    ).not.toContain("config set prefix");
  });

  it("offers taking ownership of an ordinary unwritable directory", () => {
    // The prefix remedy is a no-op where the blocked directory sits under a
    // prefix the user already chose and `sudo npm i -g` left root-owned.
    const message = plain(unwritableGlobalTargetMessage(plainTarget, "npm", "install", installed));

    expect(message).toContain(`sudo chown -R "$(whoami)" ${plainTarget.dir}`);
  });

  it("never offers to chown a store path", () => {
    // Nix undoes it at the next rebuild — the same reason sudo is ruled out.
    expect(
      plain(unwritableGlobalTargetMessage(nixTarget, "npm", "install", installed))
    ).not.toContain("chown");
  });

  it("does not blame Nix for an ordinary unwritable prefix", () => {
    const message = plain(unwritableGlobalTargetMessage(plainTarget, "npm", "install", installed));

    expect(message).toContain("not writable by this user");
    expect(message).not.toContain("Nix");
    expect(message).toContain("cannot install @swmansion/argent globally");
  });

  // A fresh global install is reached through `npx @swmansion/argent init`, so
  // a bare `argent` is command-not-found for the person reading the remedy.
  it("routes the per-project remedy through npx while argent is not on PATH", () => {
    const message = plain(
      unwritableGlobalTargetMessage(nixTarget, "npm", "install", {
        localViable: true,
        argentOnPath: false,
      })
    );

    expect(message).toContain("npx @swmansion/argent init --local");
    expect(message).not.toMatch(/^\s*argent init --local$/m);
  });

  // `argent init --local` in a directory with no package.json only reaches
  // installLocally's precondition error, which points back at --global.
  it("drops the per-project remedy where there is no package.json to install into", () => {
    const message = plain(
      unwritableGlobalTargetMessage(nixTarget, "npm", "install", {
        localViable: false,
        argentOnPath: true,
      })
    );

    expect(message).not.toContain("init --local");
    expect(message).toContain('npm config set prefix "$HOME/.npm-global"');
  });

  it("prints no command at all rather than one that cannot work", () => {
    // pnpm has no prefix argent can move and there is nothing to install into:
    // what is left is true, and nothing the user can mistype.
    const message = plain(
      unwritableGlobalTargetMessage(nixTarget, "pnpm", "install", {
        localViable: false,
        argentOnPath: false,
      })
    );

    expect(message).not.toContain("init --local");
    expect(message).toContain("Point pnpm at a global directory you can write to");
  });
});

describe("isNixStorePath", () => {
  it("sees through a symlink into the store, as the writability probe does", () => {
    const store = path.join(tmpRoot, "store");
    const inStore = path.join(store, "abc-nodejs-24", "lib", "node_modules");
    fs.mkdirSync(inStore, { recursive: true });
    const link = path.join(tmpRoot, "npm-global-root");
    fs.symlinkSync(inStore, link);

    const previous = process.env.NIX_STORE_DIR;
    process.env.NIX_STORE_DIR = store;
    try {
      expect(isNixStorePath(link)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.NIX_STORE_DIR;
      else process.env.NIX_STORE_DIR = previous;
    }
  });
});

describe("npmUserConfigPath", () => {
  it("asks npm rather than assuming ~/.npmrc", () => {
    mockExecFileSync.mockReturnValue("/etc/nix-managed/npmrc\n");

    expect(npmUserConfigPath()).toBe("/etc/nix-managed/npmrc");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "npm",
      ["config", "get", "userconfig"],
      expect.anything()
    );
  });

  it("falls back to the default name when npm cannot be asked", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("npm not found");
    });

    expect(npmUserConfigPath()).toBe(path.join(os.homedir(), ".npmrc"));
  });
});

describe("forgetInheritedNpmPrefix", () => {
  it("drops what outranks the written prefix, and only that", () => {
    process.env.npm_config_prefix = "/nix/store/abc-nodejs-24";
    process.env.NPM_CONFIG_PREFIX = "/nix/store/abc-nodejs-24";
    // Measured on npm 11: PREFIX is only the default for an npmrc with no
    // prefix key, so it cannot outrank the one just written — and it is a
    // general-purpose variable the install and every step after it inherit.
    process.env.PREFIX = "/usr/local";
    try {
      forgetInheritedNpmPrefix();

      expect(process.env.npm_config_prefix).toBeUndefined();
      expect(process.env.NPM_CONFIG_PREFIX).toBeUndefined();
      expect(process.env.PREFIX).toBe("/usr/local");
    } finally {
      delete process.env.PREFIX;
    }
  });
});

describe("provenUnwritableDir", () => {
  it("names the nearest existing ancestor when it is proven unwritable", () => {
    if (!canTestUnwritable) return;
    fs.chmodSync(tmpRoot, 0o555);

    // The directory an install would have to create its entry under.
    expect(provenUnwritableDir(path.join(tmpRoot, "bin"))).toBe(tmpRoot);
  });

  it("stays quiet where nothing was proven", () => {
    expect(provenUnwritableDir(path.join(tmpRoot, "bin"))).toBeNull();
  });
});

describe("npmGlobalBinDir", () => {
  it("asks npm for the prefix its commands are linked under", () => {
    mockExecFileSync.mockReturnValue(`${tmpRoot}\n`);

    expect(npmGlobalBinDir()).toBe(path.join(tmpRoot, "bin"));
    expect(mockExecFileSync).toHaveBeenCalledWith("npm", ["prefix", "-g"], expect.anything());
  });

  it("is null when npm cannot be asked", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not found");
    });

    expect(npmGlobalBinDir()).toBeNull();
  });
});
