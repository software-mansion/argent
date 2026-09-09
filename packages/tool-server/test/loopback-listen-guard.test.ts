import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// `listen(0)` with no host binds every interface, so an ephemeral-port server
// meant for one process is reachable from the LAN for as long as it is up.
const packageRoot = path.resolve(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.[cm]?tsx?$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

describe("ephemeral-port listeners", () => {
  it("bind loopback explicitly rather than every interface", () => {
    const offenders: string[] = [];

    for (const file of [
      ...sourceFiles(path.join(packageRoot, "src")),
      ...sourceFiles(path.join(packageRoot, "test")),
    ]) {
      fs.readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (/\.listen\(0\b/.test(line) && !/\.listen\(0,\s*"127\.0\.0\.1"/.test(line)) {
            offenders.push(`${path.relative(packageRoot, file)}:${index + 1}`);
          }
        });
    }

    expect(offenders).toEqual([]);
  });
});
