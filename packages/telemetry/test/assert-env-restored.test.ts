import { describe, expect, it, vi } from "vitest";
import { SCOPED_ENV_VARS } from "./setup/assert-env-restored";

// The setup file's afterAll only fires on a suite that leaks, so on a green run
// its body never reports anything and a refactor could hollow it out unnoticed —
// the same blind spot clear-telemetry-env.ts has, pinned the same way.

describe("assert-env-restored", () => {
  it("watches the pair os.homedir() consults", () => {
    expect(SCOPED_ENV_VARS).toEqual(["HOME", "USERPROFILE"]);
  });

  it("registers an afterAll that reports against the environment as it was at module load", async () => {
    // Registration and the module-load snapshot are the two halves no direct
    // call reaches: a hook that never registers and one that snapshots on the
    // spot — comparing the environment with itself — both leave every suite
    // green. Importing under a stubbed vitest hands over the real hook body.
    const hooks: Array<() => void> = [];
    vi.doMock("vitest", () => ({ afterAll: (fn: () => void) => hooks.push(fn) }));
    vi.resetModules();
    await import("./setup/assert-env-restored");
    vi.doUnmock("vitest");
    vi.resetModules();

    expect(hooks).toHaveLength(1);

    const ambientHome = process.env.HOME;
    process.env.HOME = "/tmp/argent-telemetry-deleted";
    try {
      expect(hooks[0]!).toThrow("HOME: /");
    } finally {
      if (ambientHome === undefined) delete process.env.HOME;
      else process.env.HOME = ambientHome;
    }
    expect(hooks[0]!).not.toThrow();
  });

  it("is registered as a setup file, so its afterAll runs after each file's own", async () => {
    const config = await import("../vitest.config");

    expect(config.default.test?.setupFiles).toContain("test/setup/assert-env-restored.ts");
  });
});
