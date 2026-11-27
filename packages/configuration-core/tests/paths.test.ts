import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { argentHomeDir, configFilePath, isHomeDir } from "../src/paths.js";
import { getFlagsPath } from "../src/flags.js";
import { secretSources } from "../src/secrets.js";

let homeDir: string;
let linkedHome: string;
let otherDir: string;

beforeEach(() => {
  homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-home-")));
  otherDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-other-")));
  linkedHome = path.join(otherDir, "home");
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.rmSync(otherDir, { recursive: true, force: true });
});

describe("isHomeDir", () => {
  it("matches home and nothing else", () => {
    expect(isHomeDir(homeDir, { homeDir })).toBe(true);
    expect(isHomeDir(`${homeDir}${path.sep}`, { homeDir })).toBe(true);
    expect(isHomeDir(otherDir, { homeDir })).toBe(false);
    expect(isHomeDir(path.join(homeDir, "missing"), { homeDir })).toBe(false);
  });

  it("compares resolved paths when neither side exists", () => {
    const missing = path.join(homeDir, "missing");
    expect(isHomeDir(missing, { homeDir: `${missing}${path.sep}` })).toBe(true);
  });

  it("compares the filesystem's canonical spelling of both sides", () => {
    // A case-insensitive filesystem whose on-disk names are lowercase.
    const native = vi
      .spyOn(fs.realpathSync, "native")
      .mockImplementation(((p: fs.PathLike) =>
        String(p).toLowerCase()) as typeof fs.realpathSync.native);
    try {
      expect(isHomeDir("/Users/Foo", { homeDir: "/users/foo" })).toBe(true);
    } finally {
      native.mockRestore();
    }
  });

  it.skipIf(!fs.existsSync(os.tmpdir().toUpperCase()))(
    "matches home spelled in a different case on a case-insensitive filesystem",
    () => {
      expect(isHomeDir(homeDir, { homeDir: homeDir.toUpperCase() })).toBe(true);
      expect(isHomeDir(homeDir.toUpperCase(), { homeDir })).toBe(true);
    }
  );

  it.skipIf(process.platform === "win32")("matches home through a symlink on either side", () => {
    fs.symlinkSync(homeDir, linkedHome);
    expect(isHomeDir(homeDir, { homeDir: linkedHome })).toBe(true);
    expect(isHomeDir(linkedHome, { homeDir })).toBe(true);
  });
});

describe("argentHomeDir", () => {
  beforeEach(() => {
    vi.stubEnv("HOME", homeDir);
    vi.stubEnv("USERPROFILE", homeDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is ~/.argent when ARGENT_HOME_DIR is unset or blank", () => {
    vi.stubEnv("ARGENT_HOME_DIR", undefined);
    expect(argentHomeDir()).toBe(path.join(homeDir, ".argent"));
    vi.stubEnv("ARGENT_HOME_DIR", "  ");
    expect(argentHomeDir()).toBe(path.join(homeDir, ".argent"));
  });

  it("moves every global file to ARGENT_HOME_DIR", () => {
    const relocated = path.join(otherDir, "state");
    vi.stubEnv("ARGENT_HOME_DIR", relocated);
    expect(argentHomeDir()).toBe(relocated);
    expect(configFilePath("global")).toBe(path.join(relocated, "config.json"));
    expect(getFlagsPath("global")).toBe(path.join(relocated, "flags.json"));
    expect(secretSources({ cwd: otherDir }).map((s) => s.label)).toContain(
      path.join(relocated, "secrets.env")
    );
  });

  it("resolves a relative ARGENT_HOME_DIR against the working directory", () => {
    vi.stubEnv("ARGENT_HOME_DIR", "state");
    expect(argentHomeDir()).toBe(path.resolve("state"));
  });

  it("lets an explicit homeDir option win over ARGENT_HOME_DIR", () => {
    vi.stubEnv("ARGENT_HOME_DIR", path.join(otherDir, "state"));
    expect(argentHomeDir({ homeDir: otherDir })).toBe(path.join(otherDir, ".argent"));
    expect(getFlagsPath("global", { homeDir: otherDir })).toBe(
      path.join(otherDir, ".argent", "flags.json")
    );
  });
});
