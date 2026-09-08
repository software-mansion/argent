import { afterAll } from "vitest";

// Seven suites here call scopeHome() (test/helpers.ts), which points HOME — and
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

/** The variables a suite here redirects at a directory it later deletes. */
export const SCOPED_ENV_VARS = ["HOME", "USERPROFILE"];

// Read at module load, before the test module is imported. Snapshotting inside
// the hook instead would compare the environment with itself and pass whatever
// the file left behind, so it is not a parameter.
const AMBIENT = Object.fromEntries(SCOPED_ENV_VARS.map((name) => [name, process.env[name]]));

/** Throws naming every variable the file failed to put back, or returns. */
export function assertEnvRestored(current: NodeJS.ProcessEnv = process.env): void {
  const leaked = SCOPED_ENV_VARS.filter((name) => current[name] !== AMBIENT[name]).map(
    (name) => `${name}: ${String(AMBIENT[name])} -> ${String(current[name])}`
  );
  if (leaked.length === 0) return;
  throw new Error(
    `this file left the process environment redirected; restore it in the same hook that ` +
      `deletes the temp dir (test/helpers.ts's restoreHome does both). ${leaked.join("; ")}`
  );
}

afterAll(() => assertEnvRestored());
