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

  it("uses the host fingerprint verbatim as the id on a fresh install", () => {
    const id = readOrCreateAnonId(() => FP);
    expect(id).toBe(FP);
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
    expect(id).toBe(FP);
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

  it("skips the resolver entirely when a fingerprint id is already stored", () => {
    // Steady state after the first run: the 64-hex id on disk is self-describing,
    // so readOrCreateAnonId returns it WITHOUT spawning the fingerprint binary
    // (the resolver stands in for that subprocess). This is the per-run-spawn fix
    // — a short-lived CLI command must not pay the ~150ms fingerprint cost when
    // the stable id is already persisted.
    fs.mkdirSync(`${tmp()}/.argent`, { recursive: true });
    fs.writeFileSync(identityFilePath(), FP, { mode: 0o600 });
    const resolver = vi.fn(() => FP);
    expect(readOrCreateAnonId(resolver)).toBe(FP);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("does not fast-path a non-canonical (upper-case) stored 64-hex id — resolves and rewrites", () => {
    // Our writers only persist lower-case, so an upper-case 64-hex value is an
    // external write. It must not be served verbatim forever: the resolve path
    // runs and rewrites the file to the canonical lower-case fingerprint.
    fs.mkdirSync(`${tmp()}/.argent`, { recursive: true });
    fs.writeFileSync(identityFilePath(), "A".repeat(64), { mode: 0o600 });
    const resolver = vi.fn(() => FP);
    expect(readOrCreateAnonId(resolver)).toBe(FP);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(identityFilePath(), "utf8").trim()).toBe(FP);
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
    expect(id).toBe(FP);
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

  it("converges on the deterministic id across independent resolves (idempotent migration)", async () => {
    // readOrCreateAnonId is synchronous and memoizes via the module-level cache,
    // so two Promise.resolve().then() calls would run serially and the second
    // would trivially hit the cache without re-entering the migration path.
    // Clear the cache between resolves so the second genuinely re-runs the
    // migration decision as a separate process would, and spy on renameSync to
    // prove the second resolve — seeing the fingerprint already stored — does NOT
    // rewrite. The deterministic fingerprint value is exactly what makes
    // concurrent migrators converge, so an independent second resolve must land
    // on the same id.
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
      const a = mod.readOrCreateAnonId(() => FP);
      expect(a).toBe(FP);
      expect(renameCount).toBe(1); // first resolve migrates the legacy id
      mod._resetIdentityCacheForTest();
      const b = mod.readOrCreateAnonId(() => FP);
      expect(b).toBe(a); // converges on the same deterministic id
      expect(renameCount).toBe(1); // idempotent: no second rewrite
      expect(fs.readFileSync(identityFilePath(), "utf8").trim()).toBe(a);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
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
      // Never throws, returns the deterministic fingerprint id...
      expect(id).toBe(FP);
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

  it("self-heals a corrupt file by claiming it aside, never unlinking the id path by name", async () => {
    // Regression guard for the concurrent-self-heal clobber: with no fingerprint
    // and a corrupt file squatting the path, the first mutation on the id path
    // MUST be the no-overwrite link() (so a valid id a racer published is adopted
    // on EEXIST), and the corrupt occupant must be cleared by CLAIMING it aside
    // (atomic rename → private temp), NEVER by unlinking finalPath by name (which
    // is a TOCTOU that would delete a racer's valid id and split one machine into
    // two distinct_ids).
    fs.mkdirSync(`${tmp()}/.argent`, { recursive: true });
    fs.writeFileSync(identityFilePath(), "", { mode: 0o644 }); // corrupt: empty

    const ops: string[] = [];
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      const idPath = identityFilePath();
      return {
        ...actual,
        linkSync: vi.fn((existing: fs.PathLike, target: fs.PathLike) => {
          if (String(target) === idPath) ops.push("link");
          return actual.linkSync(existing, target);
        }),
        renameSync: vi.fn((oldPath: fs.PathLike, newPath: fs.PathLike) => {
          if (String(oldPath) === idPath) ops.push("rename"); // claim the occupant aside
          return actual.renameSync(oldPath, newPath);
        }),
        unlinkSync: vi.fn((p: fs.PathLike) => {
          if (String(p) === idPath) ops.push("unlink-idpath"); // must never happen
          return actual.unlinkSync(p);
        }),
      };
    });
    try {
      const mod = await import("../src/identity.js");
      const id = mod.readOrCreateAnonId(() => null);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(versionNibble(id)).toBe("4");
      // The first id-path mutation is a link (adopt-the-winner), not a removal.
      expect(ops[0]).toBe("link");
      // The id path is NEVER unlinked by name — the corrupt file is claimed aside.
      expect(ops).not.toContain("unlink-idpath");
      // The occupant is cleared by an atomic rename aside, after the link collided.
      expect(ops).toContain("rename");
      expect(ops.indexOf("link")).toBeLessThan(ops.indexOf("rename"));
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("adopts a valid id a racer publishes into the corrupt-heal gap (converges, never clobbers)", async () => {
    // Direct reproduction of the two-minter split (F1): no fingerprint, a corrupt
    // file squats the path, and a racer publishes a VALID id into the gap between
    // the corrupt-check and the claim. The claim renames whatever is at the path
    // right now — so it grabs the racer's valid id and the code must ADOPT it
    // (return + persist it), never mint a fresh random over it. Under an
    // unlink-by-name heal the racer's id would be destroyed and this machine would
    // report a different distinct_id.
    const RACER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    fs.mkdirSync(`${tmp()}/.argent`, { recursive: true });
    fs.writeFileSync(identityFilePath(), "", { mode: 0o644 }); // corrupt: empty

    let injected = false;
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      const idPath = identityFilePath();
      return {
        ...actual,
        renameSync: vi.fn((oldPath: fs.PathLike, newPath: fs.PathLike) => {
          // Just before the claim renames the occupant aside, a racer publishes a
          // valid id into the gap — the claim must relocate (and adopt) THAT.
          if (!injected && String(oldPath) === idPath) {
            injected = true;
            actual.writeFileSync(idPath, RACER_ID, { mode: 0o600 });
          }
          return actual.renameSync(oldPath, newPath);
        }),
      };
    });
    try {
      const mod = await import("../src/identity.js");
      const id = mod.readOrCreateAnonId(() => null);
      expect(injected).toBe(true); // the racer did publish into the gap
      expect(id).toBe(RACER_ID); // adopted the racer's valid id, did not clobber it
      expect(fs.readFileSync(identityFilePath(), "utf8").trim()).toBe(RACER_ID);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });
});
