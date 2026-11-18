import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removePath } from "../src/utils.js";

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
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function isGone(target: string): boolean {
  return fs.lstatSync(target, { throwIfNoEntry: false }) === undefined;
}

// On a Node whose fs.rmSync removes a link, the link tests pass whichever call
// removePath makes. The check in setup.ts is what fails them there if it hands
// the link to fs.rmSync.
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
