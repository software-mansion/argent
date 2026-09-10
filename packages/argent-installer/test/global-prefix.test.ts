import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const { mockExecFileSync, mockExecSync, mockAccessSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  // `which -a argent`, behind topology's getGlobalBinaryPath. Undefined output
  // is what "not on PATH" looks like from there.
  mockExecSync: vi.fn(),
  mockAccessSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: mockExecFileSync,
  execSync: mockExecSync,
}));

// The real one, past the mock above: a printed shell command is only proven by a
// shell parsing it.
const { execFileSync: realExecFileSync } =
  await vi.importActual<typeof import("node:child_process")>("node:child_process");

// Real fs everywhere except accessSync, whose errno is the whole verdict and
// whose interesting values (a read-only mount) no chmod can produce.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  mockAccessSync.mockImplementation(actual.accessSync);
  return { ...actual, accessSync: mockAccessSync };
});

import {
  blockedGlobalInstallMessage,
  blockedGlobalTargetCause,
  canRecoverBlockedGlobal,
  forgetInheritedNpmPrefix,
  isNixStorePath,
  ownershipRemedy,
  globalInstallPresent,
  npmGlobalPackageRoot,
  blockedGlobalBinDir,
  npmGlobalBinDir,
  npmGlobalPackagePath,
  unwritableGlobalBinMessage,
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
      root: tmpRoot,
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
          // What npm named, which is one level above the directory that blocks.
          root: globalDir,
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

  // The fallback exists for one npm-specific failure: npm masks UUID-shaped
  // segments as `***`, leaving both its queries unusable. Every other manager's
  // query fails because its global directory was never set up, and answering
  // that with the directory npm installed into names one it never writes to.
  it("does not answer for a manager whose own query failed", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("No package.json was found for the global directory");
    });
    const packageDir = path.join(tmpRoot, "lib", "node_modules", "@swmansion", "argent");
    fs.mkdirSync(packageDir, { recursive: true });

    expect(probeGlobalInstallTarget("bun", packageDir)).toBeNull();
    expect(probeGlobalInstallTarget("pnpm", packageDir)).toBeNull();
    expect(probeGlobalInstallTarget("yarn", packageDir)).toBeNull();
    expect(probeGlobalInstallTarget("npm", packageDir)).not.toBeNull();
  });

  // Every other nixStore assertion in this file is a hand-written literal, so
  // without this one the whole flag could be hardcoded false and nothing here
  // would notice — losing the store cause, the note that rules out sudo, and the
  // suppression of a chown the next rebuild undoes.
  it("reports a global directory inside the store as one", () => {
    const store = path.join(tmpRoot, "store");
    const globalDir = path.join(store, "aaaa-nodejs", "lib", "node_modules");
    fs.mkdirSync(globalDir, { recursive: true });
    mockExecFileSync.mockReturnValue(`${globalDir}\n`);
    const previous = process.env.NIX_STORE_DIR;
    process.env.NIX_STORE_DIR = store;

    try {
      expect(probeGlobalInstallTarget("npm")).toMatchObject({ dir: globalDir, nixStore: true });
    } finally {
      if (previous === undefined) delete process.env.NIX_STORE_DIR;
      else process.env.NIX_STORE_DIR = previous;
    }
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
      { timeout: number; stdio: string[]; killSignal: string },
    ];
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.stdio).toEqual(["ignore", "pipe", "ignore"]);
    // Without it the timeout is not one: execFileSync sends killSignal and then
    // blocks until the child exits, so a manager that traps the default SIGTERM
    // holds the run open for as long as it likes.
    expect(options.killSignal).toBe("SIGKILL");
  });

  it("ignores a relative path from the manager rather than resolving it against cwd", () => {
    mockExecFileSync.mockReturnValue("lib/node_modules\n");

    expect(probeGlobalInstallTarget("npm")).toBeNull();
  });
});

describe("canRecoverBlockedGlobal", () => {
  const elsewhere = "/usr/local/lib/node_modules";
  const alreadySuggested = path.join(os.homedir(), ".npm-global", "lib", "node_modules");

  it("has something to carry out for npm, whether or not a project can hold it", () => {
    expect(canRecoverBlockedGlobal("npm", true, elsewhere)).toBe(true);
    expect(canRecoverBlockedGlobal("npm", false, elsewhere)).toBe(true);
  });

  it("falls back to the project install for a manager argent cannot relocate", () => {
    expect(canRecoverBlockedGlobal("pnpm", true, elsewhere)).toBe(true);
    expect(canRecoverBlockedGlobal("yarn", true, elsewhere)).toBe(true);
    expect(canRecoverBlockedGlobal("bun", true, elsewhere)).toBe(true);
  });

  // Nothing to move and nothing to install into: a prompt here would offer one
  // option that fails and "Cancel".
  it("has nothing to offer without npm's prefix or a package.json", () => {
    expect(canRecoverBlockedGlobal("pnpm", false, elsewhere)).toBe(false);
    expect(canRecoverBlockedGlobal("yarn", false, elsewhere)).toBe(false);
    expect(canRecoverBlockedGlobal("bun", false, elsewhere)).toBe(false);
  });

  // The move that would be offered is the one npm already made.
  it("has nothing to offer where npm is already pointed at the suggested prefix", () => {
    expect(canRecoverBlockedGlobal("npm", false, alreadySuggested)).toBe(false);
    expect(canRecoverBlockedGlobal("npm", true, alreadySuggested)).toBe(true);
  });

  it("still offers the move for a prefix that merely starts like the suggested one", () => {
    expect(
      canRecoverBlockedGlobal("npm", false, `${path.join(os.homedir(), ".npm-global")}-old/lib`)
    ).toBe(true);
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
    root: "/nix/store/abc-nodejs-22.16.0/lib/node_modules",
    blocked: true,
    nixStore: true,
  };
  const plainTarget = {
    dir: "/usr/local/lib/node_modules",
    root: "/usr/local/lib/node_modules",
    blocked: true,
    nixStore: false,
  };
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

  // A home-manager `~/.npm-global/bin` symlinked into the store passes the
  // under-home check, and the chown Nix undoes at the next rebuild is the one
  // piece of advice the store rules out.
  it("never offers ownership of a bin directory inside the store", () => {
    const storeBin = "/nix/store/abc-nodejs-22.16.0/lib/node_modules/.bin";

    const message = plain(
      unwritableGlobalTargetMessage(plainTarget, "npm", "install", installed, storeBin)
    );

    expect(message).toContain(storeBin);
    expect(message).not.toContain(`chown -R $(whoami) '${storeBin}'`);
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

    expect(message).toContain(`sudo chown -R $(whoami) '${plainTarget.dir}'`);
  });

  // The reader pastes this line, and the directory came from the probe rather
  // than from them, so every character their shell would otherwise act on has to
  // survive it — while `$(whoami)` stays live, which is the point of quoting the
  // argument rather than the command.
  it.each([
    ["spaces", "/Users/dev/Application Support/lib/node_modules/@swmansion"],
    ["an apostrophe", "/Users/o'brien/.npm-global/lib/node_modules/@swmansion"],
    ["a dollar sign", "/Users/dev/d$TMPDIR-npm/lib/node_modules/@swmansion"],
    ["a backtick", "/Users/dev/a`id`/lib/node_modules/@swmansion"],
    ["a backslash", "/Users/dev/back\\slash/lib/node_modules/@swmansion"],
  ])("quotes a blocked directory whose path has %s", (_label, dir) => {
    const target = { dir, root: dir, blocked: true, nixStore: false };
    const message = plain(unwritableGlobalTargetMessage(target, "npm", "install", installed));
    const chown = message.split("\n").find((line) => line.includes("chown"))!;

    expect(chown).toContain("$(whoami)");
    // Round-tripped through a real shell: what the reader pastes has to resolve
    // to the directory they were shown, not to a fragment of it or to whatever
    // an expansion produced.
    const echoed = chown.trim().replace("sudo chown -R $(whoami)", "printf %s");
    expect(realExecFileSync("/bin/sh", ["-c", echoed], { encoding: "utf8" })).toBe(dir);
  });

  it("never offers to chown its way out of a shared directory above the tree", () => {
    // The probe reports the nearest EXISTING ancestor, so a prefix whose
    // lib/node_modules has not been created yet lands on the prefix itself.
    const aboveTree = {
      dir: "/usr/local",
      root: "/usr/local/lib/node_modules",
      blocked: true,
      nixStore: false,
    };

    expect(
      plain(unwritableGlobalTargetMessage(aboveTree, "npm", "install", installed))
    ).not.toContain("chown");
  });

  // `yarn global dir` names `~/.config/yarn/global`, which yarn does not create
  // until something is installed — so the probe walks up to `~/.config`, a
  // directory under the home directory and therefore one the breadth rule alone
  // would happily hand to `chown -R`.
  it("never offers to chown an ancestor the manager did not name", () => {
    const aboveYarnsOwn = {
      dir: path.join(os.homedir(), ".config"),
      root: path.join(os.homedir(), ".config", "yarn", "global"),
      blocked: true,
      nixStore: false,
    };

    expect(
      plain(unwritableGlobalTargetMessage(aboveYarnsOwn, "yarn", "install", installed))
    ).not.toContain("chown");
  });

  it("never offers to chown the whole home directory", () => {
    const home = { dir: os.homedir(), root: os.homedir(), blocked: true, nixStore: false };

    expect(plain(unwritableGlobalTargetMessage(home, "yarn", "install", installed))).not.toContain(
      "chown"
    );
  });

  it("offers it for a global directory that is not a node_modules tree", () => {
    // yarn and bun answer with a directory outside any node_modules — the one
    // `sudo yarn global add` leaves root-owned.
    const yarnGlobal = {
      dir: path.join(os.homedir(), ".config", "yarn", "global"),
      root: path.join(os.homedir(), ".config", "yarn", "global"),
      blocked: true,
      nixStore: false,
    };

    expect(
      plain(unwritableGlobalTargetMessage(yarnGlobal, "yarn", "install", installed))
    ).toContain(`sudo chown -R $(whoami) '${yarnGlobal.dir}'`);
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

  it("declines to answer on Windows", () => {
    // Same reason as the probe: access(W_OK) there reflects only the read-only
    // attribute, so a reading would refuse installs that work.
    if (!canTestUnwritable) return;
    fs.chmodSync(tmpRoot, 0o555);
    const platform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      expect(provenUnwritableDir(path.join(tmpRoot, "bin"))).toBeNull();
    } finally {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
    }
  });

  it("stays silent when the directory cannot be read for some other reason", () => {
    mockAccessSync.mockImplementationOnce(() => {
      throw Object.assign(new Error("EIO"), { code: "EIO" });
    });

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

  it("goes through a shell only on Windows, where npm is a .cmd shim", () => {
    mockExecFileSync.mockReturnValue(`${tmpRoot}\n`);
    npmGlobalBinDir();
    expect(mockExecFileSync).toHaveBeenLastCalledWith(
      "npm",
      expect.anything(),
      expect.objectContaining({ shell: false })
    );

    const platform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      npmGlobalBinDir();
      expect(mockExecFileSync).toHaveBeenLastCalledWith(
        "npm",
        expect.anything(),
        expect.objectContaining({ shell: true })
      );
    } finally {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
    }
  });

  it("names the prefix itself on Windows, where npm puts the shims", () => {
    mockExecFileSync.mockReturnValue(`${tmpRoot}\n`);
    const platform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      expect(npmGlobalBinDir()).toBe(tmpRoot);
    } finally {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
    }
  });
});

describe("a package manager's answer argent cannot use", () => {
  it("ignores a path npm redacted a segment of", () => {
    // npm masks UUID-shaped segments in everything it prints, so a prefix under
    // /tmp/<uuid>/… comes back with *** where the segment was. Measured on npm
    // 11.19.0. Acting on it names a directory that does not exist, which reads
    // as "npm holds nothing here" — a removal that worked reported as failed.
    mockExecFileSync.mockReturnValue("/private/tmp/scratch/***/prefix\n");

    expect(npmGlobalBinDir()).toBeNull();
    expect(npmGlobalPackagePath()).toBeNull();
    expect(probeGlobalInstallTarget("npm")).toBeNull();
  });

  // The one failure the npm fallback exists for, and the shape it really takes:
  // npm exits 0 and its answer is unusable, so the copy on disk is all that is
  // left. A query that throws is a different, rarer path.
  it("falls back to the installed package when npm redacted its own prefix", () => {
    mockExecFileSync.mockReturnValue("/private/tmp/scratch/***/prefix\n");
    const packageDir = path.join(tmpRoot, "lib", "node_modules", "@swmansion", "argent");
    fs.mkdirSync(packageDir, { recursive: true });

    expect(probeGlobalInstallTarget("npm", packageDir)?.dir).toBe(path.dirname(packageDir));
  });
});

describe("ownershipRemedy", () => {
  const home = os.homedir();
  const chownLine = (text: string | null): string | null =>
    text === null ? null : plain(text).split("\n")[1].trim();

  it("offers the chown for the scope directory an earlier sudo install left behind", () => {
    const dir = path.join(home, ".npm-global", "lib", "node_modules", "@swmansion");

    expect(chownLine(ownershipRemedy(dir, path.dirname(dir)))).toBe(
      `sudo chown -R $(whoami) '${dir}'`
    );
  });

  // A probe reports the nearest EXISTING ancestor, so a manager that has never
  // created its global directory reports one above it. `~/.config` is what a
  // `yarn global dir` yarn never made walks up to, and it holds every other
  // program's configuration.
  it("refuses a directory the manager merely needs to exist, above the one it named", () => {
    const dir = path.join(home, ".config");
    const root = path.join(dir, "yarn", "global");

    expect(ownershipRemedy(dir, root)).toBeNull();
  });

  it("refuses the home directory itself", () => {
    expect(ownershipRemedy(home, home)).toBeNull();
  });

  // Shared with every other command on the machine.
  it("refuses a system directory outside any node_modules tree", () => {
    expect(ownershipRemedy("/usr/local/bin", "/usr/local/bin")).toBeNull();
  });
});

describe("npmGlobalPackageRoot", () => {
  /** What `npm root -g` names, with argent installed under it. */
  const installGlobally = (manifest: unknown): string => {
    const globalDir = path.join(tmpRoot, "lib", "node_modules");
    const packageDir = path.join(globalDir, "@swmansion", "argent");
    fs.mkdirSync(packageDir, { recursive: true });
    if (manifest !== null) {
      fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify(manifest));
    }
    mockExecFileSync.mockReturnValue(`${globalDir}\n`);
    return packageDir;
  };

  it("names the directory npm holds argent in", () => {
    const packageDir = installGlobally({ name: "@swmansion/argent", version: "0.24.0" });

    expect(npmGlobalPackageRoot()).toBe(fs.realpathSync(packageDir));
  });

  it("follows the link npm made, so the answer is the directory that has the files", () => {
    const globalDir = path.join(tmpRoot, "lib", "node_modules");
    const real = path.join(tmpRoot, "store", "argent");
    fs.mkdirSync(path.join(globalDir, "@swmansion"), { recursive: true });
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(
      path.join(real, "package.json"),
      JSON.stringify({ name: "@swmansion/argent" })
    );
    fs.symlinkSync(real, path.join(globalDir, "@swmansion", "argent"));
    mockExecFileSync.mockReturnValue(`${globalDir}\n`);

    expect(npmGlobalPackageRoot()).toBe(fs.realpathSync(real));
  });

  // A half-removed directory is not an install. Counting one answers "is argent
  // still here" with yes forever.
  it("does not count a leftover directory with no manifest", () => {
    installGlobally(null);

    expect(npmGlobalPackageRoot()).toBeNull();
  });

  it("does not count a directory holding some other package", () => {
    installGlobally({ name: "@swmansion/something-else", version: "1.0.0" });

    expect(npmGlobalPackageRoot()).toBeNull();
  });

  it("is null when npm cannot be asked", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("npm not found");
    });

    expect(npmGlobalPackageRoot()).toBeNull();
  });
});

describe("globalInstallPresent", () => {
  // The state the prefix recovery leaves behind: npm installed it, and no shell
  // knows about the bin directory yet.
  it("counts an install npm holds that PATH cannot see", () => {
    const globalDir = path.join(tmpRoot, "lib", "node_modules");
    const packageDir = path.join(globalDir, "@swmansion", "argent");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "@swmansion/argent" })
    );
    mockExecFileSync.mockReturnValue(`${globalDir}\n`);
    mockExecSync.mockImplementation(() => {
      throw new Error("argent not found");
    });

    expect(globalInstallPresent()).toBe(true);
  });

  it("counts an install only PATH can see", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("npm not found");
    });
    mockExecSync.mockReturnValue("/usr/local/bin/argent\n");

    expect(globalInstallPresent()).toBe(true);
  });

  it("is false when neither PATH nor npm has one", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("npm not found");
    });
    mockExecSync.mockImplementation(() => {
      throw new Error("argent not found");
    });

    expect(globalInstallPresent()).toBe(false);
  });
});

describe("blockedGlobalBinDir", () => {
  it("names npm's bin directory when it is proven unwritable", () => {
    if (!canTestUnwritable) return;
    fs.chmodSync(tmpRoot, 0o555);
    mockExecFileSync.mockReturnValue(`${tmpRoot}\n`);

    expect(blockedGlobalBinDir("npm")).toBe(tmpRoot);
  });

  it("does not answer for a manager whose bin directory argent cannot name", () => {
    // The query and the message are both npm's; a pnpm install refused on
    // npm's directory would be refused for a directory it never uses.
    fs.chmodSync(tmpRoot, 0o555);
    mockExecFileSync.mockReturnValue(`${tmpRoot}\n`);

    expect(blockedGlobalBinDir("pnpm")).toBeNull();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});

describe("unwritableGlobalBinMessage", () => {
  const ctx = { localViable: true, argentOnPath: false };

  it("leads with the prefix move, unless the run just made one", () => {
    const dir = "/opt/shared/bin";

    expect(plain(unwritableGlobalBinMessage(dir, "install", ctx, false))).toContain(
      "npm config set prefix"
    );
    expect(plain(unwritableGlobalBinMessage(dir, "install", ctx, true))).not.toContain(
      "npm config set prefix"
    );
  });

  it("never offers to chown a store path", () => {
    // A node_modules tree, so only the store check can be what rejects it —
    // and Nix undoes the chown at the next rebuild either way.
    const stored = "/nix/store/aaaa-nodejs/lib/node_modules";

    expect(plain(unwritableGlobalBinMessage(stored, "install", ctx, true))).not.toContain("chown");
    expect(
      plain(unwritableGlobalBinMessage("/opt/lib/node_modules", "install", ctx, true))
    ).toContain("chown");
  });

  it("still names a way out when neither the prefix nor ownership applies", () => {
    const message = plain(unwritableGlobalBinMessage("/usr/local/bin", "install", ctx, true));

    expect(message).not.toContain("chown");
    expect(message).toContain("npx @swmansion/argent init --local");
  });
});

const ctxWithProject = { localViable: true, argentOnPath: false };

describe("unwritableGlobalBinMessage — nothing specific left to advise", () => {
  it("falls back to a prefix the reader picks rather than stopping at the cause", () => {
    // Every specific remedy drops out together: the prefix move is the step that
    // just ran, the store rules out chown, and there is no package.json.
    const stored = "/nix/store/aaaa-nodejs/lib/node_modules";
    const message = plain(
      unwritableGlobalBinMessage(
        stored,
        "install",
        { localViable: false, argentOnPath: true },
        true
      )
    );

    expect(message).toContain("it cannot write to");
    expect(message).toContain("a directory you own, outside the store");
    expect(message).not.toContain("chown");
    expect(message.trimEnd()).toBe(message);
  });

  it("says why sudo is not the way out of a store path", () => {
    // Its sibling carries this note for the package directory; without it the
    // chown remedy is simply missing, with nothing saying why.
    const stored = "/nix/store/aaaa-nodejs/lib/node_modules";

    expect(plain(unwritableGlobalBinMessage(stored, "install", ctxWithProject, false))).toContain(
      "Nix owns that directory"
    );
    expect(
      plain(unwritableGlobalBinMessage("/opt/lib/node_modules", "install", ctxWithProject, false))
    ).not.toContain("Nix owns that directory");
  });

  it("keeps the prefix move for a directory that merely starts like the suggested one", () => {
    // ~/.npm-global-old is a different prefix, and moving to the suggested one
    // is exactly what would fix it.
    const sibling = path.join(os.homedir(), ".npm-global-old", "bin");

    expect(plain(unwritableGlobalBinMessage(sibling, "install", ctxWithProject, false))).toContain(
      "npm config set prefix"
    );
    expect(
      plain(
        unwritableGlobalBinMessage(
          path.join(os.homedir(), ".npm-global", "bin"),
          "install",
          ctxWithProject,
          false
        )
      )
    ).not.toContain("npm config set prefix");
  });
});

describe("unwritableGlobalTargetMessage — nothing specific left to advise", () => {
  // npm already pointed at the suggested prefix (so naming it is no advice) and
  // that prefix inside the store (so chown is none either), with no package.json
  // to install into. Every remedy that names a directory drops out, and what is
  // left has to still be an action.
  it("falls back to a prefix the reader picks rather than stopping at the cause", () => {
    const message = plain(
      unwritableGlobalTargetMessage(
        {
          dir: path.join(os.homedir(), ".npm-global", "lib", "node_modules"),
          root: path.join(os.homedir(), ".npm-global", "lib", "node_modules"),
          blocked: true,
          nixStore: true,
        },
        "npm",
        "update",
        { localViable: false, argentOnPath: true }
      )
    );

    expect(message).toContain("read-only Nix store");
    expect(message).toContain("npm config set prefix");
    expect(message).toContain("a directory you own, outside the store");
    expect(message).not.toContain("chown");
    expect(message.trimEnd()).toBe(message);
  });
});

describe("blockedGlobalInstallMessage", () => {
  const ctx = { localViable: true, argentOnPath: false };

  it("reports the package directory when that is the one that is blocked", () => {
    if (!canTestUnwritable) return;
    const root = path.join(tmpRoot, "lib", "node_modules");
    fs.mkdirSync(root, { recursive: true });
    fs.chmodSync(root, 0o555);
    mockExecFileSync.mockImplementation(((_bin: string, args: string[]) =>
      args[0] === "root" ? `${root}\n` : `${tmpRoot}\n`) as never);

    const message = plain(blockedGlobalInstallMessage("npm", null, "install", ctx) ?? "");

    expect(message).toContain("global package directory is not writable");
    fs.chmodSync(root, 0o755);
  });

  it("reports the bin directory when only that one is blocked", () => {
    if (!canTestUnwritable) return;
    const root = path.join(tmpRoot, "lib", "node_modules");
    const bin = path.join(tmpRoot, "bin");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.chmodSync(bin, 0o555);
    mockExecFileSync.mockImplementation(((_bin: string, args: string[]) =>
      args[0] === "root" ? `${root}\n` : `${tmpRoot}\n`) as never);

    const message = plain(blockedGlobalInstallMessage("npm", null, "install", ctx) ?? "");

    expect(message).toContain(`it cannot write to ${bin}`);
    // No prefix move has happened on this path, so the remedy that would fix it
    // is the first thing to say.
    expect(message).toContain("npm config set prefix");
    fs.chmodSync(bin, 0o755);
  });

  // `npm install -g` needs both, so a run blocked on both is told both — acting
  // on the first one otherwise only earns a second failed install on the second.
  it("reports both directories when both are blocked", () => {
    if (!canTestUnwritable) return;
    const root = path.join(tmpRoot, "lib", "node_modules");
    const bin = path.join(tmpRoot, "bin");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.chmodSync(root, 0o555);
    fs.chmodSync(bin, 0o555);
    mockExecFileSync.mockImplementation(((_bin: string, args: string[]) =>
      args[0] === "root" ? `${root}\n` : `${tmpRoot}\n`) as never);

    const message = plain(blockedGlobalInstallMessage("npm", null, "install", ctx) ?? "");

    expect(message).toContain("global package directory is not writable");
    expect(message).toContain(root);
    expect(message).toContain(`command into either:\n  ${bin}`);
    expect(message).toContain(`sudo chown -R $(whoami) '${root}'`);
    fs.chmodSync(root, 0o755);
    fs.chmodSync(bin, 0o755);
  });

  // Both are separate permissions, so both get a way out where one applies —
  // withheld for a `/usr/local/bin` shared with every other command, offered for
  // a prefix the user made themselves.
  it("offers ownership of a blocked bin directory inside the user's own prefix", () => {
    if (!canTestUnwritable) return;
    const prefix = fs.mkdtempSync(path.join(os.homedir(), ".argent-prefix-"));
    const root = path.join(prefix, "lib", "node_modules");
    const bin = path.join(prefix, "bin");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.chmodSync(root, 0o555);
    fs.chmodSync(bin, 0o555);
    mockExecFileSync.mockImplementation(((_bin: string, args: string[]) =>
      args[0] === "root" ? `${root}\n` : `${prefix}\n`) as never);

    try {
      const message = plain(blockedGlobalInstallMessage("npm", null, "install", ctx) ?? "");

      expect(message).toContain(`sudo chown -R $(whoami) '${root}'`);
      expect(message).toContain(`sudo chown -R $(whoami) '${bin}'`);
    } finally {
      fs.chmodSync(root, 0o755);
      fs.chmodSync(bin, 0o755);
      fs.rmSync(prefix, { recursive: true, force: true });
    }
  });

  // Both walks climb to the nearest EXISTING directory, so under a prefix whose
  // `lib/node_modules` and `bin` are yet to be created they land on the prefix
  // itself — one directory, not two.
  it("names one directory once when both walks land on it", () => {
    if (!canTestUnwritable) return;
    const prefix = path.join(tmpRoot, "fresh-prefix");
    fs.mkdirSync(prefix, { recursive: true });
    fs.chmodSync(prefix, 0o555);
    mockExecFileSync.mockImplementation(((_bin: string, args: string[]) =>
      args[0] === "root"
        ? `${path.join(prefix, "lib", "node_modules")}\n`
        : `${prefix}\n`) as never);

    const message = plain(blockedGlobalInstallMessage("npm", null, "install", ctx) ?? "");

    expect(message).toContain("global package directory is not writable");
    expect(message).not.toContain("command into either");
    fs.chmodSync(prefix, 0o755);
  });

  // With npm's prefix unanswerable, the installed package's own path is the only
  // way in: what owns the install is the `node_modules` two segments above it,
  // and ownership of the package directory itself is no remedy for a rename
  // that fails a level up.
  it("takes the ownership remedy from the root above a fallback package path", () => {
    if (!canTestUnwritable) return;
    const scope = path.join(tmpRoot, "lib", "node_modules", "@swmansion");
    fs.mkdirSync(scope, { recursive: true });
    fs.chmodSync(scope, 0o555);
    mockExecFileSync.mockImplementation((() => {
      throw new Error("npm not found");
    }) as never);

    const message = plain(
      blockedGlobalInstallMessage("npm", path.join(scope, "argent"), "install", ctx) ?? ""
    );

    expect(message).toContain(`sudo chown -R $(whoami) '${scope}'`);
    fs.chmodSync(scope, 0o755);
  });

  it("answers null when neither directory is blocked", () => {
    const root = path.join(tmpRoot, "lib", "node_modules");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, "bin"), { recursive: true });
    mockExecFileSync.mockImplementation(((_bin: string, args: string[]) =>
      args[0] === "root" ? `${root}\n` : `${tmpRoot}\n`) as never);

    expect(blockedGlobalInstallMessage("npm", null, "install", ctx)).toBeNull();
  });
});

describe("npmGlobalPackagePath", () => {
  it("names the package inside npm's own global directory", () => {
    mockExecFileSync.mockReturnValue(`${tmpRoot}\n`);

    expect(npmGlobalPackagePath()).toBe(path.join(tmpRoot, "@swmansion/argent"));
    expect(mockExecFileSync).toHaveBeenCalledWith("npm", ["root", "-g"], expect.anything());
  });

  it("is null when npm cannot be asked", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not found");
    });

    expect(npmGlobalPackagePath()).toBeNull();
  });
});

describe("a queried directory whose whole tree is missing", () => {
  // `prefix` under a top-level directory this box does not have. Walking up
  // would otherwise stop at `/`, which is unwritable for any non-root user and
  // would be reported as "its global package directory".
  const gone = "/nonexistent-top-level-dir/npm-global/lib/node_modules";

  it("is inconclusive rather than blocked at the filesystem root", () => {
    mockExecFileSync.mockReturnValue(`${gone}\n`);

    expect(probeGlobalInstallTarget("npm")).toBeNull();
    expect(provenUnwritableDir(gone)).toBeNull();
  });
});
