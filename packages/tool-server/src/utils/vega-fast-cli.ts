import * as path from "node:path";
import * as fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
// A hung vega-fast-cli can be blocked in adb; SIGKILL guarantees reaping.
const KILL_SIGNAL = "SIGKILL" as const;

/**
 * Resolve + run the `vega-fast-cli` host binary.
 *
 * `vega-fast-cli` (its own repo: software-mansion-labs/vega-fast-cli) is the
 * single source of truth for Vega input/inspection: it discovers the VVD,
 * deploys + starts the embedded on-device server if needed, then runs the
 * command. argent bundles its per-host binary (like simulator-server) and shells
 * out to it.
 *
 * Resolution (mirrors `simulatorServerBinaryPath`): `ARGENT_VEGA_FAST_CLI_BIN`
 * (a direct path) wins; else `bin/<platform>/vega-fast-cli` under either the
 * bundled root (`<pkg>/bin`, where `__dirname` is `<pkg>/dist`) or the dev
 * download-staging root (`packages/native-devtools-vega/bin`).
 * `ARGENT_VEGA_FAST_CLI_DIR` overrides that root (the parent of `<platform>/`).
 */
function candidateBinPaths(): string[] {
  const direct = process.env.ARGENT_VEGA_FAST_CLI_BIN;
  if (direct) return [direct];

  const roots: string[] = [];
  const envDir = process.env.ARGENT_VEGA_FAST_CLI_DIR;
  if (envDir) {
    roots.push(envDir);
  } else {
    roots.push(path.join(__dirname, "..", "bin")); // bundled: <pkg>/dist → <pkg>/bin
    roots.push(path.join(__dirname, "..", "..", "..", "native-devtools-vega", "bin")); // dev staging
  }
  return roots.map((r) => path.join(r, process.platform, "vega-fast-cli"));
}

export function vegaFastCliPath(): string {
  const candidates = candidateBinPaths();
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error(
    `vega-fast-cli binary not found for platform "${process.platform}". Looked in:\n  ` +
      `${candidates.join("\n  ")}\n` +
      `Run: bash scripts/download-vega-fast-cli.sh, or set ARGENT_VEGA_FAST_CLI_BIN.`
  );
}

export interface VegaFastCliResult {
  stdout: string;
  stderr: string;
}

/** Run the bundled vega-fast-cli with the given argv; throws on non-zero exit. */
export async function runVegaFastCli(
  args: string[],
  options: { timeoutMs?: number } = {}
): Promise<VegaFastCliResult> {
  const bin = vegaFastCliPath();
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: options.timeoutMs ?? 30_000,
      killSignal: KILL_SIGNAL,
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf-8",
    });
    return { stdout, stderr };
  } catch (err) {
    throw describeFailure(args, err);
  }
}

function describeFailure(args: string[], err: unknown): Error {
  const e = err as {
    stderr?: string;
    stdout?: string;
    message?: string;
    signal?: string | null;
    code?: number | string | null;
  };
  const argv = args.join(" ");
  const detail = (e.stderr ?? "").trim() || (e.stdout ?? "").trim();
  if (detail) return new Error(`vega-fast-cli ${argv} failed: ${detail}`);
  const meta = [
    e.signal ? `signal=${e.signal}` : null,
    e.code != null ? `code=${e.code}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const base = (e.message ?? String(err)).trim();
  return new Error(`vega-fast-cli ${argv} failed: ${base}${meta ? ` (${meta})` : ""}`);
}
