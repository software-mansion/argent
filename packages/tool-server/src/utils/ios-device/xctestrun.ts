import * as fsp from "node:fs/promises";
import { buildPlist, readPlistFile, type PlistValue } from "../plist";

/**
 * Reading and rewriting an `.xctestrun`, the plist xcodebuild produces for a
 * built test bundle.
 */

export type XctestrunDocument = Record<string, unknown>;

export async function readXctestrun(sourcePath: string): Promise<XctestrunDocument> {
  return (await readPlistFile(sourcePath)) as XctestrunDocument;
}

/** Every test target in the document: the keys that are not metadata. */
function targets(document: XctestrunDocument): Record<string, unknown>[] {
  return Object.entries(document)
    .filter(([key, value]) => !key.startsWith("__") && typeof value === "object" && value !== null)
    .map(([, value]) => value as Record<string, unknown>);
}

/**
 * The apps an xctestrun expects on the phone: the test host (the runner app,
 * whose bundle id the xctestrun states) and the UI target it launches.
 * `__TESTROOT__` is the directory of the xctestrun.
 */
export function runnerAppsFromXctestrun(
  document: XctestrunDocument,
  testRoot: string
): Array<{ path: string; bundleId?: string }> {
  const apps: Array<{ path: string; bundleId?: string }> = [];

  for (const target of targets(document)) {
    const resolve = (raw: unknown) =>
      typeof raw === "string" ? raw.replace("__TESTROOT__", testRoot) : undefined;

    const host = resolve(target.TestHostPath);
    const uiTarget = resolve(target.UITargetAppPath);

    if (host) {
      const bundleId = target.TestHostBundleIdentifier;
      apps.push({ path: host, ...(typeof bundleId === "string" ? { bundleId } : {}) });
    }

    if (uiTarget) apps.push({ path: uiTarget });
  }

  return apps;
}

/** The runner's bundle id, from the first test target that states one. */
export function runnerBundleIdFromXctestrun(document: XctestrunDocument): string | undefined {
  for (const target of targets(document)) {
    if (typeof target.TestHostBundleIdentifier === "string") return target.TestHostBundleIdentifier;
  }

  return undefined;
}

/**
 * Copy an xctestrun, adding `ARGENT_RUNNER_PORT` to the runner's environment.
 * Returns the document it wrote.
 */
export async function writeXctestrunWithRunnerPort(
  sourcePath: string,
  targetPath: string,
  port: number
): Promise<XctestrunDocument> {
  const document = await readXctestrun(sourcePath);

  for (const target of targets(document)) {
    for (const envKey of ["EnvironmentVariables", "TestingEnvironmentVariables"]) {
      const env = (target[envKey] ??= {}) as Record<string, string>;
      env.ARGENT_RUNNER_PORT = String(port);
    }
  }

  await fsp.writeFile(targetPath, buildPlist(document as PlistValue));

  return document;
}
