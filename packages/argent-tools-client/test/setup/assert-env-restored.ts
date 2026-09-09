import { afterAll } from "vitest";

// Suites in this package point HOME (and USERPROFILE, which os.homedir() reads
// on Windows) at a temp dir and then delete that dir; some do the same to PATH
// so a stub is found instead of the real binary. Restoring is the half that is
// easy to omit and impossible to notice: under the shipped `isolate: true` each
// file gets its own fork, so a suite that leaves a variable naming a deleted
// directory takes the evidence with it when the fork exits, and `--no-isolate`
// hands that dead value to every later file. That is #1028.
//
// test/home-redirect.test.ts pins the helper's contract; this pins the call
// sites. Registered as a setup file, its afterAll is the last one to run for
// every test file — vitest's default `sequence.hooks: "stack"` unwinds in
// reverse registration order, and a setup file registers before the test module
// is imported — so it sees whatever the file's own afterAll left behind.

/** The variables a suite here changes and must put back. */
export const SCOPED_ENV_VARS = ["HOME", "USERPROFILE", "PATH"];

// A PATH, or an OTLP header, runs to well over a kilobyte, and the tail of it is
// never what changed. Unset is spelled out rather than stringified, so a restore
// that assigned an undefined saved value back — writing the string "undefined" —
// does not report itself as `undefined -> undefined`.
const abbreviate = (value: string | undefined): string =>
  value === undefined ? "(unset)" : value.length <= 60 ? value : `${value.slice(0, 60)}…`;

// Read at module load, which for a setup file is before the test module is
// imported. Snapshotting inside the hook instead would compare the environment
// with itself and pass whatever the file left behind.
const AMBIENT = Object.fromEntries(SCOPED_ENV_VARS.map((name) => [name, process.env[name]]));

/** Throws naming every variable the file failed to put back, or returns. */
function assertEnvRestored(): void {
  const leaked = SCOPED_ENV_VARS.filter((name) => process.env[name] !== AMBIENT[name]).map(
    (name) => `${name}: ${abbreviate(AMBIENT[name])} -> ${abbreviate(process.env[name])}`
  );
  if (leaked.length === 0) return;
  throw new Error(
    `this file left the process environment modified; put it back in the same hook that ` +
      `changed it. ${leaked.join("; ")}`
  );
}

afterAll(() => assertEnvRestored());
