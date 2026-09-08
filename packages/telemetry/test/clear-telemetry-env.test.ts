import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
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
// else under src/ is in scope — recursively, so a marker moved into a new
// subdirectory is caught rather than silently dropped from the count.
const UNSWEPT_SRC_FILES = ["ci-detect.ts"];

// Every access form, so rewriting a read cannot walk it out of view: dotted,
// optional-chained, bracketed, and destructured off `env` / `process.env`.
const ENV_READ =
  /\benv(?:\?)?\.([A-Z][A-Z0-9_]*)\b|\benv(?:\?)?\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g;
const ENV_DESTRUCTURE = /\{([^}]*)\}\s*=\s*(?:process\.)?env\b/g;
const ENV_NAME = /[A-Z][A-Z0-9_]*/g;

function envNamesRead(source: string): string[] {
  const dotted = [...source.matchAll(ENV_READ)].map((m) => (m[1] ?? m[2])!);
  const destructured = [...source.matchAll(ENV_DESTRUCTURE)].flatMap(
    (m) => m[1]!.match(ENV_NAME) ?? []
  );
  return [...dotted, ...destructured];
}

// The probes and the named variables are the setup file's job to delete, so
// dropping them is the correct end state. The lookalike is not — it is planted
// here, and this file must leave the ambient one exactly as it found it.
const AMBIENT_LOOKALIKE = process.env[LOOKALIKE];

afterEach(() => {
  for (const name of [...CLEARED_ENV_VARS, PROBE, MIXED_CASE_PROBE]) delete process.env[name];
  if (AMBIENT_LOOKALIKE === undefined) delete process.env[LOOKALIKE];
  else process.env[LOOKALIKE] = AMBIENT_LOOKALIKE;
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

  it("covers every env name src reads, in any access form and in any file", () => {
    // Pinned, not just declared: adding a name here is the cheapest way to make
    // the guard stop guarding, so widening it has to be a deliberate edit here.
    expect(UNSWEPT_SRC_FILES).toEqual(["ci-detect.ts"]);

    const srcDir = join(__dirname, "..", "src");
    const files = readdirSync(srcDir, { recursive: true })
      .map((entry) => String(entry).split(sep).join("/"))
      .filter((name) => name.endsWith(".ts") && !UNSWEPT_SRC_FILES.includes(name))
      .sort();

    const read = files.flatMap((file) =>
      envNamesRead(readFileSync(join(srcDir, file), "utf8")).map((name) => ({ file, name }))
    );

    // A regex that stopped matching would otherwise report full coverage of
    // nothing; DO_NOT_TRACK is the read the whole file exists for.
    expect(read.map((r) => r.name)).toContain("DO_NOT_TRACK");

    // Only the dotted form appears in src today, so the alternatives that handle
    // the rest are not exercised by the scan above and could be dropped unnoticed.
    const forms = [
      `env.DOT_READ`,
      `env?.CHAIN_READ`,
      `env["BRACKET_READ"]`,
      `env['QUOTED_READ']`,
      `const { DESTRUCTURED_READ } = env;`,
      `const { PROCESS_DESTRUCTURED } = process.env;`,
    ].join("\n");
    expect(envNamesRead(forms).sort()).toEqual([
      "BRACKET_READ",
      "CHAIN_READ",
      "DESTRUCTURED_READ",
      "DOT_READ",
      "PROCESS_DESTRUCTURED",
      "QUOTED_READ",
    ]);

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
