import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDyldInsertLibraries } from "../src/blueprints/native-devtools";

describe("buildDyldInsertLibraries", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempFile(name: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-devtools-env-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, "");
    return filePath;
  }

  it("replaces stale bootstrap entries and missing paths with the current bootstrap dylib", () => {
    const currentBootstrap = makeTempFile("libInjectionBootstrap.dylib");
    const unrelated = makeTempFile("libOtherInspector.dylib");
    const staleBootstrap = "/tmp/old/location/libInjectionBootstrap.dylib";
    const truncatedEntry = "/Users/filip/.nvm/versi";

    const result = buildDyldInsertLibraries(
      [staleBootstrap, truncatedEntry, unrelated].join(":"),
      currentBootstrap
    );

    expect(result).toBe([unrelated, currentBootstrap].join(":"));
  });

  it("preserves valid non-bootstrap loader entries while deduplicating the active bootstrap", () => {
    const currentBootstrap = makeTempFile("libInjectionBootstrap.dylib");
    const unrelated = makeTempFile("libCustomTracing.dylib");

    const result = buildDyldInsertLibraries(
      [currentBootstrap, "@loader_path/Other.dylib", unrelated].join(":"),
      currentBootstrap
    );

    expect(result).toBe(["@loader_path/Other.dylib", unrelated, currentBootstrap].join(":"));
  });
});
