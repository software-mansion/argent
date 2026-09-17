import { describe, it, expect, vi, afterEach } from "vitest";

// `test/setup/clear-argent-env.ts` only does anything on a machine that exports
// ARGENT_* overrides, so on a clean checkout its loop body never runs and no
// suite failure can report it being weakened. Re-import it here against
// sentinels planted at call time, which pins the properties a refactor could
// otherwise drop silently: the underscore in the prefix, the case-folding that
// prefix needs on Windows, the delete rather than a blanking assignment, and the
// registration in `setupFiles`.
//
// `vi.resetModules()` is what makes the re-import run the top-level loop again
// instead of replaying the copy vitest already loaded as a setup file.

const PROBE = "ARGENT_PIN_PROBE";
const MIXED_CASE_PROBE = "Argent_Pin_Probe_Mixed";
const LOOKALIKE = "ARGENTINA_REGION";

// The probe is the setup file's job to delete, so dropping it is the correct end
// state. The other two are not: the lookalike is planted here, and the provider
// guard is what a later setup file set — re-running the sweep deletes it, which
// is the hazard the last test in this file is about.
const AMBIENT_LOOKALIKE = process.env[LOOKALIKE];
const PROVIDER_GUARD = "ARGENT_DISABLE_DEVICE_PROVIDERS";
const AMBIENT_PROVIDER_GUARD = process.env[PROVIDER_GUARD];

afterEach(() => {
  for (const name of [PROBE, MIXED_CASE_PROBE]) delete process.env[name];
  for (const [name, value] of [
    [LOOKALIKE, AMBIENT_LOOKALIKE],
    [PROVIDER_GUARD, AMBIENT_PROVIDER_GUARD],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
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

  it("sweeps the prefix whatever case it was exported in", async () => {
    // Windows resolves process.env case-insensitively but enumerates the keys
    // with the casing they were set in, so a literal `startsWith("ARGENT_")`
    // leaves `set argent_auth_token=…` readable as ARGENT_AUTH_TOKEN — the
    // override this file's comment names as reaching furthest.
    process.env[MIXED_CASE_PROBE] = "ambient";

    vi.resetModules();
    await import("./setup/clear-argent-env");

    expect(MIXED_CASE_PROBE in process.env).toBe(false);
  });

  it("comes first in the pinned setup-file list, so it cannot sweep away what a later one sets", async () => {
    // Order is load-bearing here, not just membership: ignore-device-providers.ts
    // sets ARGENT_DISABLE_DEVICE_PROVIDERS, which this sweep would delete if it
    // ran after. Moving the sweep last leaves the whole suite green. Pinning the
    // whole list also makes adding a setup file a deliberate edit here.
    const config = await import("../vitest.config");

    expect(config.default.test?.setupFiles).toEqual([
      "test/setup/clear-argent-env.ts",
      "test/setup/stub-status-bar.ts",
      "test/setup/ignore-device-providers.ts",
      "test/setup/assert-env-restored.ts",
    ]);
  });
});
