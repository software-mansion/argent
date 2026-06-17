import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { resolveDevice } from "../../utils/device-info";
import { UnsupportedOperationError } from "../../utils/capability";
import { captureVegaDeviceLogs } from "../../utils/vega-logs";
import { requireArtifacts, type ArtifactHandle } from "../../artifacts";

const zodSchema = z.object({
  udid: z.string().describe("Target Vega device id from `list-devices`."),
  durationMs: z
    .number()
    .int()
    .min(500)
    .max(30_000)
    .optional()
    .describe("How long to capture the device log stream, in ms (default 5000, max 30000)."),
  filter: z
    .string()
    .optional()
    .describe(
      "Case-insensitive substring; only log lines containing it are kept (e.g. an app id, 'ERROR', or 'KB key')."
    ),
  maxLines: z
    .number()
    .int()
    .min(1)
    .max(20_000)
    .optional()
    .describe("Keep at most this many (most recent) lines (default 2000)."),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
  logs: string;
  lines: number;
  truncated: boolean;
  capturedMs: number;
  /** The full capture, also written to a file artifact for convenience. */
  artifact: ArtifactHandle;
}

const capability: ToolCapability = {
  // Virtual-Device-only in v1: physical Fire TV is unverified, and the Vega
  // handler targets the single running VVD. Keep `vega` uniformly `virtual`
  // across the tool suite until hardware is validated.
  vega: { virtual: true },
};

export const readDeviceLogsTool: ToolDefinition<Params, Result> = {
  id: "read-device-logs",
  description: `Capture a bounded window of Vega (Fire TV) device logs via the on-device log stream.
Use to diagnose crashes, see app output, or confirm input/navigation is reaching the app (e.g. filter: "KB key" or "ERROR"). Captures for durationMs, then stops the stream.
Returns { logs, lines, truncated, capturedMs, artifact }. logs is the captured text (filtered to filter, tail-trimmed to maxLines); the full capture is also saved as a text artifact.`,
  searchHint: "vega fire tv device logs logcat log stream crash error diagnose output",
  longRunning: true,
  zodSchema,
  capability,
  services: () => ({}),
  async execute(_services, params, ctx) {
    const device = resolveDevice(params.udid);
    if (device.platform !== "vega") {
      throw new UnsupportedOperationError("read-device-logs", device, "Vega-only");
    }
    const capture = await captureVegaDeviceLogs({
      durationMs: params.durationMs,
      filter: params.filter,
      maxLines: params.maxLines,
    });
    const path = join(tmpdir(), `vega-logs-${process.hrtime.bigint()}.txt`);
    await writeFile(path, capture.text, "utf-8");
    const artifact = await requireArtifacts(ctx).register(path, { mimeType: "text/plain" });
    return {
      logs: capture.text,
      lines: capture.lines,
      truncated: capture.truncated,
      capturedMs: capture.capturedMs,
      artifact,
    };
  },
};
