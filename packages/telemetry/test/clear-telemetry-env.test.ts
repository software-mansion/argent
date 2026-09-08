import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLEARED_ENV_VARS } from "./setup/clear-telemetry-env";

// `test/setup/clear-telemetry-env.ts` only does anything on a machine that
// exports one of these, so on a clean checkout its loop bodies never run and no
// suite failure can report it being weakened. Re-import it here against
// sentinels planted at call time, which pins the properties a refactor could
// otherwise drop silently: the delete rather than a blanking assignment, the
// underscore in the ARGENT_ prefix, coverage of every name the consent and
// detector paths read, and the registration in `setupFiles`.
//
// `vi.resetModules()` is what makes the re-import run the top-level loops again
// instead of replaying the copy vitest already loaded as a setup file.

const PROBE = "ARGENT_PIN_PROBE";
const LOOKALIKE = "ARGENTINA_REGION";

afterEach(() => {
  for (const name of [...CLEARED_ENV_VARS, PROBE, LOOKALIKE]) delete process.env[name];
});

async function rerunSetup(): Promise<void> {
  vi.resetModules();
  await import("./setup/clear-telemetry-env");
}

describe("clear-telemetry-env suite guard", () => {
  it("removes every named variable outright instead of blanking it", async () => {
    for (const name of CLEARED_ENV_VARS) process.env[name] = "ambient";

    await rerunSetup();

    // `in`, not a truthiness check: an assignment of "" would read as cleared to
    // `if (env.X)` while still being a present key to anything that inspects it.
    expect(CLEARED_ENV_VARS.filter((name) => name in process.env)).toEqual([]);
  });

  it("sweeps the whole ARGENT_ prefix, and nothing that merely starts with ARGENT", async () => {
    process.env[PROBE] = "ambient";
    process.env[LOOKALIKE] = "keep";

    await rerunSetup();

    expect(PROBE in process.env).toBe(false);
    expect(process.env[LOOKALIKE]).toBe("keep");
  });

  it("covers every env name the consent, detector and debug paths read", () => {
    // ci-detect.ts is out of scope by design — see the setup file's own note.
    for (const file of ["consent.ts", "cloud-agent-detect.ts", "debug.ts"]) {
      const source = readFileSync(join(__dirname, "..", "src", file), "utf8");
      const read = [...source.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)].map((m) => m[1]!);
      expect(read.length).toBeGreaterThan(0);
      const uncleared = read.filter(
        (name) => !name.startsWith("ARGENT_") && !CLEARED_ENV_VARS.includes(name)
      );
      expect({ file, uncleared }).toEqual({ file, uncleared: [] });
    }
  });

  it("is registered as a setup file, so it runs before any test module", async () => {
    const config = await import("../vitest.config");

    expect(config.default.test?.setupFiles).toContain("test/setup/clear-telemetry-env.ts");
  });
});
