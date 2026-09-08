import { buildChildEnv } from "../../src/tools/flows/script/flow-script-executor";
import { resolveBashInterpreter } from "../../src/tools/flows/script/flow-script-interpreter";

/**
 * The bash a file of steps runs under, or why it cannot run here. The resolver
 * itself is unit-tested on every host in `flow-script-interpreter.test.ts`, so
 * a developer machine with no bash skips those files with the reason rather
 * than failing on it.
 *
 * Asked exactly the way the steps below ask it - same resolver, same
 * environment, same home directory. A gate that reads a home of its own answers
 * about a bash the steps never run under: a developer who took this feature's
 * own advice and pinned a bash globally had the gate approve the host's 5.3
 * while every step ran under the pinned 3.2, and a global pin at a path that
 * does not exist made the whole file FAIL - reading as a source regression -
 * where the gate's whole purpose is to skip it with the reason.
 *
 * On CI the absence of a bash is a failure rather than a skip. `ctx.skip` from
 * a `beforeEach` reports skipped and exits 0, so a runner that found no bash
 * would take every one of these files green having asserted nothing - on
 * Windows, the platform they were listed for.
 */
export async function resolveHostBash(): Promise<{ path: string } | { problem: string }> {
  const found = await resolveBashInterpreter(undefined, buildChildEnv(undefined));
  // No abort signal is passed, so nothing cancels this lookup.
  if ("cancelled" in found) return { problem: "the bash lookup was cancelled" };
  if (!("path" in found) && process.env.CI) {
    throw new Error(
      `This CI host has no bash, so every bash step in this file would be skipped: ${found.problem}`
    );
  }
  return found;
}
