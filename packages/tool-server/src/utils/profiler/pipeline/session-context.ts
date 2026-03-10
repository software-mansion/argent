import { promises as fs } from "fs";
import { join } from "path";
import type { RawProfilingInput } from "../types/input";
import type { SessionContext } from "../types/pipeline";

async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
}

export async function detectSessionContext(
  input: RawProfilingInput,
): Promise<SessionContext> {
  const { projectRoot, platform } = input.sessionMeta;

  // reactCompilerEnabled
  let reactCompilerEnabled = false;
  const packageJson = await readFileSafe(join(projectRoot, "package.json"));
  if (packageJson) {
    try {
      const pkg = JSON.parse(packageJson) as Record<string, unknown>;
      const allDeps = {
        ...((pkg["dependencies"] as Record<string, unknown> | undefined) ?? {}),
        ...((pkg["devDependencies"] as Record<string, unknown> | undefined) ??
          {}),
      };
      if ("babel-plugin-react-compiler" in allDeps) {
        reactCompilerEnabled = true;
      }
    } catch {
      // ignore
    }
  }
  if (!reactCompilerEnabled) {
    const babelConfigJs = await readFileSafe(
      join(projectRoot, "babel.config.js"),
    );
    const babelConfigTs = await readFileSafe(
      join(projectRoot, "babel.config.ts"),
    );
    const babelSource = (babelConfigJs ?? "") + (babelConfigTs ?? "");
    if (babelSource.includes("react-compiler")) {
      reactCompilerEnabled = true;
    }
  }

  // strictModeEnabled
  let strictModeEnabled = false;
  const indexJs = await readFileSafe(join(projectRoot, "index.js"));
  const indexTs = await readFileSafe(join(projectRoot, "index.ts"));
  const indexSource = (indexJs ?? "") + (indexTs ?? "");
  if (
    indexSource.includes("<StrictMode>") ||
    indexSource.includes("StrictMode")
  ) {
    strictModeEnabled = true;
  }

  // buildMode — infer from flamegraph node URLs (flamegraph is optional)
  let buildMode: "dev" | "prod" = "dev";
  if (input.flamegraph) {
    for (const node of input.flamegraph.nodes) {
      if (node.callFrame.url && node.callFrame.url.includes(".bundle")) {
        buildMode = node.callFrame.url.includes("dev=false") ? "prod" : "dev";
        break;
      }
    }
  }

  // rnArchitecture
  let rnArchitecture: "bridge" | "bridgeless";
  if (input.sessionMeta.detectedArchitecture !== undefined) {
    rnArchitecture = input.sessionMeta.detectedArchitecture;
  } else {
    const rnVersionStr = input.sessionMeta.rnVersion ?? "";
    const rnMinor = parseInt(rnVersionStr.split(".")[1] ?? "0", 10);
    const newArchDefault = rnMinor >= 76;
    rnArchitecture = newArchDefault ? "bridgeless" : "bridge";

    if (platform === "android") {
      const gradleProps = await readFileSafe(
        join(projectRoot, "android", "gradle.properties"),
      );
      if (gradleProps) {
        if (newArchDefault && gradleProps.includes("newArchEnabled=false")) {
          rnArchitecture = "bridge";
        } else if (
          !newArchDefault &&
          gradleProps.includes("newArchEnabled=true")
        ) {
          rnArchitecture = "bridgeless";
        }
      }
    } else {
      const podfile = await readFileSafe(join(projectRoot, "ios", "Podfile"));
      if (podfile) {
        if (
          newArchDefault &&
          (podfile.includes("RCT_NEW_ARCH_ENABLED'] = '0'") ||
            podfile.includes("RCT_NEW_ARCH_ENABLED=0"))
        ) {
          rnArchitecture = "bridge";
        } else if (!newArchDefault && podfile.includes("fabric_enabled")) {
          rnArchitecture = "bridgeless";
        }
      }
    }
  }

  return {
    reactCompilerEnabled,
    strictModeEnabled,
    buildMode,
    rnArchitecture,
    projectRoot,
    platform,
  };
}
