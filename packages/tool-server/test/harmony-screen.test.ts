import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import {
  hdcFileRecv as realHdcFileRecv,
  runHdcShell as realRunHdcShell,
} from "../src/utils/harmony-hdc";
import { captureHarmonyScreenshotPng } from "../src/utils/harmony-screen";

// Only the transport is faked. `shellQuote` stays real so the assertions see
// the exact command lines the device would; the fetch writes a real (tiny)
// PNG so `captureHarmonyScreenshotPng`'s decode/scale path runs for true.
vi.mock("../src/utils/harmony-hdc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/harmony-hdc")>();
  return { ...actual, runHdcShell: vi.fn(), hdcFileRecv: vi.fn() };
});

const runHdcShell = vi.mocked(realRunHdcShell);
const hdcFileRecv = vi.mocked(realHdcFileRecv);

/** A minimal valid PNG — what `uitest screenCap` would have written. */
function tinyPng(): Buffer {
  return PNG.sync.write(new PNG({ width: 4, height: 4 }));
}

/**
 * A valid PNG whose bytes pngjs will not reproduce: the same pixels written
 * with the None row filter, as an encoder that is not pngjs — `uitest` — may
 * well have written them. Re-encoding changes the bytes while leaving the image
 * identical, which is what separates "moved the device's file" from "decoded it
 * and wrote it out again".
 */
function devicePng(width = 8, height = 12): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = (i * 7) % 256;
    png.data[i + 1] = (i * 13) % 256;
    png.data[i + 2] = (i * 29) % 256;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png, { filterType: 0 });
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** Serve `bytes` as the file `uitest screenCap` captured. */
function deviceServes(bytes: Buffer): void {
  hdcFileRecv.mockImplementation(async (_key, _remote, localPath) => {
    await writeFile(localPath, bytes);
  });
}

/** The remote path of every `uitest screenCap -p '<path>'` call, in order. */
function capturedRemotePaths(): string[] {
  return runHdcShell.mock.calls
    .map((c) => /screenCap -p '([^']+)'/.exec(c[1])?.[1])
    .filter((p): p is string => typeof p === "string");
}

const outPaths: string[] = [];

async function capture(): Promise<string> {
  const out = await captureHarmonyScreenshotPng({ connectKey: "dev", scale: 1 });
  outPaths.push(out);
  return out;
}

beforeEach(() => {
  runHdcShell.mockReset().mockResolvedValue({ stdout: "", exitCode: 0 });
  hdcFileRecv.mockReset();
});

afterEach(async () => {
  await Promise.all(outPaths.splice(0).map((p) => rm(p, { force: true }).catch(() => {})));
});

describe("harmonyScreenCap viaDeviceTmp", () => {
  it("removes the on-device capture even when the fetch fails", async () => {
    // Without the finally-delete, every failed screenshot leaves a
    // multi-hundred-KB PNG on /data/local/tmp, a partition nothing prunes.
    hdcFileRecv.mockRejectedValue(new Error("[Fail]Error opening file: no such file"));

    await expect(captureHarmonyScreenshotPng({ connectKey: "dev", scale: 1 })).rejects.toThrow(
      /Error opening file/
    );

    const [remotePath] = capturedRemotePaths();
    expect(remotePath).toMatch(/^\/data\/local\/tmp\/argent-\d+-\d+\.png$/);
    const commands = runHdcShell.mock.calls.map((c) => c[1]);
    // The rm runs after the screenCap (and after the failed recv), against
    // the exact path the capture wrote.
    expect(commands).toContain(`rm -f '${remotePath}'`);
    expect(commands.indexOf(`rm -f '${remotePath}'`)).toBeGreaterThan(
      commands.findIndex((c) => c.includes("screenCap"))
    );
  });

  it("uses a distinct remote path for two concurrent captures", async () => {
    // A fixed path would let one capture overwrite the other's between write
    // and fetch, silently handing the loser the winner's screen.
    hdcFileRecv.mockImplementation(async (_key, _remote, localPath) => {
      await writeFile(localPath, tinyPng());
    });

    const [a, b] = await Promise.all([capture(), capture()]);

    const paths = capturedRemotePaths();
    expect(paths).toHaveLength(2);
    expect(paths[0]).not.toBe(paths[1]);
    for (const p of paths) {
      expect(p).toContain(`/data/local/tmp/argent-${process.pid}-`);
    }
    // Both captures completed as real, readable PNGs.
    for (const out of [a, b]) {
      const decoded = PNG.sync.read(await readFile(out));
      expect([decoded.width, decoded.height]).toEqual([4, 4]);
    }
  });
});

describe("captureHarmonyScreenshotPng", () => {
  it("hands back the device's own bytes at full resolution", async () => {
    // screenshot-diff captures at scale 1, where scaleDecodedPng returns the
    // decoded image untouched — re-encoding it costs ~100ms per 3.7MP frame for
    // an image identical to the one hdc already delivered.
    const bytes = devicePng();
    deviceServes(bytes);

    const out = await capture();

    expect(sha256(await readFile(out))).toBe(sha256(bytes));
    const decoded = PNG.sync.read(await readFile(out));
    expect([decoded.width, decoded.height]).toEqual([8, 12]);
  });

  it("re-encodes a downscaled capture and keeps no raw intermediate", async () => {
    deviceServes(devicePng());

    const out = await captureHarmonyScreenshotPng({ connectKey: "dev", scale: 0.5 });
    outPaths.push(out);

    const decoded = PNG.sync.read(await readFile(out));
    expect([decoded.width, decoded.height]).toEqual([4, 6]);
    // hdcFileRecv's localPath IS the raw intermediate — the resample writes a
    // second file, so this one has to be cleaned up behind it.
    await expect(access(hdcFileRecv.mock.calls[0]![2])).rejects.toThrow();
  });

  it("names the device and the size when the capture will not decode", async () => {
    // The fetch "succeeds" but delivers garbage — the one failure `uitest`'s own
    // exit status cannot show, since the capture it reports on happened before
    // the transfer. The raw file must not be left behind in the host tmpdir on
    // the error path either.
    hdcFileRecv.mockImplementation(async (_key, _remote, localPath) => {
      await writeFile(localPath, Buffer.from("this is not a png"));
    });

    // `dumpLayout`'s parse failure names both, and for the same reason: pngjs'
    // own "Invalid file signature" says nothing about which device answered or
    // how much of an image arrived.
    await expect(captureHarmonyScreenshotPng({ connectKey: "dev", scale: 1 })).rejects.toThrow(
      /device 'dev' returned a screenshot that is not a readable PNG \(17 bytes\)/
    );

    // hdcFileRecv's localPath IS the raw intermediate; it must be gone.
    const rawPath = hdcFileRecv.mock.calls[0]![2];
    expect(rawPath).toContain("argent-harmony-raw-");
    await expect(access(rawPath)).rejects.toThrow();
  });
});
