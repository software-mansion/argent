import { spawn } from "node:child_process";
import { resolveVegaBinary, runVega } from "./vega-cli";

export interface VegaLogCapture {
  /** The captured (and possibly filtered/tail-trimmed) log text. */
  text: string;
  /** Number of lines in `text`. */
  lines: number;
  /** True if older lines were dropped to honour `maxLines`. */
  truncated: boolean;
  /** Actual capture window in ms. */
  capturedMs: number;
}

/**
 * Capture a bounded window of device logs by running `vega device
 * start-log-stream` for `durationMs`, collecting its output, then stopping the
 * stream. `filter` is a case-insensitive substring match (kept deliberately
 * non-regex to avoid ReDoS on agent-supplied input). Only the last `maxLines`
 * lines are returned; `truncated` flags when earlier lines were dropped.
 */
export async function captureVegaDeviceLogs(
  opts: {
    durationMs?: number;
    filter?: string;
    maxLines?: number;
  } = {}
): Promise<VegaLogCapture> {
  const bin = await resolveVegaBinary();
  if (!bin) {
    throw new Error(
      "`vega` (or `kepler`) not found on PATH or under `~/vega/bin`. Install the Vega SDK and retry."
    );
  }
  const durationMs = Math.min(Math.max(opts.durationMs ?? 5_000, 500), 30_000);
  const maxLines = Math.min(Math.max(opts.maxLines ?? 2_000, 1), 20_000);
  const needle = opts.filter?.toLowerCase();

  const lines: string[] = [];
  let buffer = "";
  const consume = (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (needle && !line.toLowerCase().includes(needle)) continue;
      lines.push(line);
    }
  };

  const child = spawn(bin, ["device", "start-log-stream"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  // The stream writes to stdout; surface stderr too in case diagnostics land there.
  child.stdout.on("data", consume);
  child.stderr.on("data", consume);

  const start = Date.now();
  await new Promise<void>((resolve) => setTimeout(resolve, durationMs));
  child.kill("SIGKILL");
  const capturedMs = Date.now() - start;
  // Best-effort: tell the device to stop streaming so a left-over stream session
  // doesn't accumulate on the device side. Not counted in capturedMs (teardown).
  await runVega(["device", "stop-log-stream"], { timeoutMs: 15_000 }).catch(() => {});

  const truncated = lines.length > maxLines;
  const kept = truncated ? lines.slice(-maxLines) : lines;
  return {
    text: kept.join("\n"),
    lines: kept.length,
    truncated,
    capturedMs,
  };
}
