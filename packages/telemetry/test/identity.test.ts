import * as fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { scopeHome } from "./helpers.js";
import { readOrCreateAnonId, deleteAnonId } from "../src/identity.js";
import { identityFilePath } from "../src/paths.js";

describe("identity", () => {
  const { tmp } = scopeHome();

  it("creates a UUID on first call and reuses it on second", () => {
    const first = readOrCreateAnonId();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    const second = readOrCreateAnonId();
    expect(second).toBe(first);
  });

  it("writes with mode 0600", () => {
    readOrCreateAnonId();
    const stats = fs.lstatSync(identityFilePath());
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("survives a half-written tmpfile", () => {
    readOrCreateAnonId();
    // Plant a leftover tmpfile to simulate a crash mid-create. The next
    // read still succeeds because the FINAL path was written cleanly.
    fs.writeFileSync(tmp() + "/.argent/.telemetry-id.tmp.99999.deadbeef", "half-written-garbage");
    const id = readOrCreateAnonId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("cleans up the temp file when writing the id fails", async () => {
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        // Fail the durability sync after the temp file is opened + written, so
        // the create path throws between openSync and the link/publish step.
        fsyncSync: vi.fn(() => {
          const err = new Error("simulated I/O failure") as NodeJS.ErrnoException;
          err.code = "EIO";
          throw err;
        }),
      };
    });

    try {
      const { readOrCreateAnonId } = await import("../src/identity.js");
      expect(() => readOrCreateAnonId()).toThrow();

      // No id was published, and no `.telemetry-id.tmp.*` orphan was left behind.
      expect(fs.existsSync(identityFilePath())).toBe(false);
      const leftovers = fs
        .readdirSync(tmp() + "/.argent")
        .filter((name) => name.startsWith(".telemetry-id.tmp."));
      expect(leftovers).toEqual([]);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("fails closed when a symlink is planted at the final path", () => {
    // First create a real file elsewhere.
    fs.mkdirSync(tmp() + "/.argent", { recursive: true });
    const evilTarget = tmp() + "/evil.txt";
    fs.writeFileSync(evilTarget, "00000000-0000-0000-0000-000000000000");
    fs.symlinkSync(evilTarget, identityFilePath());

    // The symlink should NOT be honoured or replaced.
    expect(() => readOrCreateAnonId()).toThrow();
    expect(fs.lstatSync(identityFilePath()).isSymbolicLink()).toBe(true);
  });

  it("deleteAnonId removes the file and is idempotent", () => {
    readOrCreateAnonId();
    expect(fs.existsSync(identityFilePath())).toBe(true);
    deleteAnonId();
    expect(fs.existsSync(identityFilePath())).toBe(false);
    expect(() => deleteAnonId()).not.toThrow();
  });

  it("two concurrent createOrRead calls converge on one UUID", async () => {
    // Race two creates from the same process; the final-path link() gate
    // guarantees the loser reads the winner's file.
    const [a, b] = await Promise.all([
      Promise.resolve().then(() => readOrCreateAnonId()),
      Promise.resolve().then(() => readOrCreateAnonId()),
    ]);
    expect(a).toBe(b);
  });

  it("does not overwrite an id published between temp write and final publish", async () => {
    const winner = "11111111-1111-4111-8111-111111111111";
    let planted = false;

    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        linkSync: vi.fn((existingPath: fs.PathLike, newPath: fs.PathLike) => {
          if (!planted && String(newPath) === identityFilePath()) {
            planted = true;
            actual.writeFileSync(identityFilePath(), winner, { mode: 0o600 });
            const err = new Error("file exists") as NodeJS.ErrnoException;
            err.code = "EEXIST";
            throw err;
          }
          return actual.linkSync(existingPath, newPath);
        }),
      };
    });

    try {
      const { readOrCreateAnonId } = await import("../src/identity.js");
      expect(readOrCreateAnonId()).toBe(winner);
      expect(fs.readFileSync(identityFilePath(), "utf8")).toBe(winner);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });
});
