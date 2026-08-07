import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";

/**
 * Point HOME — and USERPROFILE, which `os.homedir()` reads on Windows — at a
 * fresh temp directory around every test in the calling file, then remove it.
 *
 * Whatever reaches `os.homedir()` then resolves inside a directory this run
 * owns. LogFileWriter is the case that matters here: its constructor
 * mkdir -p's `os.homedir()/.argent/tmp`, so a suite that builds one — directly,
 * or through the JS-runtime-debugger blueprints — otherwise creates that
 * directory in the developer's real home.
 *
 * Call at file top level, so the hooks it registers run before any
 * describe-scoped hook that builds a writer.
 */
export function scopeTempHome(prefix = "argent-test-home-"): void {
  let active = "";
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved.HOME = process.env.HOME;
    saved.USERPROFILE = process.env.USERPROFILE;
    active = mkdtempSync(join(tmpdir(), prefix));
    process.env.HOME = active;
    process.env.USERPROFILE = active;
  });

  afterEach(() => {
    for (const k of ["HOME", "USERPROFILE"] as const) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(active, { recursive: true, force: true });
  });
}
