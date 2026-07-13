import { describe, expect, it } from "vitest";
import { describeCrash } from "../src/crash-diagnostics.js";

/** Build an Error with a fully controlled stack so frame parsing is exercised. */
function errorWithStack(message: string, stackLines: string[]): Error {
  const err = new Error(message);
  err.stack = [`Error: ${message}`, ...stackLines].join("\n");
  return err;
}

describe("describeCrash", () => {
  describe("crash_phase", () => {
    it("passes the phase through verbatim", () => {
      expect(describeCrash(new Error("x"), "startup").crash_phase).toBe("startup");
      expect(describeCrash(new Error("x"), "serving").crash_phase).toBe("serving");
    });
  });

  describe("error_name", () => {
    it("reads the class name of a built-in error subclass", () => {
      expect(describeCrash(new TypeError("bad"), "startup").error_name).toBe("TypeError");
      expect(describeCrash(new RangeError("bad"), "startup").error_name).toBe("RangeError");
    });

    it("reads the constructor name of a thrown plain object", () => {
      class CustomFailure {}
      expect(describeCrash(new CustomFailure(), "serving").error_name).toBe("CustomFailure");
    });

    it("is omitted for a thrown primitive (no class to name)", () => {
      expect(describeCrash("boom", "startup").error_name).toBeUndefined();
      expect(describeCrash(undefined, "startup").error_name).toBeUndefined();
    });
  });

  describe("error_syscall", () => {
    it("captures a Node system-error code", () => {
      const err = Object.assign(new Error("bind EADDRINUSE 127.0.0.1:3001"), {
        code: "EADDRINUSE",
        syscall: "listen",
      });
      expect(describeCrash(err, "startup").error_syscall).toBe("EADDRINUSE");
    });

    it("is omitted when there is no code", () => {
      expect(describeCrash(new Error("plain"), "startup").error_syscall).toBeUndefined();
    });
  });

  describe("crash_fingerprint", () => {
    it("is 16 lowercase hex chars for a stack with frames", () => {
      const err = errorWithStack("boom", [
        "    at Server.<anonymous> (/Users/alice/project/dist/index.js:120:15)",
      ]);
      expect(describeCrash(err, "startup").crash_fingerprint).toMatch(/^[0-9a-f]{16}$/);
    });

    it("is identical across users — the home-dir prefix and message are excluded", () => {
      // Same crash on two machines: only the absolute path prefix and the
      // PII-bearing message differ. The fingerprint must not.
      const alice = errorWithStack("failed for /Users/alice/secret.txt", [
        "    at Server.<anonymous> (/Users/alice/project/dist/index.js:120:15)",
        "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
      ]);
      const bob = errorWithStack("failed for /home/bob/other.txt", [
        "    at Server.<anonymous> (/home/bob/app/dist/index.js:120:15)",
        "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
      ]);
      const fpA = describeCrash(alice, "startup").crash_fingerprint;
      expect(fpA).toBeDefined();
      expect(describeCrash(bob, "startup").crash_fingerprint).toBe(fpA);
    });

    it("keeps the package-relative tail of node_modules frames (drops the user prefix)", () => {
      const alice = errorWithStack("x", [
        "    at Layer.handle (/Users/alice/proj/node_modules/express/lib/router/layer.js:95:5)",
      ]);
      const bob = errorWithStack("x", [
        "    at Layer.handle (/opt/ci/build/node_modules/express/lib/router/layer.js:95:5)",
      ]);
      expect(describeCrash(bob, "startup").crash_fingerprint).toBe(
        describeCrash(alice, "startup").crash_fingerprint
      );
    });

    it("de-identifies Windows paths (drive letter + backslashes)", () => {
      const alice = errorWithStack("x", ["    at f (C:\\Users\\alice\\app\\dist\\index.js:12:34)"]);
      const bob = errorWithStack("x", ["    at f (D:\\work\\bob\\build\\dist\\index.js:12:34)"]);
      const fp = describeCrash(alice, "startup").crash_fingerprint;
      expect(fp).toMatch(/^[0-9a-f]{16}$/);
      expect(describeCrash(bob, "startup").crash_fingerprint).toBe(fp);
    });

    it("collapses pnpm and npm node_modules layouts to the same fingerprint", () => {
      const npm = errorWithStack("x", [
        "    at handle (/Users/alice/proj/node_modules/express/lib/router/layer.js:95:5)",
      ]);
      const pnpm = errorWithStack("x", [
        "    at handle (/home/bob/proj/node_modules/.pnpm/express@4.18.2/node_modules/express/lib/router/layer.js:95:5)",
      ]);
      // lastIndexOf("node_modules/") keeps only the final package-relative tail,
      // dropping the .pnpm version-hash segment.
      expect(describeCrash(pnpm, "startup").crash_fingerprint).toBe(
        describeCrash(npm, "startup").crash_fingerprint
      );
    });

    it("ignores non-frame and anonymous lines without throwing", () => {
      const err = errorWithStack("x", [
        "    at <anonymous>",
        "    at new Promise (<anonymous>)",
        "    at Server.<anonymous> (/app/dist/index.js:10:5)",
      ]);
      // The two anonymous lines don't match FRAME_RE and are skipped; the real
      // frame still yields a fingerprint.
      expect(describeCrash(err, "startup").crash_fingerprint).toMatch(/^[0-9a-f]{16}$/);
    });

    it("changes when the crash site changes (different line)", () => {
      const a = errorWithStack("x", ["    at f (/app/dist/index.js:120:15)"]);
      const b = errorWithStack("x", ["    at f (/app/dist/index.js:200:15)"]);
      expect(describeCrash(a, "startup").crash_fingerprint).not.toBe(
        describeCrash(b, "startup").crash_fingerprint
      );
    });

    it("is omitted when the error carries no usable stack", () => {
      expect(describeCrash("just a string", "startup").crash_fingerprint).toBeUndefined();
      const noFrames = errorWithStack("boom", []); // header line only, no `at` frames
      expect(describeCrash(noFrames, "startup").crash_fingerprint).toBeUndefined();
    });
  });

  describe("resilience to hostile errors", () => {
    it("never throws, even when name/code/stack getters throw", () => {
      // An Error instance so errorName reads `.name` (the throwing getter)
      // rather than the constructor name.
      const hostile = new Error("real message");
      const throwing = () => {
        throw new Error("boom in getter");
      };
      Object.defineProperty(hostile, "name", { get: throwing });
      Object.defineProperty(hostile, "code", { get: throwing });
      Object.defineProperty(hostile, "stack", { get: throwing });
      let result: ReturnType<typeof describeCrash>;
      expect(() => {
        result = describeCrash(hostile, "serving");
      }).not.toThrow();
      // Only the phase survives; every throwing field is dropped.
      expect(result!).toEqual({ crash_phase: "serving" });
    });
  });

  it("never emits a message or raw-stack field", () => {
    const err = errorWithStack("secret /Users/alice/id_rsa", [
      "    at f (/Users/alice/app/index.js:1:1)",
    ]);
    const keys = Object.keys(describeCrash(err, "startup"));
    expect(keys).not.toContain("error_message");
    expect(keys).not.toContain("message");
    expect(keys).not.toContain("stack");
    // Whole record is confined to the four coded fields.
    for (const key of keys) {
      expect(["error_name", "error_syscall", "crash_fingerprint", "crash_phase"]).toContain(key);
    }
  });
});
