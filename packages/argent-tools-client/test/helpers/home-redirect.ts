// The launcher and link-config build their `~/.argent` paths from `os.homedir()`,
// so a suite that wants an isolated one points HOME — and USERPROFILE, which is
// what homedir() reads on Windows — at a temp dir before importing them.
//
// Putting both back is the half that is easy to omit and impossible to notice:
// those suites delete that temp dir too, so a variable left behind names a path
// that no longer exists. `isolate: true` hides it — each test file gets its own
// fork — but a `--no-isolate` run hands the dead home to every file after it.
//
// The restorer is returned rather than registered as an `afterAll` so the same
// call serves both lifecycles: the launcher suites redirect per file,
// `artifacts.test.ts` per test.
export function redirectHomeTo(dir: string): () => void {
  const saved: Record<string, string | undefined> = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  };
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  return () => {
    for (const [name, value] of Object.entries(saved)) {
      // Delete rather than assign: `process.env.X = undefined` stores the string
      // "undefined", which homedir() would then resolve as a relative path.
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}
