import { afterAll } from "vitest";

// Suites here point HOME — and USERPROFILE, which os.homedir() reads on
// Windows — at a temp dir and then delete that dir; some replace PATH so a
// stubbed binary is found instead of the real one. Restoring is the half that is easy to omit
// and impossible to notice: under the shipped `isolate: true` each file gets
// its own fork, so a suite that leaves a variable naming a deleted directory
// takes the evidence with it when the fork exits.
//
// Registered last, this afterAll is the last one to run for every test file —
// vitest's default `sequence.hooks: "stack"` unwinds in reverse registration
// order, and a setup file registers before the test module is imported — so it
// sees whatever the file's own hooks left behind.

/** The variables a suite here redirects and must put back. */
export const SCOPED_ENV_VARS = ["HOME", "USERPROFILE", "PATH"];

// PATH runs to well over a kilobyte, and the tail of it is never what changed.
const abbreviate = (value: string | undefined): string =>
  value === undefined || value.length <= 60 ? String(value) : `${value.slice(0, 60)}…`;

// Read at module load, before the test module is imported. Snapshotting inside
// the hook instead would compare the environment with itself and pass whatever
// the file left behind.
const AMBIENT = Object.fromEntries(SCOPED_ENV_VARS.map((name) => [name, process.env[name]]));

/** Throws naming every variable the file failed to put back, or returns. */
function assertEnvRestored(): void {
  const leaked = SCOPED_ENV_VARS.filter((name) => process.env[name] !== AMBIENT[name]).map(
    (name) => `${name}: ${abbreviate(AMBIENT[name])} -> ${abbreviate(process.env[name])}`
  );
  if (leaked.length === 0) return;
  throw new Error(
    `this file left the process environment redirected; restore it in the same hook that ` +
      `deletes the temp dir (test/helpers/temp-home.ts's restore does both). ${leaked.join("; ")}`
  );
}

afterAll(() => assertEnvRestored());
