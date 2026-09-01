import fs from "fs/promises";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tvScreenshot } from "../src/tools/screenshot";

const state = vi.hoisted(() => ({ runs: [] as string[][], sipsResizeFails: false }));

// `tvScreenshot` shells out through `promisify(execFile)`, so the mock carries
// the promisify hook — a bare `vi.fn()` is wrapped as a callback function and
// resolves to a stdout string instead of the `{ stdout }` the probe reads.
vi.mock("node:child_process", () => {
  const execFile = (): never => {
    throw new Error("execFile called directly");
  };
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), {
    value: async (command: string, args: string[]) => {
      state.runs.push([command, ...args]);
      if (command === "sips" && args[0] === "-Z") {
        if (state.sipsResizeFails) throw new Error("sips: cannot process the file");
        return { stdout: "", stderr: "" };
      }
      if (command === "sips" && args[0] === "-g") {
        return { stdout: "pixelWidth: 3840\npixelHeight: 2160\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
  });
  return { execFile };
});

describe("tvScreenshot's downscale", () => {
  beforeEach(() => {
    state.runs.length = 0;
    state.sipsResizeFails = false;
  });

  it("asks sips for the requested scale", async () => {
    await tvScreenshot("TV-UDID", 0.25, undefined);
    expect(state.runs.map(([command]) => command)).toEqual(["xcrun", "sips", "sips"]);
    // 3840 long side x 0.25, taken from the probe rather than a hardcoded 4K.
    expect(state.runs.at(-1)).toEqual(["sips", "-Z", "960", expect.any(String)]);
  });

  it("returns the capture anyway when sips fails, with nothing recording the drop", async () => {
    state.sipsResizeFails = true;
    // Resolves rather than rejects: the `.catch(() => {})` in `tvScreenshot` is
    // what makes the Apple TV downscale best-effort, and the path it returns is
    // the untouched `xcrun simctl io` capture. Nothing in the result says which
    // of the two the caller got, which is why the skill has to.
    await expect(tvScreenshot("TV-UDID", 0.25, undefined)).resolves.toMatch(
      /argent-tv-screenshot-/
    );
  });

  it("is the condition argent-tv-interact puts in front of an agent", async () => {
    const skill = await fs.readFile(
      path.join(__dirname, "../../skills/skills/argent-tv-interact/SKILL.md"),
      "utf8"
    );
    // Its `screenshot` line covers three platforms, and Apple TV is the one
    // whose downscale can silently not happen. An unconditional "all three
    // downscale" is the sentence this replaced.
    expect(skill).toContain(
      "Apple TV downscales with `sips`, and when `sips` fails it returns the capture `xcrun simctl io` took, with nothing in the result saying the scale was dropped"
    );
  });
});
