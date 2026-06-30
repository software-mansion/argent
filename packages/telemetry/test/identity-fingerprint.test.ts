import * as fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { scopeHome } from "./helpers.js";
import { readOrCreateAnonId, deleteAnonId, _resetIdentityCacheForTest } from "../src/identity.js";
import { identityFilePath } from "../src/paths.js";

// A plausible host fingerprint: 64 hex chars, as emitted by
// `simulator-server fingerprint`.
const FP = "a".repeat(64);
const FP_OTHER = "b".repeat(64);
const LEGACY_V4 = "11111111-1111-4111-8111-111111111111";

const versionNibble = (uuid: string) => uuid[14];

describe("identity – fingerprint-derived id", () => {
  const { tmp } = scopeHome();

  it("derives a stable v5 id from the fingerprint on a fresh install", () => {
    const id = readOrCreateAnonId(() => FP);
    expect(versionNibble(id)).toBe("5");
    // Persisted, and re-reading returns the same value.
    expect(fs.readFileSync(identityFilePath(), "utf8").trim()).toBe(id);
    _resetIdentityCacheForTest();
    expect(readOrCreateAnonId(() => FP)).toBe(id);
  });

  it("derives different ids for different fingerprints", () => {
    const id1 = readOrCreateAnonId(() => FP);
    deleteAnonId();
    _resetIdentityCacheForTest();
    const id2 = readOrCreateAnonId(() => FP_OTHER);
    expect(id1).not.toBe(id2);
  });

  it("trims surrounding whitespace before deriving (newline-terminated stdout)", () => {
    const id1 = readOrCreateAnonId(() => FP);
    deleteAnonId();
    _resetIdentityCacheForTest();
    const id2 = readOrCreateAnonId(() => `  ${FP}\n`);
    expect(id2).toBe(id1);
  });

  it("migrates a legacy random id to the fingerprint id (local rewrite)", () => {
    fs.mkdirSync(`${tmp()}/.argent`, { recursive: true });
    fs.writeFileSync(identityFilePath(), LEGACY_V4, { mode: 0o600 });

    const id = readOrCreateAnonId(() => FP);
    expect(id).not.toBe(LEGACY_V4);
    expect(versionNibble(id)).toBe("5");
    // The file on disk was rewritten to the new id.
    expect(fs.readFileSync(identityFilePath(), "utf8").trim()).toBe(id);
    // Mode preserved at 0600.
    expect(fs.lstatSync(identityFilePath()).mode & 0o777).toBe(0o600);
  });

  it("keeps the stored id when the resolver returns null", () => {
    fs.mkdirSync(`${tmp()}/.argent`, { recursive: true });
    fs.writeFileSync(identityFilePath(), LEGACY_V4, { mode: 0o600 });
    expect(readOrCreateAnonId(() => null)).toBe(LEGACY_V4);
    expect(fs.readFileSync(identityFilePath(), "utf8").trim()).toBe(LEGACY_V4);
  });

  it("keeps the stored id when the resolver throws", () => {
    fs.mkdirSync(`${tmp()}/.argent`, { recursive: true });
    fs.writeFileSync(identityFilePath(), LEGACY_V4, { mode: 0o600 });
    expect(
      readOrCreateAnonId(() => {
        throw new Error("binary missing");
      })
    ).toBe(LEGACY_V4);
  });

  it("rejects a non-fingerprint resolver output and keeps the stored id", () => {
    fs.mkdirSync(`${tmp()}/.argent`, { recursive: true });
    fs.writeFileSync(identityFilePath(), LEGACY_V4, { mode: 0o600 });
    // Not hex / too short — an error banner, not a fingerprint.
    expect(readOrCreateAnonId(() => "ERROR: no host available")).toBe(LEGACY_V4);
    expect(fs.readFileSync(identityFilePath(), "utf8").trim()).toBe(LEGACY_V4);
  });

  it("is case-insensitive: an upper-case fingerprint maps to the same id", () => {
    const lower = readOrCreateAnonId(() => FP);
    deleteAnonId();
    _resetIdentityCacheForTest();
    const upper = readOrCreateAnonId(() => "A".repeat(64));
    expect(upper).toBe(lower);
  });

  it("rejects a truncated/wrong-length hex string and keeps the stored id", () => {
    fs.mkdirSync(`${tmp()}/.argent`, { recursive: true });
    fs.writeFileSync(identityFilePath(), LEGACY_V4, { mode: 0o600 });
    // 32 hex (too short), 63 hex (truncated), 65 hex (too long), 16 zeros — none
    // is the 64-hex fingerprint shape, so all fall back to the stored id.
    for (const bogus of ["a".repeat(32), "a".repeat(63), "a".repeat(65), "0".repeat(16)]) {
      _resetIdentityCacheForTest();
      expect(readOrCreateAnonId(() => bogus)).toBe(LEGACY_V4);
    }
  });

  it("invokes the resolver at most once per process (common cached path)", () => {
    const resolver = vi.fn(() => FP);
    const id1 = readOrCreateAnonId(resolver);
    const id2 = readOrCreateAnonId(resolver);
    expect(id1).toBe(id2);
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("self-heals a corrupt id file (no fingerprint) by minting a fresh 0600 random id", () => {
    fs.mkdirSync(`${tmp()}/.argent`, { recursive: true });
    // Empty file with a non-0600 mode: occupies the path but fails the id
    // validator -> corrupt. The self-heal must replace it with a fresh 0600 file.
    fs.writeFileSync(identityFilePath(), "", { mode: 0o644 });
    const id = readOrCreateAnonId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(versionNibble(id)).toBe("4");
    // The corrupt file was overwritten with the new id, at mode 0600.
    expect(fs.readFileSync(identityFilePath(), "utf8").trim()).toBe(id);
    expect(fs.lstatSync(identityFilePath()).mode & 0o777).toBe(0o600);
  });

  it("self-heals a corrupt id file by migrating to the fingerprint id when available", () => {
    fs.mkdirSync(`${tmp()}/.argent`, { recursive: true });
    fs.writeFileSync(identityFilePath(), "garbage-not-a-uuid", { mode: 0o600 });
    const id = readOrCreateAnonId(() => FP);
    expect(versionNibble(id)).toBe("5");
    expect(fs.readFileSync(identityFilePath(), "utf8").trim()).toBe(id);
  });

  it("mints a random (v4) id when no resolver is injected", () => {
    const id = readOrCreateAnonId();
    expect(versionNibble(id)).toBe("4");
  });

  it("mints a random id when the resolver yields nothing and nothing is stored", () => {
    const id = readOrCreateAnonId(() => null);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(versionNibble(id)).toBe("4");
  });

  it("converges on the deterministic id when two migrations race", async () => {
    fs.mkdirSync(`${tmp()}/.argent`, { recursive: true });
    fs.writeFileSync(identityFilePath(), LEGACY_V4, { mode: 0o600 });
    const [a, b] = await Promise.all([
      Promise.resolve().then(() => readOrCreateAnonId(() => FP)),
      Promise.resolve().then(() => readOrCreateAnonId(() => FP)),
    ]);
    expect(a).toBe(b);
    expect(versionNibble(a)).toBe("5");
  });
});

describe("identity – fingerprint migration rewrites", () => {
  const { tmp } = scopeHome();

  it("rewrites the file exactly once and is idempotent across process restarts", async () => {
    fs.mkdirSync(`${tmp()}/.argent`, { recursive: true });
    fs.writeFileSync(identityFilePath(), LEGACY_V4, { mode: 0o600 });

    let renameCount = 0;
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        renameSync: vi.fn((oldPath: fs.PathLike, newPath: fs.PathLike) => {
          renameCount += 1;
          return actual.renameSync(oldPath, newPath);
        }),
      };
    });
    try {
      const mod = await import("../src/identity.js");
      // First run: migrates (one rename).
      const id = mod.readOrCreateAnonId(() => FP);
      expect(renameCount).toBe(1);

      // Simulate a process restart: drop the in-memory cache, stored is now the
      // v5 id, so a second resolve must NOT rewrite.
      mod._resetIdentityCacheForTest();
      const again = mod.readOrCreateAnonId(() => FP);
      expect(again).toBe(id);
      expect(renameCount).toBe(1);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("returns the deterministic id even when persisting the migration fails", async () => {
    fs.mkdirSync(`${tmp()}/.argent`, { recursive: true });
    fs.writeFileSync(identityFilePath(), LEGACY_V4, { mode: 0o600 });

    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        renameSync: vi.fn(() => {
          const err = new Error("read-only filesystem") as NodeJS.ErrnoException;
          err.code = "EROFS";
          throw err;
        }),
      };
    });
    try {
      const mod = await import("../src/identity.js");
      const id = mod.readOrCreateAnonId(() => FP);
      // Never throws, returns the deterministic v5 id...
      expect(id[14]).toBe("5");
      expect(id).not.toBe(LEGACY_V4);
      // ...and is consistent within the process via the in-memory cache.
      expect(mod.readOrCreateAnonId(() => FP)).toBe(id);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("spawns the resolver at most once even when id persistence keeps failing", async () => {
    // No usable fingerprint AND every publish fails -> readOrCreateAnonId throws
    // on every call, but the resolver (a binary spawn in production) must run
    // only once thanks to the fingerprint memoization.
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      const enospc = () => {
        const err = new Error("no space left") as NodeJS.ErrnoException;
        err.code = "ENOSPC";
        throw err;
      };
      return { ...actual, linkSync: vi.fn(enospc), renameSync: vi.fn(enospc) };
    });
    try {
      const mod = await import("../src/identity.js");
      // Returns an invalid (non-64-hex) value, so no id is derived, but the
      // resolver is still invoked the first time.
      const resolver = vi.fn(() => "not-a-fingerprint");
      expect(() => mod.readOrCreateAnonId(resolver)).toThrow();
      expect(() => mod.readOrCreateAnonId(resolver)).toThrow();
      expect(resolver).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });
});
