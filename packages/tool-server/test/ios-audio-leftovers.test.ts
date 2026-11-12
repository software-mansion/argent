import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearAudioLeftovers } from "../src/utils/ios-audio-leftovers";

// A pid that existed and is gone: a tool-server that was killed.
const DEAD = spawnSync("true").pid!;
const LIVE = process.pid;

let dir: string;
const file = (name: string) => path.join(dir, name);
const exists = (name: string) => fs.existsSync(file(name));
const write = (name: string, text = "") => fs.writeFileSync(file(name), text);

/** An in ring header: the host's write cursor at 16, the app's read cursor at 64. */
function inRing(name: string, write: number, read: number): string {
  const b = Buffer.alloc(128 + 64);
  b.writeUInt32LE(0x49475241, 0);
  b.writeUInt32LE(write, 16);
  b.writeUInt32LE(read, 64);
  fs.writeFileSync(file(name), b);
  return file(name);
}

const input = (ring: string, owner?: number) =>
  `source=stream\nring=${ring}\n${owner ? `host=${owner}\n` : ""}`;
const rec = (ring: string, owner?: number) =>
  `id=abc\nring=${ring}\nmute=1\n${owner ? `host=${owner}\n` : ""}`;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-audio-leftovers-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("clearAudioLeftovers", () => {
  it("does nothing when the control directory does not exist", async () => {
    const missing = path.join(dir, "missing");
    await expect(clearAudioLeftovers(missing)).resolves.toBeUndefined();
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("removes the input, rings and clips of a tool-server that is gone", async () => {
    write("input", input(inRing(`in-${DEAD}-aaaa.ring`, 0, 0), DEAD));
    write(`clip-${DEAD}-1.wav`);
    write("st.com.example.app", "pid=1\n");
    await clearAudioLeftovers(dir);
    expect(fs.readdirSync(dir)).toEqual(["st.com.example.app"]);
  });

  it("removes the recording request of a tool-server that is gone, and its ring", async () => {
    write("out-com.example.app-abc.ring");
    write("rec.com.example.app", rec(file("out-com.example.app-abc.ring"), DEAD));
    await clearAudioLeftovers(dir);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("keeps everything a live tool-server owns", async () => {
    write("input", input(inRing(`in-${LIVE}-aaaa.ring`, 0, 0), LIVE));
    write(`clip-${LIVE}-1.wav`);
    write("out-com.example.app-abc.ring");
    write("rec.com.example.app", rec(file("out-com.example.app-abc.ring"), LIVE));
    const before = fs.readdirSync(dir).sort();
    await clearAudioLeftovers(dir);
    expect(fs.readdirSync(dir).sort()).toEqual(before);
  });

  it("clears a dead tool-server's files next to a live one's", async () => {
    write("input", input(inRing(`in-${LIVE}-aaaa.ring`, 0, 0), LIVE));
    inRing(`in-${DEAD}-bbbb.ring`, 0, 0);
    write(`clip-${DEAD}-1.wav`);
    write("out-com.other-abc.ring");
    write("rec.com.other", rec(file("out-com.other-abc.ring"), DEAD));
    await clearAudioLeftovers(dir);
    expect(fs.readdirSync(dir).sort()).toEqual(["in-" + LIVE + "-aaaa.ring", "input"].sort());
  });

  it("never removes a ring outside the control directory", async () => {
    const outside = path.join(os.tmpdir(), `argent-leftovers-${LIVE}.ring`);
    fs.writeFileSync(outside, "");
    try {
      write("input", input(outside, DEAD));
      await clearAudioLeftovers(dir);
      expect(exists("input")).toBe(false);
      expect(fs.existsSync(outside)).toBe(true);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  describe("files without an owner (written before the marker)", () => {
    it("removes a request whose ring is gone", async () => {
      write("input", input(file("in-aaaa.ring")));
      write("rec.com.example.app", rec(file("out-com.example.app-abc.ring")));
      await clearAudioLeftovers(dir);
      expect(fs.readdirSync(dir)).toEqual([]);
    });

    it("keeps a recording request whose ring is in place", async () => {
      write("out-com.example.app-abc.ring");
      write("rec.com.example.app", rec(file("out-com.example.app-abc.ring")));
      await clearAudioLeftovers(dir);
      expect(exists("rec.com.example.app")).toBe(true);
    });

    it("keeps an input whose ring is still ahead of the app, with its ring and clip", async () => {
      write("input", input(inRing("in-aaaa.ring", 14_400, 0)));
      write("clip-1.wav");
      await clearAudioLeftovers(dir);
      expect(fs.readdirSync(dir).sort()).toEqual(["clip-1.wav", "in-aaaa.ring", "input"]);
    });

    it("removes an input whose ring an app drained and nobody refilled", async () => {
      write("input", input(inRing("in-aaaa.ring", 4_800, 4_800)));
      write("clip-1.wav");
      await clearAudioLeftovers(dir);
      expect(fs.readdirSync(dir)).toEqual([]);
    });

    it("keeps a drained input whose feeder refills it", async () => {
      const ring = inRing("in-aaaa.ring", 4_800, 4_800);
      write("input", input(ring));
      const feeder = setInterval(() => inRing("in-aaaa.ring", 4_800 + 14_400, 4_800), 10);
      try {
        await clearAudioLeftovers(dir);
      } finally {
        clearInterval(feeder);
      }
      expect(exists("input")).toBe(true);
      expect(exists("in-aaaa.ring")).toBe(true);
    });
  });
});
