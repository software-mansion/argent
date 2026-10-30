import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const { mockExecFileSync, mockAccessSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockAccessSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFileSync: mockExecFileSync }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  mockAccessSync.mockImplementation(actual.accessSync);
  return { ...actual, accessSync: mockAccessSync };
});

import {
  isNixStorePath,
  probeGlobalInstallTarget,
  unwritableGlobalTargetMessage,
} from "../src/global-prefix.js";

// Root bypasses mode bits, and Windows is never probed.
const canTestUnwritable = process.platform !== "win32" && process.getuid?.() !== 0;

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

  it("kills a query that outlives its timeout instead of waiting on it", () => {
    mockExecFileSync.mockReturnValue(`${tmpRoot}\n`);

    probeGlobalInstallTarget("npm");

    expect(mockExecFileSync).toHaveBeenCalledWith(
      "npm",
      ["root", "-g"],
      expect.objectContaining({ timeout: 5_000, killSignal: "SIGKILL" })
    );
  });

  it("reports a writable directory as writable", () => {
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

  it.each(["EACCES", "EPERM", "EROFS"])("treats %s from the write probe as blocked", (code) => {
    mockExecFileSync.mockReturnValue(`${tmpRoot}\n`);
    mockAccessSync.mockImplementationOnce(() => {
      throw Object.assign(new Error(code), { code });
    });

    expect(probeGlobalInstallTarget("npm")?.blocked).toBe(true);
  });

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

  it("probes the global root while the @swmansion scope directory does not exist", () => {
    const globalRoot = path.join(tmpRoot, "lib", "node_modules");
    fs.mkdirSync(globalRoot, { recursive: true });
    mockExecFileSync.mockReturnValue(`${globalRoot}\n`);

    expect(probeGlobalInstallTarget("npm")?.dir).toBe(globalRoot);
  });

  it.skipIf(!canTestUnwritable)(
    "blocks on a read-only @swmansion scope directory under a writable root",
    () => {
      const globalRoot = path.join(tmpRoot, "lib", "node_modules");
      const scopeDir = path.join(globalRoot, "@swmansion");
      fs.mkdirSync(scopeDir, { recursive: true });
      fs.chmodSync(scopeDir, 0o555);
      mockExecFileSync.mockReturnValue(`${globalRoot}\n`);

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

  it.skipIf(!canTestUnwritable)(
    "blocks on a read-only package directory under a writable scope directory",
    () => {
      const globalRoot = path.join(tmpRoot, "lib", "node_modules");
      const packageDir = path.join(globalRoot, "@swmansion", "argent");
      fs.mkdirSync(packageDir, { recursive: true });
      fs.chmodSync(packageDir, 0o555);
      mockExecFileSync.mockReturnValue(`${globalRoot}\n`);

      try {
        expect(probeGlobalInstallTarget("npm")).toEqual({
          dir: packageDir,
          blocked: true,
          nixStore: false,
        });
      } finally {
        fs.chmodSync(packageDir, 0o755);
      }
    }
  );

  it.skipIf(!canTestUnwritable)("does not probe through a symlinked package directory", () => {
    const globalRoot = path.join(tmpRoot, "lib", "node_modules");
    const linkTarget = path.join(tmpRoot, "linked-argent");
    fs.mkdirSync(path.join(globalRoot, "@swmansion"), { recursive: true });
    fs.mkdirSync(linkTarget);
    fs.chmodSync(linkTarget, 0o555);
    fs.symlinkSync(linkTarget, path.join(globalRoot, "@swmansion", "argent"));
    mockExecFileSync.mockReturnValue(`${globalRoot}\n`);

    try {
      expect(probeGlobalInstallTarget("npm")?.blocked).toBe(false);
    } finally {
      fs.chmodSync(linkTarget, 0o755);
    }
  });

  it.skipIf(!canTestUnwritable)("flags a blocked directory inside the Nix store", () => {
    const storeDir = path.join(tmpRoot, "nix", "store");
    const globalRoot = path.join(storeDir, "abc123-nodejs-22", "lib", "node_modules");
    fs.mkdirSync(globalRoot, { recursive: true });
    fs.chmodSync(globalRoot, 0o555);
    mockExecFileSync.mockReturnValue(`${globalRoot}\n`);
    vi.stubEnv("NIX_STORE_DIR", storeDir);

    try {
      expect(probeGlobalInstallTarget("npm")).toEqual({
        dir: globalRoot,
        blocked: true,
        nixStore: true,
      });
    } finally {
      vi.unstubAllEnvs();
      fs.chmodSync(globalRoot, 0o755);
    }
  });

  it("returns null when the manager query fails", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("npm not found");
    });

    expect(probeGlobalInstallTarget("npm")).toBeNull();
  });

  it("ignores a relative path from the manager rather than resolving it against cwd", () => {
    mockExecFileSync.mockReturnValue("lib/node_modules\n");

    expect(probeGlobalInstallTarget("npm")).toBeNull();
  });

  it.skipIf(!canTestUnwritable)("ignores a path npm printed with a redacted segment", () => {
    // Probing `***`'s nearest existing ancestor would judge this read-only dir.
    fs.chmodSync(tmpRoot, 0o555);
    mockExecFileSync.mockReturnValue(`${path.join(tmpRoot, "***", "lib", "node_modules")}\n`);

    expect(probeGlobalInstallTarget("npm")).toBeNull();
  });
});

describe("isNixStorePath", () => {
  it("recognizes the default store and rejects lookalike prefixes", () => {
    expect(isNixStorePath("/nix/store/abc123-nodejs-22.16.0/lib/node_modules")).toBe(true);
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

  it("resolves symlinks in the store path", () => {
    const realStore = path.join(tmpRoot, "nix", "store");
    fs.mkdirSync(realStore, { recursive: true });
    fs.symlinkSync(path.join(tmpRoot, "nix"), path.join(tmpRoot, "nixlink"));
    fs.symlinkSync(realStore, path.join(tmpRoot, "npm-global"));
    vi.stubEnv("NIX_STORE_DIR", path.join(tmpRoot, "nixlink", "store"));
    try {
      expect(isNixStorePath(realStore)).toBe(true);
      expect(isNixStorePath(path.join(tmpRoot, "npm-global"))).toBe(true);
    } finally {
      vi.unstubAllEnvs();
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

  it("names the Nix store, warns off sudo, and offers the per-project install", () => {
    const message = plain(unwritableGlobalTargetMessage(nixTarget, "npm", "update"));

    expect(message).toContain("cannot update @swmansion/argent globally");
    expect(message).toContain("read-only Nix store");
    expect(message).toContain(nixTarget.dir);
    expect(message).toContain("do not install into them with sudo");
    expect(message).toContain("argent init --local");
  });

  it("prints the per-project command it is given", () => {
    expect(
      plain(
        unwritableGlobalTargetMessage(
          nixTarget,
          "npm",
          "install",
          "npx @swmansion/argent init --local"
        )
      )
    ).toContain("    npx @swmansion/argent init --local");
  });

  it("offers the writable-prefix fix for npm only", () => {
    expect(plain(unwritableGlobalTargetMessage(nixTarget, "npm", "install"))).toContain(
      'npm config set prefix "$HOME/.npm-global"'
    );
    expect(plain(unwritableGlobalTargetMessage(nixTarget, "pnpm", "install"))).not.toContain(
      "config set prefix"
    );
  });

  it("does not blame Nix for an ordinary unwritable prefix", () => {
    const message = plain(unwritableGlobalTargetMessage(plainTarget, "npm", "install"));

    expect(message).toContain("not writable by this user");
    expect(message).not.toContain("Nix");
    expect(message).toContain("cannot install @swmansion/argent globally");
  });
});
