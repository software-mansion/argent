import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import {
  hdcFileRecv as realHdcFileRecv,
  runHdcShell as realRunHdcShell,
} from "../src/utils/harmony-hdc";
import { captureHarmonyScreenshotPng } from "../src/utils/harmony-screen";

// Only the transport is faked; the decode/scale path runs on real PNGs.
vi.mock("../src/utils/harmony-hdc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/harmony-hdc")>();
  return { ...actual, runHdcShell: vi.fn(), hdcFileRecv: vi.fn() };
});

const runHdcShell = vi.mocked(realRunHdcShell);
const hdcFileRecv = vi.mocked(realHdcFileRecv);

function tinyPng(): Buffer {
  return PNG.sync.write(new PNG({ width: 4, height: 4 }));
}

/** A valid PNG pngjs would not reproduce byte-for-byte, so a re-encode is detectable. */
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

function deviceServes(bytes: Buffer): void {
  hdcFileRecv.mockImplementation(async (_key, _remote, localPath) => {
    await writeFile(localPath, bytes);
  });
}

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
    // /data/local/tmp is never pruned.
    hdcFileRecv.mockRejectedValue(new Error("[Fail]Error opening file: no such file"));

    await expect(captureHarmonyScreenshotPng({ connectKey: "dev", scale: 1 })).rejects.toThrow(
      /Error opening file/
    );

    const [remotePath] = capturedRemotePaths();
    expect(remotePath).toMatch(/^\/data\/local\/tmp\/argent-\d+-\d+\.png$/);
    const commands = runHdcShell.mock.calls.map((c) => c[1]);
    expect(commands).toContain(`rm -f '${remotePath}'`);
    expect(commands.indexOf(`rm -f '${remotePath}'`)).toBeGreaterThan(
      commands.findIndex((c) => c.includes("screenCap"))
    );
  });

  it("uses a distinct remote path for two concurrent captures", async () => {
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
    for (const out of [a, b]) {
      const decoded = PNG.sync.read(await readFile(out));
      expect([decoded.width, decoded.height]).toEqual([4, 4]);
    }
  });
});

describe("captureHarmonyScreenshotPng", () => {
  it("hands back the device's own bytes at full resolution", async () => {
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
    await expect(access(hdcFileRecv.mock.calls[0]![2])).rejects.toThrow();
  });

  it("names the device and the size when the capture will not decode", async () => {
    hdcFileRecv.mockImplementation(async (_key, _remote, localPath) => {
      await writeFile(localPath, Buffer.from("this is not a png"));
    });

    await expect(captureHarmonyScreenshotPng({ connectKey: "dev", scale: 1 })).rejects.toThrow(
      /device 'dev' returned a screenshot that is not a readable PNG \(17 bytes\)/
    );

    const rawPath = hdcFileRecv.mock.calls[0]![2];
    expect(rawPath).toContain("argent-harmony-raw-");
    await expect(access(rawPath)).rejects.toThrow();
  });
});
