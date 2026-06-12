import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { adbShell } from "./adb";
import { resolveAndroidBinary } from "./android-binary";
import { agentManifest, bundledAgentBinaryPath, type VegaAgentManifest } from "./vega-agent-assets";

/**
 * Deploy-if-missing for the on-device Vega agent.
 *
 * `adb push` / `vega copy-to` cannot write `/scratch` (that daemon lands in a
 * read-only mount namespace), so the binary is streamed as base64 through
 * `adb shell` stdin and decoded on-device. The agent lives in tmpfs, so this
 * also re-deploys transparently after a device reboot once the `--version`
 * probe fails. Cached in-process per (serial, version).
 */

const deployed = new Map<string, true>();

function cacheKey(serial: string, version: string): string {
  return `${serial}|${version}`;
}

/** Probe the deployed agent's version via `<bin> --version`; null if absent/broken. */
async function probeInstalledVersion(
  serial: string,
  manifest: VegaAgentManifest
): Promise<string | null> {
  try {
    const out = await adbShell(serial, `${manifest.deviceBinPath} --version`, { timeoutMs: 5_000 });
    const match = out.trim().match(/argent-vega-agent\s+(\S+)/);
    return match ? match[1]! : null;
  } catch {
    return null;
  }
}

export async function ensureVegaAgentDeployed(serial: string): Promise<void> {
  const manifest = agentManifest();
  const key = cacheKey(serial, manifest.version);
  if (deployed.has(key)) return;

  const installed = await probeInstalledVersion(serial, manifest);
  if (installed === manifest.version) {
    deployed.set(key, true);
    return;
  }

  await deployBinary(serial, manifest);
  deployed.set(key, true);
}

async function deployBinary(serial: string, manifest: VegaAgentManifest): Promise<void> {
  const adbPath = await resolveAndroidBinary("adb");
  if (!adbPath) {
    throw new Error("`adb` not found on PATH or under `$ANDROID_HOME` while deploying Vega agent.");
  }

  const base64 = fs.readFileSync(bundledAgentBinaryPath()).toString("base64");
  const remote = manifest.deviceBinPath;
  const tmp = `${remote}.new`;
  // Kill any stale instance (so a redeploy frees port 8384), then decode to a
  // temp path and rename over the target — overwriting a running executable
  // in-place fails with ETXTBSY, but rename swaps the dir entry cleanly.
  const remoteCmd =
    `pkill -f ${manifest.deviceBinName} 2>/dev/null; ` +
    `base64 -d > ${tmp} && chmod +x ${tmp} && mv -f ${tmp} ${remote} && echo DEPLOY_OK`;

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(adbPath, ["-s", serial, "shell", remoteCmd], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf-8")));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf-8")));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0 && stdout.includes("DEPLOY_OK")) {
        resolve();
      } else {
        reject(
          new Error(
            `Vega agent deploy failed (code=${code}): ${(stderr.trim() || stdout.trim()).slice(0, 300)}`
          )
        );
      }
    });
    proc.stdin.write(base64);
    proc.stdin.end();
  });
}

/** Test-only: reset the deploy cache. */
export function __resetVegaAgentDeployCache(): void {
  deployed.clear();
}
