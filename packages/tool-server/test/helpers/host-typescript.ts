import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Whether `node file.mts` runs on this host, found by running one.
 *
 * The tests that execute a TypeScript script need to know which side of that
 * line they are on, and may not ask the code under test: gated on the product's
 * own check, a change that makes it refuse every TypeScript script skips those
 * tests instead of failing them. Node's answer cannot be bent that way, and it
 * also holds on a build compiled without the stripper, where the release says
 * yes and the binary cannot.
 *
 * `NODE_OPTIONS` is dropped as the executor drops it, so a flag in the shell
 * that started the suite does not answer for a script's process.
 */
export const hostRunsTypeScript: boolean = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "host-typescript-"));
  try {
    const file = path.join(dir, "probe.mts");
    fs.writeFileSync(file, "const answer: number = 42;\nprocess.exit(answer === 42 ? 0 : 1);\n");
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    return spawnSync(process.execPath, [file], { env, stdio: "ignore" }).status === 0;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();
