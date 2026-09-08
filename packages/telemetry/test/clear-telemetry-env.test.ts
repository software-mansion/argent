import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CLEARED_ENV_VARS } from "./setup/clear-telemetry-env";

// `test/setup/clear-telemetry-env.ts` only does anything on a machine that
// exports one of these, so on a clean checkout its loop bodies never run and no
// suite failure can report it being weakened. Re-import it here against
// sentinels planted at call time, which pins the properties a refactor could
// otherwise drop silently: the delete rather than a blanking assignment, the
// underscore in the ARGENT_ prefix, the case-folding that prefix needs on
// Windows, coverage of every name the consent and detector paths read, and the
// registration in `setupFiles`.
//
// `vi.resetModules()` is what makes the re-import run the top-level loops again
// instead of replaying the copy vitest already loaded as a setup file.

const PROBE = "ARGENT_PIN_PROBE";
const MIXED_CASE_PROBE = "Argent_Pin_Probe_Mixed";
const LOOKALIKE = "ARGENTINA_REGION";

// ci-detect.ts is the one src file deliberately outside the sweep: it reads CI,
// which the suite must keep, and the setup file's own header says why. Anything
// else under src/ is in scope, so a marker moved into a new file is caught.
const UNSWEPT_SRC_FILES = ["ci-detect.ts"];

// Both access forms, so relocating a read from `env.X` to `env["X"]` cannot
// walk it out of view.
const ENV_READ =
  /\benv(?:\?)?\.([A-Z][A-Z0-9_]*)\b|\benv(?:\?)?\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g;

afterEach(() => {
  for (const name of [...CLEARED_ENV_VARS, PROBE, MIXED_CASE_PROBE, LOOKALIKE])
    delete process.env[name];
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

  it("sweeps the prefix whatever case it was exported in", async () => {
    // Windows resolves process.env case-insensitively but enumerates the keys
    // with the casing they were set in, so a literal `startsWith("ARGENT_")`
    // leaves `set argent_telemetry=0` readable as ARGENT_TELEMETRY.
    process.env[MIXED_CASE_PROBE] = "ambient";

    await rerunSetup();

    expect(MIXED_CASE_PROBE in process.env).toBe(false);
  });

  it("covers every env name src reads, in either access form and in any file", () => {
    const srcDir = join(__dirname, "..", "src");
    const files = readdirSync(srcDir)
      .filter((name) => name.endsWith(".ts") && !UNSWEPT_SRC_FILES.includes(name))
      .sort();

    const read = files.flatMap((file) => {
      const source = readFileSync(join(srcDir, file), "utf8");
      return [...source.matchAll(ENV_READ)].map((m) => ({ file, name: (m[1] ?? m[2])! }));
    });

    // A regex that stopped matching would otherwise report full coverage of
    // nothing; DO_NOT_TRACK is the read the whole file exists for.
    expect(read.map((r) => r.name)).toContain("DO_NOT_TRACK");

    const uncleared = read.filter(
      ({ name }) => !name.startsWith("ARGENT_") && !CLEARED_ENV_VARS.includes(name)
    );
    expect(uncleared).toEqual([]);
  });

  it("is registered as a setup file, so it runs before any test module", async () => {
    const config = await import("../vitest.config");

    expect(config.default.test?.setupFiles).toContain("test/setup/clear-telemetry-env.ts");
  });
});
