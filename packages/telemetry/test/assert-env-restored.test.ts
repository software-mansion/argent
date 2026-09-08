import { describe, expect, it } from "vitest";
import { SCOPED_ENV_VARS, assertEnvRestored } from "./setup/assert-env-restored";

// The setup file's afterAll only fires on a suite that leaks, so on a green run
// its body never reports anything and a refactor could hollow it out unnoticed —
// the same blind spot clear-telemetry-env.ts has, pinned the same way.

describe("assert-env-restored", () => {
  it("watches the pair os.homedir() consults", () => {
    expect(SCOPED_ENV_VARS).toEqual(["HOME", "USERPROFILE"]);
  });

  it("throws against a snapshot taken at module load, not one taken on the spot", () => {
    // What the hook actually calls. A snapshot taken inside the hook would
    // compare the environment with itself, and every leak would read as clean.
    expect(() => assertEnvRestored({ ...process.env, HOME: "/tmp/not-the-ambient-home" })).toThrow(
      "HOME: "
    );
    expect(() => assertEnvRestored()).not.toThrow();
  });

  it("is registered as a setup file, so its afterAll runs after each file's own", async () => {
    const config = await import("../vitest.config");

    expect(config.default.test?.setupFiles).toContain("test/setup/assert-env-restored.ts");
  });
});
