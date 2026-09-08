import { afterAll } from "vitest";

// Nine suites in this package point HOME (and USERPROFILE, which os.homedir()
// reads on Windows) at a temp dir and then delete that dir; two do the same to
// PATH. Restoring is the half that is easy to omit and impossible to notice:
// under the shipped `isolate: true` each file gets its own fork, so a suite that
// leaves a variable naming a deleted directory takes the evidence with it when
// the fork exits, and `--no-isolate` hands that dead value to every later file.
// That is #1028.
//
// test/home-redirect.test.ts pins the helper's contract; nothing pinned the call
// sites, so stripping `restoreHome()` from the eight launcher/link-config suites
// and artifacts.test.ts left the package green. This closes that: registered as
// a setup file, its afterAll is the last one to run for every test file
// (vitest's default `sequence.hooks: "stack"` unwinds in reverse registration
// order, and a setup file registers before the test module is imported), so it
// sees whatever the file's own afterAll left behind.

/** The variables a suite here redirects at a directory it later deletes. */
export const SCOPED_ENV_VARS = ["HOME", "USERPROFILE", "PATH"];

// PATH runs to well over a kilobyte, and the tail of it is never what changed.
const abbreviate = (value: string | undefined): string =>
  value === undefined || value.length <= 60 ? String(value) : `${value.slice(0, 60)}…`;

/** One `name: before -> after` line per variable the file failed to put back. */
export function leakedEnvVars(
  ambient: Record<string, string | undefined>,
  current: NodeJS.ProcessEnv = process.env
): string[] {
  return SCOPED_ENV_VARS.filter((name) => current[name] !== ambient[name]).map(
    (name) => `${name}: ${abbreviate(ambient[name])} -> ${abbreviate(current[name])}`
  );
}

const AMBIENT = Object.fromEntries(SCOPED_ENV_VARS.map((name) => [name, process.env[name]]));

afterAll(() => {
  const leaked = leakedEnvVars(AMBIENT);
  if (leaked.length > 0) {
    throw new Error(
      `this file left the process environment redirected; restore it in the same hook that ` +
        `deletes the temp dir (test/helpers/home-redirect.ts returns the restorer). ${leaked.join("; ")}`
    );
  }
});
