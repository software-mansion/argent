import * as path from "node:path";
import { findProjectRoot, isHomeDir, type FlagScope } from "@argent/configuration-core";

/**
 * Warns when "project" resolves somewhere surprising: to the home directory
 * (`~/.argent` is itself a project marker, and there the project file IS the
 * global one), or to the bare cwd because no marker was found. Must run BEFORE
 * the write: a project-scope write creates `.argent` in the resolved root,
 * hiding the no-marker case afterwards. `file` is the project-scope file the
 * command writes.
 */
export function degenerateProjectScopeWarning(scope: FlagScope, file: string): string | null {
  if (scope !== "project") return null;
  if (isHomeDir(path.dirname(path.dirname(file)))) {
    return (
      `WARNING: no project found between ${process.cwd()} and your home directory — ` +
      `"project" scope resolved to the home directory, so this writes the GLOBAL ` +
      `${path.basename(file, ".json")} file (${file}).`
    );
  }
  if (findProjectRoot(process.cwd()) === null) {
    return (
      `WARNING: no project markers (.argent, .git, package.json) found above ` +
      `${process.cwd()} — treating it as the project root and creating ${file}.`
    );
  }
  return null;
}
