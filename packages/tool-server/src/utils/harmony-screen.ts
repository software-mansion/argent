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

/**
 * Capture the HarmonyOS display and return the path to a host-side PNG.
 *
 * `uitest screenCap` always writes the panel at full resolution — there is no
 * scale flag — so a Mate 60 frame arrives as a ~250KB 1216x2688 RGBA PNG. The
 * downscale therefore happens here, through the same shared helper Vega uses,
 * so `ARGENT_SCREENSHOT_SCALE` and the 0.25 default mean the same thing on
 * HarmonyOS as everywhere else.
 */
export async function captureHarmonyScreenshotPng(opts: {
  connectKey: string;
  scale?: number;
}): Promise<string> {
  const rawPath = join(tmpdir(), `argent-harmony-raw-${process.hrtime.bigint()}.png`);
  try {
    await harmonyScreenCap(opts.connectKey, rawPath);
    // The capture itself is checked upstream — `uitest screenCap` exits 1 on a
    // failure (measured) and `runUitest` throws on that — so what is left for
    // the decode is the pull: a transfer that reported success and delivered a
    // truncated file, which nothing before this point can see. `dumpLayout`'s
    // parse sits in the same position for the same reason, and names the device
    // and the byte count rather than leaving the decoder's own words to explain
    // an empty screenshot.
    const decoded = decodeCapture(await readFile(rawPath), opts.connectKey);
    const scaled = scaleDecodedPng(decoded, opts.scale);
    const outPath = join(tmpdir(), `harmony-screenshot-${process.hrtime.bigint()}.png`);
    if (scaled === decoded) {
      // Identity — what screenshot-diff's scale 1.0 asks for. Re-encoding pixels
      // the resample never touched costs ~100ms per 3.7MP frame to reproduce the
      // file `uitest` already wrote, so move that one into place instead.
      // Comparing against the helper's own return, rather than re-deriving the
      // threshold, keeps one definition of which scales resample.
      await rename(rawPath, outPath);
    } else {
      await writeFile(outPath, PNG.sync.write(scaled));
    }
    return outPath;
  } finally {
    await rm(rawPath, { force: true }).catch(() => {});
  }
}
