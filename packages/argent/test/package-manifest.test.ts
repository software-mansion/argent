import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

describe("package manifest", () => {
  it("publishes the bundled native dylibs and runtime artifacts", () => {
    const pkgPath = path.resolve(import.meta.dirname, "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { files?: string[] };

    expect(pkg.files).toContain("dist/");
    expect(pkg.files).toContain("dylibs/");
    expect(pkg.files).toContain("bin/");
    expect(pkg.files).toContain("skills/");
  });
});
