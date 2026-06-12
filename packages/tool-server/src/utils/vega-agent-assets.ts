import * as path from "node:path";
import * as fs from "node:fs";

/**
 * Locates the on-device Vega agent binary + its manifest.
 *
 * The agent is a static aarch64-linux binary that runs ON the Vega device (the
 * inverse of simulator-server, which runs on the host). Its Rust source lives in
 * `packages/native-devtools-vega/agent`; the built binary is vendored to
 * `packages/native-devtools-vega/bin/` (gitignored) and the committed
 * `agent.manifest.json` carries the version/sha used for deploy-if-missing.
 *
 * Resolution: env override first, else a path relative to this module. In dev
 * (running tool-server from source or its `dist/`) `__dirname` is
 * `…/packages/tool-server/{src,dist}/utils`, so three levels up is `…/packages`.
 * When tool-server is bundled into the published `argent` package this relative
 * path won't hold — set ARGENT_VEGA_AGENT_BIN / _DIR there (a bundling step that
 * copies bin/ + manifest into the package is the planned fast-follow).
 */

export interface VegaAgentManifest {
  version: string;
  sha256: string;
  deviceBinName: string;
  deviceBinPath: string;
  devicePort: number;
  protocol: string;
}

function packageRoot(): string {
  return (
    process.env.ARGENT_VEGA_AGENT_DIR ??
    path.join(__dirname, "..", "..", "..", "native-devtools-vega")
  );
}

let cachedManifest: VegaAgentManifest | null = null;

export function agentManifest(): VegaAgentManifest {
  if (cachedManifest) return cachedManifest;
  const manifestPath =
    process.env.ARGENT_VEGA_AGENT_MANIFEST ?? path.join(packageRoot(), "agent.manifest.json");
  cachedManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as VegaAgentManifest;
  return cachedManifest;
}

export function bundledAgentBinaryPath(): string {
  const manifest = agentManifest();
  const binPath =
    process.env.ARGENT_VEGA_AGENT_BIN ?? path.join(packageRoot(), "bin", manifest.deviceBinName);
  if (!fs.existsSync(binPath)) {
    throw new Error(
      `Vega agent binary not found at ${binPath}. Build it with ` +
        `\`cargo build --release --target aarch64-unknown-linux-musl\` in ` +
        `packages/native-devtools-vega/agent, then copy target/.../argent-vega-agent to bin/.`
    );
  }
  return binPath;
}
