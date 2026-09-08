import { describe, it, expect, vi, afterEach } from "vitest";

// `test/setup/clear-argent-env.ts` only does anything on a machine that exports
// ARGENT_* overrides, so on a clean checkout its loop body never runs and no
// suite failure can report it being weakened — dropping the sweep, or its
// `setupFiles` entry, leaves this package green. Re-import it here against
// sentinels planted at call time, the way @argent/tool-server pins its own copy.
//
// `vi.resetModules()` is what makes the re-import run the top-level loop again
// instead of replaying the copy vitest already loaded as a setup file.

const PROBE = "ARGENT_PIN_PROBE";
const MIXED_CASE_PROBE = "Argent_Pin_Probe_Mixed";
const LOOKALIKE = "ARGENTINA_REGION";

afterEach(() => {
  for (const name of [PROBE, MIXED_CASE_PROBE, LOOKALIKE]) delete process.env[name];
});

async function rerunSetup(): Promise<void> {
  vi.resetModules();
  await import("./setup/clear-argent-env.js");
}

describe("clear-argent-env suite guard", () => {
  it("removes an ARGENT_ key outright instead of blanking it", async () => {
    process.env[PROBE] = "ambient";

    await rerunSetup();

    // `in`, not a truthiness check: assigning "" would also read as cleared to
    // `if (process.env.X)` while still reaching a spawned child as a set key.
    expect(PROBE in process.env).toBe(false);
  });

  it("keeps a name that shares the prefix without the underscore", async () => {
    process.env[LOOKALIKE] = "keep";

    await rerunSetup();

    expect(process.env[LOOKALIKE]).toBe("keep");
  });

  it("sweeps the prefix whatever case it was exported in", async () => {
    // Windows resolves process.env case-insensitively but enumerates the keys
    // with the casing they were set in, so a literal `startsWith("ARGENT_")`
    // leaves `set argent_host=…` readable as ARGENT_HOST — the one override
    // this file's comment names as changing an outcome.
    process.env[MIXED_CASE_PROBE] = "ambient";

    await rerunSetup();

    expect(MIXED_CASE_PROBE in process.env).toBe(false);
  });

  it("is registered as a setup file, so it runs before any test module", async () => {
    const config = await import("../vitest.config.js");

    expect(config.default.test?.setupFiles).toContain("test/setup/clear-argent-env.ts");
  });
});
