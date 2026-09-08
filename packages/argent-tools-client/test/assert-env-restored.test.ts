import { describe, expect, it } from "vitest";
import { SCOPED_ENV_VARS, assertEnvRestored, leakedEnvVars } from "./setup/assert-env-restored.js";

// The setup file's afterAll only fires on a suite that leaks, so on a green run
// its body never reports anything and a refactor could hollow it out unnoticed —
// the same blind spot clear-argent-env.ts has, pinned the same way. The
// registration itself is asserted in home-redirect.test.ts.

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

  it("throws against a snapshot taken at module load, not one taken on the spot", () => {
    // What the hook actually calls. A snapshot taken inside the hook would
    // compare the environment with itself, and every leak would read as clean.
    expect(() => assertEnvRestored({ ...process.env, HOME: "/tmp/not-the-ambient-home" })).toThrow(
      "HOME: "
    );
    expect(() => assertEnvRestored()).not.toThrow();
  });
});
