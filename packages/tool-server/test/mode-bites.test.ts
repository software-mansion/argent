import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { modeBites } from "./helpers/mode-bites";

// The cases this helper gates skip when it answers false, and a suite full of
// skips is still green - so a wrong answer would take the unwritable-directory
// cases out of the run with no signal at all.
describe("modeBites", () => {
  // Root and Windows both write into a 0o555 directory, and there the gated
  // cases are meant to skip.
  const ignoresMode = process.platform === "win32" || process.getuid?.() === 0;

  it("says a writable directory does not bite, and leaves nothing behind", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mode-bites-"));
    try {
      expect(modeBites(dir)).toBe(false);
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says a read-only directory bites, which is what runs the EACCES cases", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mode-bites-"));
    fs.chmodSync(dir, 0o555);
    try {
      expect(modeBites(dir)).toBe(!ignoresMode);
    } finally {
      fs.chmodSync(dir, 0o755);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
