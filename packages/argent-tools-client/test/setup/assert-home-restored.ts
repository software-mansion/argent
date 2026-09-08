import { afterAll } from "vitest";

// Ten suites in this package point HOME (and USERPROFILE, which os.homedir()
// reads on Windows) at a temp dir and then delete that dir. Restoring is the
// half that is easy to omit and impossible to notice: under the shipped
// `isolate: true` each file gets its own fork, so a suite that leaves HOME
// naming a deleted directory takes the evidence with it when the fork exits,
// and `--no-isolate` hands that dead home to every later file. That is #1028.
//
// test/home-redirect.test.ts pins the helper's contract; nothing pinned the
// call sites, so stripping `restoreHome()` from all nine launcher/link-config
// suites left the package green. This closes that: registered as a setup file,
// its afterAll is the last one to run for every test file (vitest's default
// `sequence.hooks: "stack"` unwinds in reverse registration order, and a setup
// file registers before the test module is imported), so it sees whatever the
// file's own afterAll left behind.
const AMBIENT: Record<string, string | undefined> = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
};

afterAll(() => {
  const leaked = Object.entries(AMBIENT)
    .filter(([name, before]) => process.env[name] !== before)
    .map(([name, before]) => `${name}: ${String(before)} -> ${String(process.env[name])}`);
  if (leaked.length > 0) {
    throw new Error(
      `this file left the process environment redirected; restore it in the same hook that ` +
        `deletes the temp dir (test/helpers/home-redirect.ts returns the restorer). ${leaked.join("; ")}`
    );
  }
});
