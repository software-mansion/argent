import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFlag } from "@argent/configuration-core";
import { afterEach, beforeEach } from "vitest";
import { scopeTempHome } from "./temp-home";

/**
 * Runs every test of the calling scope with neither of the developer's flags
 * files: a fresh HOME holds the global one, and a fresh project folder, the
 * working directory during the test, holds the project one, which shadows the
 * global one. Under vitest the project file is otherwise
 * `packages/tool-server/.argent/flags.json`, which `.gitignore` hides.
 *
 * Call at file top level, or at the top of a describe.
 */
export function scopeTempFlags(): void {
  scopeTempHome("argent-macos-test-home-");
  let cwd = "";
  let project = "";

  beforeEach(() => {
    cwd = process.cwd();
    project = mkdtempSync(join(tmpdir(), "argent-macos-test-project-"));
    // A marker, so the project root lookup stops here and reads no folder above.
    writeFileSync(join(project, "package.json"), "{}");
    process.chdir(project);
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(project, { recursive: true, force: true });
  });
}

/**
 * Runs every test of the calling file with the `macos-apps` flag on, and with
 * neither of the developer's flags files ({@link scopeTempFlags}), so their own
 * flags never leak in. The flag is read per call, so `off()` takes effect for
 * the rest of the test.
 *
 * Call at file top level.
 */
export function useMacosAppsFlag(): { on: () => void; off: () => void } {
  scopeTempFlags();
  const on = () => setFlag("macos-apps", true, "global");
  beforeEach(on);
  return { on, off: () => setFlag("macos-apps", false, "global") };
}
