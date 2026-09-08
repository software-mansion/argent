import { afterAll } from "vitest";

// The suites here call scopeHome() (test/helpers.ts), which points HOME — and
// USERPROFILE, which os.homedir() reads on Windows — at a temp dir and deletes
// that dir in the same afterEach. Restoring is the half that is easy to omit and
// impossible to notice: under the shipped `isolate: true` each file gets its own
// fork, so a suite that leaves a variable naming a deleted directory takes the
// evidence with it when the fork exits. Deleting the restore from
// helpers.ts leaves the package green in both isolate modes without this.
//
// The sibling guard in @argent/tools-client also watches PATH; nothing here
// redirects it. Registered as a setup file, this afterAll is the last one to run
// for every test file — vitest's default `sequence.hooks: "stack"` unwinds in
// reverse registration order, and a setup file registers before the test module
// is imported — so it sees whatever the file's own hooks left behind.

// CI is the one variable clear-telemetry-env.ts deliberately leaves alone, so
// three tests here set it and hand-restore it; a dropped restore there is
// invisible under `isolate: true` and, under --no-isolate, surfaces as unrelated
// failures in whichever file runs next.
/** The variables a suite here redirects and must put back. */
export const SCOPED_ENV_VARS = ["HOME", "USERPROFILE", "CI"];

// Read at module load, before the test module is imported. Snapshotting inside
// the hook instead would compare the environment with itself and pass whatever
// the file left behind.
const AMBIENT = Object.fromEntries(SCOPED_ENV_VARS.map((name) => [name, process.env[name]]));

/** Throws naming every variable the file failed to put back, or returns. */
function assertEnvRestored(): void {
  const leaked = SCOPED_ENV_VARS.filter((name) => process.env[name] !== AMBIENT[name]).map(
    (name) => `${name}: ${String(AMBIENT[name])} -> ${String(process.env[name])}`
  );
  if (leaked.length === 0) return;
  throw new Error(
    `this file left the process environment modified; put it back in the hook that changed ` +
      `it (test/helpers.ts's restoreHome does that and deletes the temp dir). ${leaked.join("; ")}`
  );
}

afterAll(() => assertEnvRestored());
