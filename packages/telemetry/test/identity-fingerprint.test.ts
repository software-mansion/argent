import * as fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { scopeHome } from "./helpers.js";
import {
  readOrCreateAnonId,
  scheduleFingerprintUpgrade,
  warmIdentity,
  deleteAnonId,
  _resetIdentityCacheForTest,
} from "../src/identity.js";
import { identityFilePath } from "../src/paths.js";

// A plausible host fingerprint: 64 hex chars, as emitted by
// `simulator-server fingerprint`.
const FP = "a".repeat(64);
const FP_OTHER = "b".repeat(64);
const LEGACY_V4 = "11111111-1111-4111-8111-111111111111";

const versionNibble = (uuid: string) => uuid[14];

// Drain the background-upgrade promise chain (a few microtask hops plus a
// macrotask), so an assertion can observe its on-disk migration.
const flushUpgrade = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

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

  it("migrates a legacy random id to the fingerprint id via the background upgrade", async () => {
    fs.mkdirSync(`${tmp()}/.argent`, { recursive: true });
    fs.writeFileSync(identityFilePath(), LEGACY_V4, { mode: 0o600 });

    // The synchronous read returns the legacy id immediately — NO blocking spawn,
    // NO sync migration here (sync resolution is reserved for a truly-fresh
    // machine so its first-ever event carries the stable id).
    expect(readOrCreateAnonId(() => FP)).toBe(LEGACY_V4);
    expect(fs.readFileSync(identityFilePath(), "utf8").trim()).toBe(LEGACY_V4);

    // The background upgrade migrates the file to the fingerprint, off the hot
    // path (local rewrite only — no alias/$identify).
    scheduleFingerprintUpgrade(() => Promise.resolve(FP));
    await flushUpgrade();

    expect(fs.readFileSync(identityFilePath(), "utf8").trim()).toBe(FP);
    // Mode preserved at 0600.
    expect(fs.lstatSync(identityFilePath()).mode & 0o777).toBe(0o600);
    // Subsequent reads now serve the fingerprint via the fast path.
    expect(readOrCreateAnonId(() => FP)).toBe(FP);
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

  it("upgrades a non-canonical (upper-case) stored 64-hex id to the canonical fingerprint", async () => {
    // Our writers only persist lower-case, so an upper-case 64-hex value is an
    // external write. It is not canonical, so it falls through the lower-case
    // fast path and is served verbatim (no block); the background upgrade then
    // rewrites the file to the canonical lower-case fingerprint.
    fs.mkdirSync(`${tmp()}/.argent`, { recursive: true });
    fs.writeFileSync(identityFilePath(), "A".repeat(64), { mode: 0o600 });

    expect(readOrCreateAnonId(() => FP)).toBe("A".repeat(64));

    scheduleFingerprintUpgrade(() => Promise.resolve(FP));
    await flushUpgrade();

    expect(fs.readFileSync(identityFilePath(), "utf8").trim()).toBe(FP);
    _resetIdentityCacheForTest();
    expect(readOrCreateAnonId(() => FP)).toBe(FP);
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

  it("converges on the deterministic id across independent upgrades (idempotent migration)", async () => {
    // The migration now happens via the background upgrade. Spy on renameSync to
    // prove the first upgrade rewrites the legacy id exactly once, and a second
    // upgrade — seeing the fingerprint already stored — does NOT rewrite. The
    // deterministic fingerprint value is what makes concurrent migrators converge.
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
      // Sync read returns the legacy id (no migrate); the upgrade migrates it.
      expect(mod.readOrCreateAnonId(() => FP)).toBe(LEGACY_V4);
      expect(renameCount).toBe(0);
      mod.scheduleFingerprintUpgrade(() => Promise.resolve(FP));
      await flushUpgrade();
      expect(renameCount).toBe(1); // first upgrade migrates the legacy id
      expect(mod.readOrCreateAnonId(() => FP)).toBe(FP);

      // A second, independent upgrade (as another process would run) sees the
      // fingerprint already stored and does NOT rewrite.
      mod._resetIdentityCacheForTest();
      mod.scheduleFingerprintUpgrade(() => Promise.resolve(FP));
      await flushUpgrade();
      expect(renameCount).toBe(1); // idempotent: no second rewrite
      expect(fs.readFileSync(identityFilePath(), "utf8").trim()).toBe(FP);
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
      // First run: sync read returns legacy; the background upgrade migrates once.
      expect(mod.readOrCreateAnonId(() => FP)).toBe(LEGACY_V4);
      mod.scheduleFingerprintUpgrade(() => Promise.resolve(FP));
      await flushUpgrade();
      expect(renameCount).toBe(1);
      const id = mod.readOrCreateAnonId(() => FP);
      expect(id).toBe(FP);

      // Simulate a process restart: drop the in-memory cache; stored is now the
      // fingerprint id, so a fresh read serves it (fast path) and the upgrade is
      // a no-op — no second rewrite.
      mod._resetIdentityCacheForTest();
      const again = mod.readOrCreateAnonId(() => FP);
      expect(again).toBe(id);
      mod.scheduleFingerprintUpgrade(() => Promise.resolve(FP));
      await flushUpgrade();
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
      // Sync read returns the legacy fallback (never throws).
      expect(mod.readOrCreateAnonId(() => FP)).toBe(LEGACY_V4);
      // The background upgrade resolves the fingerprint but the on-disk rewrite
      // fails (read-only fs). It must still hold the deterministic id in memory,
      // so subsequent reads are the fingerprint, not the legacy fallback.
      mod.scheduleFingerprintUpgrade(() => Promise.resolve(FP));
      await flushUpgrade();
      const id = mod.readOrCreateAnonId(() => FP);
      expect(id).toBe(FP);
      expect(id).not.toBe(LEGACY_V4);
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

describe("identity – async fingerprint upgrade & recovery (review C1/C2)", () => {
  const { tmp } = scopeHome();

  it("adopts a fingerprint migrated to disk out-of-band, even after caching a fallback", () => {
    // Exact reproduction of the reviewer's C2: a process resolves a fallback first
    // (its resolve threw), caches it, then ANOTHER process writes the fingerprint
    // to the id file. The next read must adopt the fingerprint — a cached fallback
    // is provisional, so we re-read disk instead of serving the fallback forever
    // (which would report the machine under two distinct_ids at once).
    const first = readOrCreateAnonId(() => {
      throw new Error("cold binary");
    });
    expect(versionNibble(first)).toBe("4"); // random v4 fallback
    // A short-lived process migrates the on-disk id to the fingerprint.
    fs.writeFileSync(identityFilePath(), FP, { mode: 0o600 });
    // Same (long-lived) process, next event: adopts the fingerprint from disk
    // WITHOUT re-spawning the binary — a cheap disk read.
    expect(
      readOrCreateAnonId(() => {
        throw new Error("cold binary");
      })
    ).toBe(FP);
  });

  it("recovers a stuck fallback via the background upgrade, with no other process", async () => {
    // Truly-fresh, first (sync) resolve fails transiently -> a random fallback is
    // minted and emitted under. Later the binary is warm; the background upgrade
    // resolves and migrates on its own, so a long-lived process converges without
    // needing another process to migrate the file.
    const fallback = readOrCreateAnonId(() => null);
    expect(versionNibble(fallback)).toBe("4");

    scheduleFingerprintUpgrade(() => Promise.resolve(FP));
    await flushUpgrade();

    expect(fs.readFileSync(identityFilePath(), "utf8").trim()).toBe(FP);
    expect(readOrCreateAnonId(() => null)).toBe(FP);
  });

  it("does not run the async upgrade when a fingerprint id is already stored", async () => {
    fs.mkdirSync(`${tmp()}/.argent`, { recursive: true });
    fs.writeFileSync(identityFilePath(), FP, { mode: 0o600 });
    const asyncResolver = vi.fn(() => Promise.resolve(FP));
    scheduleFingerprintUpgrade(asyncResolver);
    await flushUpgrade();
    expect(asyncResolver).not.toHaveBeenCalled();
  });

  it("is a no-op without an injected async resolver", async () => {
    fs.mkdirSync(`${tmp()}/.argent`, { recursive: true });
    fs.writeFileSync(identityFilePath(), LEGACY_V4, { mode: 0o600 });
    // No resolver -> nothing to spawn; the fallback stays in place, never throws.
    scheduleFingerprintUpgrade();
    await flushUpgrade();
    expect(fs.readFileSync(identityFilePath(), "utf8").trim()).toBe(LEGACY_V4);
  });

  it("swallows an async resolver that rejects and leaves the fallback intact", async () => {
    fs.mkdirSync(`${tmp()}/.argent`, { recursive: true });
    fs.writeFileSync(identityFilePath(), LEGACY_V4, { mode: 0o600 });
    expect(readOrCreateAnonId(() => null)).toBe(LEGACY_V4);
    scheduleFingerprintUpgrade(() => Promise.reject(new Error("spawn failed")));
    await flushUpgrade();
    // Never throws; the fallback id is untouched and a later probe may still win.
    expect(fs.readFileSync(identityFilePath(), "utf8").trim()).toBe(LEGACY_V4);
    expect(readOrCreateAnonId(() => null)).toBe(LEGACY_V4);
  });

  it("runs at most one upgrade probe at a time (in-flight guard, independent of the cooldown)", async () => {
    // Isolate the in-flight guard FROM the cooldown: a probe that never settles
    // holds the in-flight slot; then advance Date PAST the cooldown so the
    // cooldown gate would allow another probe — only the in-flight guard blocks
    // it. (Deleting `if (upgradeInFlight) return;` makes the second call fire a
    // probe → calls === 2.)
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      fs.mkdirSync(`${tmp()}/.argent`, { recursive: true });
      fs.writeFileSync(identityFilePath(), LEGACY_V4, { mode: 0o600 });
      let calls = 0;
      const neverSettles = () => {
        calls += 1;
        return new Promise<string | null>(() => {}); // stays in flight forever
      };
      const drainMicrotasks = async () => {
        for (let i = 0; i < 4; i++) await Promise.resolve();
      };
      scheduleFingerprintUpgrade(neverSettles); // probe 1 takes the in-flight slot
      await drainMicrotasks();
      expect(calls).toBe(1);
      vi.setSystemTime(Date.now() + 61_000); // cooldown elapsed
      scheduleFingerprintUpgrade(neverSettles); // cooldown allows; in-flight must block
      await drainMicrotasks();
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gates back-to-back upgrade probes behind a cooldown (one probe per window)", async () => {
    fs.mkdirSync(`${tmp()}/.argent`, { recursive: true });
    fs.writeFileSync(identityFilePath(), LEGACY_V4, { mode: 0o600 });
    const asyncResolver = vi.fn(() => Promise.resolve(null));
    // Five tracked events in quick succession -> only ONE probe fires; the rest
    // are gated by the cooldown, so a broken binary is not re-spawned per event.
    for (let i = 0; i < 5; i++) {
      scheduleFingerprintUpgrade(asyncResolver);
      await flushUpgrade();
    }
    expect(asyncResolver).toHaveBeenCalledTimes(1);
  });

  it("caps async upgrade attempts so a permanently-broken binary stops re-probing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      fs.mkdirSync(`${tmp()}/.argent`, { recursive: true });
      fs.writeFileSync(identityFilePath(), LEGACY_V4, { mode: 0o600 });
      const asyncResolver = vi.fn(() => Promise.resolve(null));
      // Six events, each past the cooldown window -> capped at 3 attempts.
      for (let i = 0; i < 6; i++) {
        scheduleFingerprintUpgrade(asyncResolver);
        await flushUpgrade();
        vi.setSystemTime(Date.now() + 61_000);
      }
      expect(asyncResolver).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("warmIdentity resolves and persists the fingerprint off the hot path", async () => {
    const id = await warmIdentity(() => Promise.resolve(FP));
    expect(id).toBe(FP);
    expect(fs.readFileSync(identityFilePath(), "utf8").trim()).toBe(FP);
    // A subsequent tracked event finds the fingerprint already on disk (fast path).
    expect(readOrCreateAnonId(() => FP)).toBe(FP);
  });

  it("warmIdentity mints a fallback when the fingerprint can't be resolved, so the accept path never blocks", async () => {
    const id = await warmIdentity(() => Promise.resolve(null));
    // Some id exists on disk now -> the first tracked event returns it via the
    // fast path and never enters the synchronous truly-fresh resolve.
    expect(versionNibble(id)).toBe("4");
    expect(fs.readFileSync(identityFilePath(), "utf8").trim()).toBe(id);
    expect(readOrCreateAnonId(() => null)).toBe(id);
  });

  it("warmIdentity keeps an already-stored fingerprint without re-resolving", async () => {
    fs.mkdirSync(`${tmp()}/.argent`, { recursive: true });
    fs.writeFileSync(identityFilePath(), FP, { mode: 0o600 });
    const asyncResolver = vi.fn(() => Promise.resolve(FP_OTHER));
    const id = await warmIdentity(asyncResolver);
    expect(id).toBe(FP);
    expect(asyncResolver).not.toHaveBeenCalled();
  });

  it("warmIdentity swallows a rejecting resolver and still establishes a fallback id", async () => {
    const id = await warmIdentity(() => Promise.reject(new Error("no binary")));
    expect(versionNibble(id)).toBe("4");
    expect(fs.readFileSync(identityFilePath(), "utf8").trim()).toBe(id);
  });
});
