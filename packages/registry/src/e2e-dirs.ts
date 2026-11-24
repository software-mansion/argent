/**
 * Where a project keeps its e2e tests. New tests are written to
 * {@link E2E_DIR}; a test is looked up there first, then in each of
 * {@link LEGACY_E2E_DIRS}, which hold the tests saved before the rename and are
 * still read. Shared by the tool-server, the argent client and the CLI, so all
 * three pick the same file for a name.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Where e2e tests are saved, relative to the project root. */
export const E2E_DIR = path.join(".argent", "e2e");

/** Where e2e tests were saved before, relative to the project root: read, never written. */
export const LEGACY_E2E_DIRS: readonly string[] = Object.freeze([path.join(".argent", "flows")]);

/** Every directory a test is looked up in, relative to the project root, in lookup order. */
export const E2E_DIRS: readonly string[] = Object.freeze([E2E_DIR, ...LEGACY_E2E_DIRS]);

/** The directory new e2e tests are written to under `projectRoot`. */
export function e2eDirFor(projectRoot: string): string {
  return path.join(projectRoot, E2E_DIR);
}

/** Every directory a test is looked up in under `projectRoot`, in lookup order. */
export function e2eDirsFor(projectRoot: string): string[] {
  return E2E_DIRS.map((dir) => path.join(projectRoot, dir));
}

/** `<dir>/<name>.yaml` in each directory of {@link e2eDirsFor}, in lookup order. */
export function e2eFileCandidates(projectRoot: string, name: string): string[] {
  return e2eDirsFor(projectRoot).map((dir) => path.join(dir, `${name}.yaml`));
}

/** The file a name picks among its candidates. */
export interface ResolvedE2eFile {
  /** The first candidate that exists, or the first candidate when none does. */
  path: string;
  /** Whether anything exists at `path`. */
  exists: boolean;
  /** Whether `path` is in a legacy directory (not the first candidate). */
  legacy: boolean;
  /** A later candidate that also exists, which `path` hides. */
  shadowed?: string;
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(
    () => true,
    () => false
  );
}

/**
 * Pick among `candidates` (absolute paths, in lookup order): the first one that
 * exists wins, and `shadowed` names the next one that exists too.
 */
export async function pickE2eFile(candidates: readonly string[]): Promise<ResolvedE2eFile> {
  for (let i = 0; i < candidates.length; i++) {
    if (!(await exists(candidates[i]!))) continue;
    let shadowed: string | undefined;
    for (const later of candidates.slice(i + 1)) {
      if (await exists(later)) {
        shadowed = later;
        break;
      }
    }
    return {
      path: candidates[i]!,
      exists: true,
      legacy: i > 0,
      ...(shadowed === undefined ? {} : { shadowed }),
    };
  }
  return { path: candidates[0]!, exists: false, legacy: false };
}

/**
 * The e2e test `name` under `projectRoot`: `<projectRoot>/.argent/e2e/<name>.yaml`
 * when it exists, else `<projectRoot>/.argent/flows/<name>.yaml` when that
 * exists, else the `.argent/e2e` path. Validates neither argument.
 */
export function resolveE2eFile(projectRoot: string, name: string): Promise<ResolvedE2eFile> {
  return pickE2eFile(e2eFileCandidates(projectRoot, name));
}

/** The one-line warning for a test that hides another of the same name. */
export function e2eShadowWarning(used: string, shadowed: string): string {
  return `${shadowed} is not used: ${used} has the same name and is read first.`;
}

/** The directory names under `.argent` that hold e2e tests, in lookup order. */
const E2E_DIR_NAMES = E2E_DIRS.map((dir) => path.basename(dir));

/**
 * The project root of an e2e test directory: `<P>` for `<P>/.argent/e2e` or
 * `<P>/.argent/flows`, else null. Lexical: no link is followed.
 */
export function e2eDirProject(dir: string): string | null {
  const trimmed = dir.length > 1 ? dir.replace(/[\\/]+$/, "") : dir;
  const argent = path.dirname(trimmed);
  if (!E2E_DIR_NAMES.includes(path.basename(trimmed)) || path.basename(argent) !== ".argent") {
    return null;
  }
  return path.dirname(argent);
}

/**
 * Where a `run:` target that is missing beside the file naming it is looked up
 * next: when that file is in an e2e test directory of a project and the
 * target is a bare file name, the project's other e2e test directories, in
 * lookup order. Else none. So a test in `.argent/e2e` can `run:` a fragment
 * that is still in `.argent/flows`, and the reverse.
 */
export function e2eRunFallbackDirs(anchorDir: string, target: string): string[] {
  if (target.includes("/") || target.includes("\\")) return [];
  const project = e2eDirProject(anchorDir);
  if (project === null) return [];
  const anchor = path.resolve(anchorDir);
  return e2eDirsFor(project).filter((dir) => path.resolve(dir) !== anchor);
}
