import { describe, expect, it, vi } from "vitest";
import { SCOPED_ENV_VARS, leakedEnvVars } from "./setup/assert-env-restored.js";

// The setup file's afterAll only fires on a suite that leaks, so on a green run
// its body never reports anything and a refactor could hollow it out unnoticed —
// the same blind spot clear-argent-env.ts has, pinned the same way.

const ambient = { HOME: "/ambient", USERPROFILE: undefined, PATH: "/usr/bin" };

describe("assert-env-restored", () => {
  it("watches every variable a suite here points at a directory it deletes", () => {
    // HOME and USERPROFILE are the pair os.homedir() consults; PATH is replaced
    // wholesale by launcher-ps-guard and launcher-sweep, and a leaked one is
    // worse than a dead home — the developer's whole PATH is gone with it.
    expect(SCOPED_ENV_VARS).toEqual(["HOME", "USERPROFILE", "PATH"]);
  });

  it("says nothing when the file put everything back", () => {
    expect(leakedEnvVars(ambient, { ...ambient })).toEqual([]);
  });

  it("names the variable, the ambient value and what was left behind", () => {
    expect(leakedEnvVars(ambient, { ...ambient, HOME: "/tmp/gone" })).toEqual([
      "HOME: /ambient -> /tmp/gone",
    ]);
  });

  it("catches a variable left set that was unset before, not just a changed one", () => {
    // USERPROFILE is unset on macOS and Linux, so this is the shape every
    // redirect in this package leaves behind when its restorer is dropped.
    expect(leakedEnvVars(ambient, { ...ambient, USERPROFILE: "/tmp/gone" })).toEqual([
      "USERPROFILE: undefined -> /tmp/gone",
    ]);
  });

  it("abbreviates a long value so a leaked PATH stays one readable line", () => {
    expect(leakedEnvVars(ambient, { ...ambient, PATH: "/a".repeat(200) })).toEqual([
      `PATH: /usr/bin -> ${"/a".repeat(30)}…`,
    ]);
  });

  it("registers an afterAll that reports against the environment as it was at module load", async () => {
    // Registration and the module-load snapshot are the two halves no direct
    // call reaches: a hook that never registers and one that snapshots on the
    // spot — comparing the environment with itself — both leave every suite
    // green. Importing under a stubbed vitest hands over the real hook body.
    const hooks: Array<() => void> = [];
    vi.doMock("vitest", () => ({ afterAll: (fn: () => void) => hooks.push(fn) }));
    vi.resetModules();
    await import("./setup/assert-env-restored.js");
    vi.doUnmock("vitest");
    vi.resetModules();

    expect(hooks).toHaveLength(1);

    const ambientHome = process.env.HOME;
    process.env.HOME = "/tmp/argent-launcher-deleted";
    try {
      expect(hooks[0]!).toThrow("HOME: /");
    } finally {
      if (ambientHome === undefined) delete process.env.HOME;
      else process.env.HOME = ambientHome;
    }
    expect(hooks[0]!).not.toThrow();
  });
});
