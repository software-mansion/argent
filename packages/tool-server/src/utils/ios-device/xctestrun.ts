import { execFile } from "node:child_process";
import * as fsp from "node:fs/promises";
import { promisify } from "node:util";

/**
 * Reading and rewriting an `.xctestrun`, the plist xcodebuild produces for a
 * built test bundle. plutil does the plist round trip, so no plist writer is
 * needed here.
 */

const execFileAsync = promisify(execFile);

export type XctestrunDocument = Record<string, unknown>;

export async function readXctestrun(sourcePath: string): Promise<XctestrunDocument> {
  const { stdout } = await execFileAsync("plutil", ["-convert", "json", "-o", "-", sourcePath], {
    maxBuffer: 16 * 1024 * 1024,
  });

  return JSON.parse(stdout) as XctestrunDocument;
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

  const jsonPath = `${targetPath}.json`;
  await fsp.writeFile(jsonPath, JSON.stringify(document));

  try {
    await execFileAsync("plutil", ["-convert", "xml1", "-o", targetPath, jsonPath]);
  } finally {
    await fsp.rm(jsonPath, { force: true });
  }

  return document;
}
