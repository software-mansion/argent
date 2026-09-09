import { describe, expect, it, vi } from "vitest";
import { SCOPED_ENV_VARS } from "./setup/assert-env-restored.js";

// The setup file's afterAll only fires on a suite that leaks, so on a green run
// its body never reports anything and a refactor could hollow it out unnoticed —
// the same blind spot clear-argent-env.ts has, pinned the same way.

const BEFORE = "argent-guard-ambient";
const PROBE = "argent-guard-probe";

describe("assert-env-restored", () => {
  it("watches every variable a suite here points at a directory it deletes", () => {
    expect(SCOPED_ENV_VARS).toEqual(["HOME", "USERPROFILE", "PATH"]);
  });

  it("registers an afterAll that reports every watched variable against the environment as it was at module load", async () => {
    // Registration and the module-load snapshot are the two halves no direct
    // call reaches: a hook that never registers, and one that snapshots on the
    // spot and so compares the environment with itself, both leave every suite
    // green. Importing under a stubbed vitest hands over the real hook body.
    const ambient = Object.fromEntries(SCOPED_ENV_VARS.map((name) => [name, process.env[name]]));
    const hooks: Array<() => void> = [];

    try {
      // A known environment at module load, so neither half of the message
      // depends on the machine. USERPROFILE is left unset: unset -> set is the
      // shape a dropped restore leaves on macOS and Linux, and a guard narrowed
      // to variables that were already set would pass the other direction.
      for (const name of SCOPED_ENV_VARS) process.env[name] = BEFORE;
      delete process.env.USERPROFILE;

      vi.doMock("vitest", () => ({ afterAll: (fn: () => void) => hooks.push(fn) }));
      vi.resetModules();
      await import("./setup/assert-env-restored.js");
      vi.doUnmock("vitest");
      vi.resetModules();

      expect(hooks).toHaveLength(1);
      expect(hooks[0]!).not.toThrow();

      // Every entry, not just the ones a suite here happens to change: one
      // declared but not watched reports nothing and nothing says so.
      for (const name of SCOPED_ENV_VARS) {
        const was = name === "USERPROFILE" ? "(unset)" : BEFORE;
        process.env[name] = PROBE;

        expect(hooks[0]!).toThrow(`${name}: ${was} -> ${PROBE}`);

        if (name === "USERPROFILE") delete process.env[name];
        else process.env[name] = BEFORE;
      }

      // A long value is cut on both halves, so one leaked PATH cannot bury
      // the rest of the line.
      process.env.PATH = "/a".repeat(200);

      expect(hooks[0]!).toThrow(`-> ${"/a".repeat(30)}…`);
    } finally {
      for (const name of SCOPED_ENV_VARS) {
        if (ambient[name] === undefined) delete process.env[name];
        else process.env[name] = ambient[name];
      }
    }
  });

  it("keeps this file registered as a setup file, so the hook runs for every suite", async () => {
    // Without the registration nothing runs the guard, and stripping the
    // restore from every call site leaves the package green.
    const config = await import("../vitest.config.js");

    expect(config.default.test?.setupFiles).toContain("test/setup/assert-env-restored.ts");
  });
});
