import { describe, expect, it, vi } from "vitest";
import { SCOPED_ENV_VARS } from "./setup/assert-env-restored";

// The setup file's afterAll only fires on a suite that leaks, so on a green run
// its body never reports anything and a refactor could hollow it out unnoticed —
// the same blind spot clear-argent-env.ts has, pinned the same way.

describe("assert-env-restored", () => {
  it("watches the pair os.homedir() consults and the PATH a stubbed binary is found on", () => {
    expect(SCOPED_ENV_VARS).toEqual(["HOME", "USERPROFILE", "PATH"]);
  });

  it("registers an afterAll that reports against the environment as it was at module load", async () => {
    // Registration and the module-load snapshot are the two halves no direct
    // call reaches: a hook that never registers and one that snapshots on the
    // spot — comparing the environment with itself — both leave every suite
    // green. Importing under a stubbed vitest hands over the real hook body.
    const ambient = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    const ambientPath = process.env.PATH!;
    const restore = (name: "HOME" | "USERPROFILE"): void => {
      if (ambient[name] === undefined) delete process.env[name];
      else process.env[name] = ambient[name];
    };
    const hooks: Array<() => void> = [];

    try {
      // Snapshot with USERPROFILE unset whichever platform this is: unset ->
      // set is the shape a dropped restore leaves on macOS and Linux, and a
      // guard narrowed to variables that were already set would still pass a
      // changed -> changed case.
      delete process.env.USERPROFILE;
      vi.doMock("vitest", () => ({ afterAll: (fn: () => void) => hooks.push(fn) }));
      vi.resetModules();
      await import("./setup/assert-env-restored");
      vi.doUnmock("vitest");
      vi.resetModules();

      expect(hooks).toHaveLength(1);
      expect(hooks[0]!).not.toThrow();

      // The ambient half of the message is whatever this machine has, so only
      // the leaked half is asserted literally.
      process.env.HOME = "/tmp/argent-tool-server-deleted";
      expect(hooks[0]!).toThrow(/HOME: .+ -> \/tmp\/argent-tool-server-deleted/);
      restore("HOME");

      process.env.USERPROFILE = "/tmp/argent-tool-server-deleted";
      expect(hooks[0]!).toThrow("USERPROFILE: undefined -> /tmp/argent-tool-server-deleted");
      restore("USERPROFILE");

      // PATH runs to well over a kilobyte on a developer machine, so both
      // halves of its line are cut to 60 characters.
      process.env.PATH = "/a".repeat(200);
      expect(hooks[0]!).toThrow(`-> ${"/a".repeat(30)}…`);
    } finally {
      restore("HOME");
      restore("USERPROFILE");
      process.env.PATH = ambientPath;
    }
  });
});
