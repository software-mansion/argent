import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removePath } from "../src/utils.js";

// Every link handed to fs.rmSync, which then runs as it always does.
const linksGivenToRmSync = vi.hoisted(() => [] as string[]);

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const rmSync: typeof actual.rmSync = (target, options) => {
    if (actual.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
      linksGivenToRmSync.push(String(target));
    }
    actual.rmSync(target, options);
  };
  return { ...actual, rmSync };
});

let tmpDir: string;
let dir: string;
let file: string;
let link: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-remove-path-"));
  dir = path.join(tmpDir, "dir");
  file = path.join(dir, "file.md");
  link = path.join(tmpDir, "link");
  fs.mkdirSync(dir);
  fs.writeFileSync(file, "kept");
  linksGivenToRmSync.length = 0;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function isGone(target: string): boolean {
  return fs.lstatSync(target, { throwIfNoEntry: false }) === undefined;
}

describe("removePath", () => {
  it("removes a link to a directory and keeps the directory", () => {
    fs.symlinkSync(dir, link);

    expect(removePath(link)).toBe(true);
    expect(isGone(link)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("kept");
  });

  it("removes a relative link to a directory", () => {
    fs.symlinkSync("dir", link);

    expect(removePath(link)).toBe(true);
    expect(isGone(link)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("kept");
  });

  it("removes a link to a file and keeps the file", () => {
    fs.symlinkSync(file, link);

    expect(removePath(link)).toBe(true);
    expect(isGone(link)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("kept");
  });

  it("removes a dangling link", () => {
    fs.symlinkSync(path.join(tmpDir, "missing"), link);

    expect(removePath(link)).toBe(true);
    expect(isGone(link)).toBe(true);
  });

  // The tests above pass on Node 22, and on 24.13.1 and later, whichever call
  // removes the link. Node 23.0 to 24.13.0 and 25.0 to 25.3 are where
  // fs.rmSync keeps one, so this is the check that holds on every Node.
  it("never hands a link to fs.rmSync", () => {
    for (const target of [dir, file, path.join(tmpDir, "missing")]) {
      fs.symlinkSync(target, link);
      removePath(link);
    }

    expect(linksGivenToRmSync).toEqual([]);
  });

  it("removes a directory with its contents", () => {
    expect(removePath(dir)).toBe(true);
    expect(isGone(dir)).toBe(true);
  });

  it("removes a file", () => {
    expect(removePath(file)).toBe(true);
    expect(isGone(file)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("reports a missing path as not removed", () => {
    expect(removePath(path.join(tmpDir, "missing"))).toBe(false);
  });
});
