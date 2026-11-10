import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

// Which files the scan can see, not just which names it finds: a file that
// stops matching would otherwise be silently dropped from the count while the
// rest still supply DO_NOT_TRACK.
const SRC_FILES_READING_ENV = ["cloud-agent-detect.ts", "consent.ts", "debug.ts"];

// The identifiers a file binds the environment to, so a read is found under
// whatever name it was given rather than only under `env`. `noImplicitAny` is
// what makes the annotation reliable: a parameter taking the environment cannot
// be left untyped. A read that reaches it some other way — `Reflect.get`, a
// computed name — is still out of view; otel.ts is the real case, reading
// `process.env[name]` over a list of the OTEL_* variables the setup file leaves
// alone on purpose.
const ENV_ANNOTATED = /\b([A-Za-z_$][\w$]*)\s*\??\s*:\s*(?:NodeJS\.)?ProcessEnv\b/g;
const ENV_ALIASED = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*process\.env\b/g;

function envIdentifiers(source: string): string[] {
  const names = new Set(["process\\.env"]);
  for (const [, annotated] of source.matchAll(ENV_ANNOTATED)) names.add(annotated!);
  for (const [, aliased] of source.matchAll(ENV_ALIASED)) names.add(aliased!);
  return [...names];
}

// `[^{}]` keeps the destructure match inside the pattern. Without it the
// leftmost match starts at the enclosing block's brace and harvests every
// capitalised token in the body — `Number(` reads as an env name called `N`.
// The optional `: Type` is the annotated form, `const { X }: ProcessEnv = env`.
const accessForms = (id: string): RegExp[] => [
  new RegExp(`\\b${id}\\??\\.([A-Z][A-Z0-9_]*)\\b`, "g"),
  new RegExp(`\\b${id}(?:\\?\\.)?\\[\\s*["']([A-Z][A-Z0-9_]*)["']\\s*\\]`, "g"),
];

const destructureForm = (id: string): RegExp =>
  new RegExp(`(?:const|let|var)\\s*\\{([^{}]*)\\}\\s*(?::[^={}]*)?=\\s*${id}\\b`, "g");

// `{ FOO: local }` binds under a different name and `{ FOO = "x" }` gives one a
// default; the env key is what precedes both, and it has to be the whole token
// or it is not an env name.
const destructuredNames = (pattern: string): string[] =>
  pattern
    .split(",")
    .map((part) => part.split(":")[0]!.split("=")[0]!.trim())
    .filter((name) => /^[A-Z][A-Z0-9_]*$/.test(name));

function envNamesRead(source: string): string[] {
  return envIdentifiers(source).flatMap((id) => [
    ...accessForms(id).flatMap((form) => [...source.matchAll(form)].map((m) => m[1]!)),
    ...[...source.matchAll(destructureForm(id))].flatMap((m) => destructuredNames(m[1]!)),
  ]);
}

/** Every .ts file under `dir`, at any depth, minus the declared exemptions. */
function scannedSrcFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .map((entry) => String(entry).split(sep).join("/"))
    .filter((name) => name.endsWith(".ts") && !UNSWEPT_SRC_FILES.includes(name))
    .sort();
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

  it("covers every statically-named env read in src, in any form and at any depth", () => {
    // Pinned, not just declared: adding a name here is the cheapest way to make
    // the guard stop guarding, so widening it has to be a deliberate edit here.
    expect(UNSWEPT_SRC_FILES).toEqual(["ci-detect.ts"]);

    const srcDir = join(__dirname, "..", "src");
    const read = scannedSrcFiles(srcDir).flatMap((file) =>
      envNamesRead(readFileSync(join(srcDir, file), "utf8")).map((name) => ({ file, name }))
    );

    // A scan that stopped matching would otherwise report full coverage of
    // nothing; DO_NOT_TRACK is the read the whole file exists for.
    expect(read.map((r) => r.name)).toContain("DO_NOT_TRACK");
    expect([...new Set(read.map((r) => r.file))].sort()).toEqual(SRC_FILES_READING_ENV);

    const uncleared = read.filter(
      ({ name }) => !name.startsWith("ARGENT_") && !CLEARED_ENV_VARS.includes(name)
    );
    expect(uncleared).toEqual([]);
  });

  it("reads every access form, and nothing that merely looks like one", () => {
    // Only the dotted form appears in src today, so the branches handling the
    // rest are unexercised by the scan above and could be dropped unnoticed.
    const forms = [
      `function read(env: NodeJS.ProcessEnv) {`,
      `  env.DOT_READ;`,
      `  env?.CHAIN_READ;`,
      `  env["BRACKET_READ"];`,
      `  env?.['CHAINED_BRACKET_READ'];`,
      `  const { DESTRUCTURED_READ } = env;`,
      `  const { PROCESS_DESTRUCTURED } = process.env;`,
      `  const { RENAMED_READ: local } = env;`,
      `  const { ANNOTATED_READ }: NodeJS.ProcessEnv = env;`,
      `  const { DEFAULTED_READ = "fallback" } = env;`,
      `  const { RENAMED_DEFAULTED_READ: also = "fallback" } = env;`,
      `}`,
      // The binding does not have to be called `env`: a differently named
      // parameter, and a local alias of process.env, are the two ways a read
      // walks out of a name-keyed scan.
      `function renamed(vars: NodeJS.ProcessEnv) { return vars.RENAMED_BINDING_READ; }`,
      `const aliased = process.env;`,
      `aliased.ALIASED_READ;`,
    ].join("\n");
    expect([...new Set(envNamesRead(forms))].sort()).toEqual([
      "ALIASED_READ",
      "ANNOTATED_READ",
      "BRACKET_READ",
      "CHAINED_BRACKET_READ",
      "CHAIN_READ",
      "DEFAULTED_READ",
      "DESTRUCTURED_READ",
      "DOT_READ",
      "PROCESS_DESTRUCTURED",
      "RENAMED_BINDING_READ",
      "RENAMED_DEFAULTED_READ",
      "RENAMED_READ",
    ]);

    // The destructure pattern must not start at the enclosing block's brace and
    // harvest the body: `Number(` there would otherwise read as a name `N`.
    const enclosed = [
      `function rate(env: NodeJS.ProcessEnv): number {`,
      `  const parsed = Number(env.REAL_READ);`,
      `  const { OTHER_REAL_READ } = env;`,
      `  return parsed || Number(OTHER_REAL_READ) || 1;`,
      `}`,
    ].join("\n");
    expect([...new Set(envNamesRead(enclosed))].sort()).toEqual(["OTHER_REAL_READ", "REAL_READ"]);
  });

  it("scans subdirectories, so a read cannot be moved out of view", () => {
    // src/ is flat today, so the recursion is otherwise unexercised — the same
    // blind spot the forms above have.
    const root = mkdtempSync(join(tmpdir(), "argent-scan-probe-"));
    try {
      mkdirSync(join(root, "detect"));
      for (const file of ["top.ts", "ci-detect.ts", "detect/vendor.ts", "detect/notes.md"]) {
        writeFileSync(join(root, file), "");
      }

      expect(scannedSrcFiles(root)).toEqual(["detect/vendor.ts", "top.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is registered as a setup file, so it runs before any test module", async () => {
    const config = await import("../vitest.config");

    expect(config.default.test?.setupFiles).toContain("test/setup/clear-telemetry-env.ts");
  });
});
