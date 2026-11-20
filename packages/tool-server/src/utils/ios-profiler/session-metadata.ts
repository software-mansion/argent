import { promises as fs } from "fs";
import { z } from "zod";
import { FAILURE_CODES, FailureError } from "@argent/registry";

/**
 * What native-profiler-analyze reads from a Mac app session besides the exports.
 * native-profiler-stop saves it next to the trace, and profiler-load restores it,
 * so a loaded session keeps the notes of the live one: the raw_*.xml exports hold
 * none of it.
 */
const xctraceSessionMetadataSchema = z.object({
  appSuspensions: z.array(z.object({ startNs: z.number(), endNs: z.number() })).nullable(),
  recordedMs: z.number().nullable(),
  appEndedDuringCapture: z.boolean(),
});

type XctraceSessionMetadata = z.infer<typeof xctraceSessionMetadataSchema>;

function xctraceSessionMetadataPath(traceFile: string): string {
  return `${traceFile}.metadata.json`;
}

export async function writeXctraceSessionMetadata(
  traceFile: string,
  metadata: XctraceSessionMetadata
): Promise<void> {
  await fs.writeFile(
    xctraceSessionMetadataPath(traceFile),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8"
  );
}

/** Null when the session has no metadata file: an iOS session, or one saved before this file existed. */
export async function readXctraceSessionMetadata(
  traceFile: string
): Promise<XctraceSessionMetadata | null> {
  const metadataPath = xctraceSessionMetadataPath(traceFile);
  let raw: string;
  try {
    raw = await fs.readFile(metadataPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  const result = xctraceSessionMetadataSchema.safeParse(parsed);
  if (!result.success) {
    throw new FailureError(
      `The native profiler metadata file ${metadataPath} is not valid. Delete it to load the ` +
        `session without it.`,
      {
        error_code: FAILURE_CODES.PROFILER_NATIVE_METADATA_INVALID,
        failure_stage: "xctrace_metadata_validate",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }
  return result.data;
}
