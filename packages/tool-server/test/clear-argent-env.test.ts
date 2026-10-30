import { describe, it, expect, vi, afterEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { CLEARED_ENV_VARS } from "./setup/clear-argent-env";

// Host/process controls are not tool-server configuration. In particular,
// Electron-hosted script children need ELECTRON_RUN_AS_NODE to remain set.
const PRESERVED_ENV_VARS = ["HOME", "USERPROFILE", "PATH", "CI", "ELECTRON_RUN_AS_NODE"];

// Like telemetry's drift guard, cover statically named reads via process.env,
// its aliases and ProcessEnv-typed bindings. Dynamic keys (ARGENT_ flags and
// the script child's environment forwarding) are deliberately out of scope.
function envNamesRead(source: string): string[] {
  // Most tool implementations do not read the environment. Avoid parsing their
  // full syntax trees just to find no bindings in a large source directory.
  if (!/\b(?:process\s*\.\s*env|ProcessEnv)\b/.test(source)) return [];
  const file = ts.createSourceFile("env-reads.ts", source, ts.ScriptTarget.Latest, true);
  const bindings = new Set<string>();
  const names = new Set<string>();
  const isEnv = (node: ts.Node): boolean =>
    node.getText(file) === "process.env" || (ts.isIdentifier(node) && bindings.has(node.text));

  function findBindings(node: ts.Node): void {
    if (
      (ts.isParameter(node) || ts.isVariableDeclaration(node)) &&
      ts.isIdentifier(node.name) &&
      (node.type?.getText(file).match(/^(?:NodeJS\.)?ProcessEnv$/) ||
        (node.initializer && isEnv(node.initializer)))
    ) {
      bindings.add(node.name.text);
    }
    ts.forEachChild(node, findBindings);
  }
  findBindings(file);

  function findNames(node: ts.Node): void {
    if (ts.isPropertyAccessExpression(node) && isEnv(node.expression)) {
      names.add(node.name.text);
    } else if (
      ts.isElementAccessExpression(node) &&
      isEnv(node.expression) &&
      ts.isStringLiteral(node.argumentExpression)
    ) {
      names.add(node.argumentExpression.text);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      isEnv(node.initializer)
    ) {
      for (const element of node.name.elements) {
        const key = element.propertyName ?? element.name;
        if (ts.isIdentifier(key) || ts.isStringLiteral(key)) names.add(key.text);
      }
    }
    ts.forEachChild(node, findNames);
  }
  findNames(file);
  return [...names];
}

// `test/setup/clear-argent-env.ts` only does anything on a machine that exports
// configuration overrides, so on a clean checkout its loops never run and no
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
  for (const name of [...CLEARED_ENV_VARS, PROBE, MIXED_CASE_PROBE]) {
    delete process.env[name];
  }
  vi.unstubAllEnvs();
  for (const [name, value] of [
    [LOOKALIKE, AMBIENT_LOOKALIKE],
    [PROVIDER_GUARD, AMBIENT_PROVIDER_GUARD],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("clear-argent-env suite guard", () => {
  it("removes non-prefixed configuration overrides outright instead of blanking them", async () => {
    for (const name of CLEARED_ENV_VARS) process.env[name] = "ambient";

    vi.resetModules();
    await import("./setup/clear-argent-env");

    expect(CLEARED_ENV_VARS.filter((name) => name in process.env)).toEqual([]);
  });

  it("preserves the host environment that is not tool-server configuration", async () => {
    for (const name of PRESERVED_ENV_VARS) {
      vi.stubEnv(name, "keep");
    }

    vi.resetModules();
    await import("./setup/clear-argent-env");

    for (const name of PRESERVED_ENV_VARS) {
      expect(process.env[name]).toBe("keep");
    }
  });

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

  it("covers statically named env reads throughout src", () => {
    const srcDir = join(__dirname, "..", "src");
    const reads = readdirSync(srcDir, { recursive: true })
      .map(String)
      .filter((file) => /\.(?:ts|mjs)$/.test(file))
      .flatMap((file) =>
        envNamesRead(readFileSync(join(srcDir, file), "utf8")).map((name) => ({ file, name }))
      );

    // The ADB reads use a ProcessEnv parameter rather than process.env directly.
    expect(reads).toContainEqual({
      file: join("utils", "adb-server.ts"),
      name: "ADB_SERVER_SOCKET",
    });
    expect(reads).toContainEqual({
      file: join("utils", "android-binary.ts"),
      name: "ANDROID_HOME",
    });
    expect(
      reads.filter(
        ({ name }) =>
          !name.startsWith("ARGENT_") &&
          !CLEARED_ENV_VARS.includes(name) &&
          !PRESERVED_ENV_VARS.includes(name)
      )
    ).toEqual([]);
  });

  it("recognises named access forms through environment bindings", () => {
    expect(
      envNamesRead(`
        const vars = process.env;
        vars.DOT_READ;
        vars?.OPTIONAL_READ;
        vars["BRACKET_READ"];
        function read(settings: NodeJS.ProcessEnv) {
          settings?.['OPTIONAL_BRACKET_READ'];
          const { DESTRUCTURED_READ, RENAMED_READ: local, DEFAULTED_READ = "x" } = settings;
        }
        process.env.DIRECT_READ;
        const { PROCESS_DESTRUCTURED }: NodeJS.ProcessEnv = process.env;
        unrelated.NOT_ENV;
        process.env[dynamicKey];
      `).sort()
    ).toEqual([
      "BRACKET_READ",
      "DEFAULTED_READ",
      "DESTRUCTURED_READ",
      "DIRECT_READ",
      "DOT_READ",
      "OPTIONAL_BRACKET_READ",
      "OPTIONAL_READ",
      "PROCESS_DESTRUCTURED",
      "RENAMED_READ",
    ]);
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
