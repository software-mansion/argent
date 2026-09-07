import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveBashInterpreter } from "../../src/tools/flows/script/flow-script-interpreter";

/**
 * The bash a file of steps runs under, or why it cannot run here. The
 * resolver itself is unit-tested on every host in
 * `flow-script-interpreter.test.ts`, so a developer machine with no bash skips
 * those files with the reason rather than failing on it.
 *
 * Resolved against a home directory of the test's own. `scripts.bash` is read
 * from BOTH scopes and the global one lives under the home directory, and
 * `test/setup/clear-argent-env.ts` strips `ARGENT_*` variables rather than
 * `~/.argent/config.json` — so a developer who took this feature's own advice
 * and pinned a bash globally ran every step below under that bash instead of
 * the host's.
 *
 * On CI the absence of a bash is a failure rather than a skip. `ctx.skip` from
 * a `beforeEach` reports skipped and exits 0, so a runner that found no bash
 * would take every one of these files green having asserted nothing — on
 * Windows, the platform they were listed for.
 */
export async function resolveHostBash(): Promise<{ path: string } | { problem: string }> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "argent-bash-host-"));
  const real = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  let found: { path: string } | { problem: string };
  try {
    found = await resolveBashInterpreter(undefined);
  } finally {
    for (const [name, value] of Object.entries(real)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
  if (!("path" in found) && process.env.CI) {
    throw new Error(
      `This CI host has no bash, so every bash step in this file would be skipped: ${found.problem}`
    );
  }
  return found;
}
