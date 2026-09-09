import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Whether a directory's mode actually refuses a write to it.
 *
 * Root ignores the bits, so a case that makes a directory read-only to force an
 * `EACCES` proves nothing there — and worse, the ones asserting the throw fail
 * for a reason that has nothing to do with the code. Probe, then `ctx.skip()`.
 *
 * Probed with a create rather than a stat: deciding it from the bits means
 * reimplementing the kernel's uid, gid and ACL check, and the one caller only
 * ever wants the answer the write itself would give.
 */
export function modeBites(dir: string): boolean {
  const probe = path.join(dir, `.mode-probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, "x");
  } catch {
    return true;
  }
  fs.rmSync(probe, { force: true });
  return false;
}
