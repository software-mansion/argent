import { readFile, rename, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import { harmonyScreenCap } from "./harmony-uitest";
import { scaleDecodedPng } from "./png-scale";

function decodeCapture(raw: Buffer, connectKey: string): PNG {
  try {
    return PNG.sync.read(raw);
  } catch (err) {
    throw new FailureError(
      `HarmonyOS device '${connectKey}' returned a screenshot that is not a readable PNG ` +
        `(${raw.length} bytes).`,
      {
        error_code: FAILURE_CODES.HARMONY_FILE_TRANSFER_FAILED,
        failure_stage: "harmony_screen_cap",
        failure_area: "tool_server",
        error_kind: "subprocess",
        failure_command: "hdc",
      },
      { cause: err as Error }
    );
  }
}

/** `uitest screenCap` has no scale flag, so the shared helper downscales here. */
export async function captureHarmonyScreenshotPng(opts: {
  connectKey: string;
  scale?: number;
}): Promise<string> {
  const rawPath = join(tmpdir(), `argent-harmony-raw-${process.hrtime.bigint()}.png`);
  try {
    await harmonyScreenCap(opts.connectKey, rawPath);
    // A transfer that reported success can still deliver a truncated file.
    const decoded = decodeCapture(await readFile(rawPath), opts.connectKey);
    const scaled = scaleDecodedPng(decoded, opts.scale);
    const outPath = join(tmpdir(), `harmony-screenshot-${process.hrtime.bigint()}.png`);
    if (scaled === decoded) {
      // Identity scale: move the capture rather than re-encode it.
      await rename(rawPath, outPath);
    } else {
      await writeFile(outPath, PNG.sync.write(scaled));
    }
    return outPath;
  } finally {
    await rm(rawPath, { force: true }).catch(() => {});
  }
}
