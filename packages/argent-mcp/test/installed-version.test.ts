import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { getInstalledVersion } from "../src/installed-version.js";

describe("getInstalledVersion", () => {
  it("matches the workspace package.json version (no more hardcoded drift)", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8")
    ) as { version: string };
    expect(getInstalledVersion()).toBe(pkg.version);
  });

  it("never returns the stale literal this replaced", () => {
    expect(getInstalledVersion()).not.toBe("0.5.3");
  });
});
