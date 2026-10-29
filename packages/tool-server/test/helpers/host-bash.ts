import { buildChildEnv } from "../../src/tools/flows/script/flow-script-executor";
import { resolveBashInterpreter } from "../../src/tools/flows/script/flow-script-interpreter";

/**
 * The bash a file of steps runs under, or why it cannot run here, so a
 * developer machine without one skips those files with the reason. Asked the
 * way the steps ask it (same resolver, environment and home directory), so a
 * global `scripts.bash` pin is honoured here as it is there. On CI a missing
 * bash fails instead: a skip from `beforeEach` exits 0 having asserted nothing.
 */
export async function resolveHostBash(): Promise<{ path: string } | { problem: string }> {
  const found = await resolveBashInterpreter(buildChildEnv(undefined));
  // No abort signal is passed, so nothing cancels this lookup.
  if ("cancelled" in found) return { problem: "the bash lookup was cancelled" };
  if (!("path" in found) && process.env.CI) {
    throw new Error(
      `This CI host has no bash, so every bash step in this file would be skipped: ${found.problem}`
    );
  }
  return found;
}
