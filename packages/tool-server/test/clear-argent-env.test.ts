import { describe, it, expect, vi, afterEach } from "vitest";

// `test/setup/clear-argent-env.ts` only does anything on a machine that exports
// ARGENT_* overrides, so on a clean checkout its loop body never runs and no
// suite failure can report it being weakened. Re-import it here against
// sentinels planted at call time, which pins the three properties a refactor
// could otherwise drop silently: the underscore in the prefix, the delete
// rather than a blanking assignment, and the registration in `setupFiles`.
//
// `vi.resetModules()` is what makes the re-import run the top-level loop again
// instead of replaying the copy vitest already loaded as a setup file.

const PROBE = "ARGENT_PIN_PROBE";
const LOOKALIKE = "ARGENTINA_REGION";

afterEach(() => {
  delete process.env[PROBE];
  delete process.env[LOOKALIKE];
});

describe("clear-argent-env suite guard", () => {
  it("removes an ARGENT_ key outright instead of blanking it", async () => {
    process.env[PROBE] = "ambient";

    vi.resetModules();
    await import("./setup/clear-argent-env");

    // `in`, not a truthiness check: assigning "" would also read as cleared to
    // `if (process.env.X)` while still reaching a spawned child as a set key.
    expect(PROBE in process.env).toBe(false);
  });

  it("keeps a name that shares the prefix without the underscore", async () => {
    process.env[LOOKALIKE] = "keep";

    vi.resetModules();
    await import("./setup/clear-argent-env");

    expect(process.env[LOOKALIKE]).toBe("keep");
  });

  it("is registered as a setup file, so it runs before any test module", async () => {
    const config = await import("../vitest.config");

    expect(config.default.test?.setupFiles).toContain("test/setup/clear-argent-env.ts");
  });
});
