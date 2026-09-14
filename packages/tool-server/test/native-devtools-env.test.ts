import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDyldInsertLibraries,
  withdrawDyldInsertLibraries,
} from "../src/blueprints/native-devtools";

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

  it("strips stale bootstrap entries and non-existent paths, keeps files present on disk", () => {
    const currentBootstrap = makeTempFile("libArgentInjectionBootstrap.dylib");
    const unrelated = makeTempFile("libOtherInspector.dylib");
    const staleBootstrap = "/tmp/old/location/libArgentInjectionBootstrap.dylib";
    const truncatedEntry = "/Users/filip/.nvm/versi";

    const result = buildDyldInsertLibraries(
      [staleBootstrap, truncatedEntry, unrelated].join(":"),
      currentBootstrap
    );

    // staleBootstrap stripped (argent basename); truncatedEntry stripped (not on disk)
    expect(result).toBe([unrelated, currentBootstrap].join(":"));
  });

  it("preserves valid non-bootstrap loader entries while deduplicating the active bootstrap", () => {
    const currentBootstrap = makeTempFile("libArgentInjectionBootstrap.dylib");
    const unrelated = makeTempFile("libCustomTracing.dylib");

    const result = buildDyldInsertLibraries(
      [currentBootstrap, "@loader_path/Other.dylib", unrelated].join(":"),
      currentBootstrap
    );

    expect(result).toBe(["@loader_path/Other.dylib", unrelated, currentBootstrap].join(":"));
  });

  it("strips stale legacy libInjectionBootstrap.dylib paths when merging with the renamed bootstrap", () => {
    const currentBootstrap = makeTempFile("libArgentInjectionBootstrap.dylib");
    const legacyBootstrap = "/tmp/old/libInjectionBootstrap.dylib";
    const thirdParty = makeTempFile("libSimCamLoader.dylib");

    const result = buildDyldInsertLibraries(
      [legacyBootstrap, thirdParty].join(":"),
      currentBootstrap
    );

    expect(result).toBe([thirdParty, currentBootstrap].join(":"));
  });

  it("is idempotent when called with its own output", () => {
    const currentBootstrap = makeTempFile("libArgentInjectionBootstrap.dylib");
    const thirdParty = makeTempFile("libSimCamLoader.dylib");

    const first = buildDyldInsertLibraries(thirdParty, currentBootstrap);
    const second = buildDyldInsertLibraries(first, currentBootstrap);

    expect(second).toBe(first);
  });

  it("cleans up truncated entries from simctl getenv 127-byte corruption", () => {
    const currentBootstrap = makeTempFile("libArgentInjectionBootstrap.dylib");
    const thirdParty = makeTempFile("libSimCamLoader.dylib");
    // Simulate the truncated entries that accumulate from the simctl getenv bug
    const truncated1 = "/Users/mdk/.nvm/versions/node/v24.5.0/lib/nod";
    const truncated2 =
      "/Users/mdk/.nvm/versions/node/v24.5.0/lib/node_modules/@swmansion/argent/dylibs/l";

    const result = buildDyldInsertLibraries(
      [truncated1, truncated2, currentBootstrap, thirdParty].join(":"),
      currentBootstrap
    );

    // Both truncated entries stripped (not on disk), bootstrap deduped, thirdParty preserved
    expect(result).toBe([thirdParty, currentBootstrap].join(":"));
  });
});

describe("withdrawDyldInsertLibraries", () => {
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

  /**
   * The case this exists for; we armed a simulator a device provider went on to
   * claim. Its bootstrap has to survive, because it is the injection the
   * provider's app is about to load.
   */
  it("removes our bootstrap and leaves a provider's in place", () => {
    const ourBootstrap = makeTempFile("libArgentInjectionBootstrap.dylib");
    const providerBootstrap = makeTempFile("libInjectionBootstrap.dylib");

    expect(
      withdrawDyldInsertLibraries([providerBootstrap, ourBootstrap].join(":"), ourBootstrap)
    ).toBe(providerBootstrap);
  });

  /**
   * `null`, not `""`; dyld reads an empty entry as a malformed list, so the
   * variable has to be unset rather than blanked.
   */
  it("asks for the variable to be unset when only our entries were in it", () => {
    const ourBootstrap = makeTempFile("libArgentInjectionBootstrap.dylib");
    const staleBootstrap = "/tmp/old/location/libArgentInjectionBootstrap.dylib";

    expect(
      withdrawDyldInsertLibraries([staleBootstrap, ourBootstrap].join(":"), ourBootstrap)
    ).toBe(null);
    expect(withdrawDyldInsertLibraries("", ourBootstrap)).toBe(null);
  });

  it("keeps third-party and loader-path entries we never owned", () => {
    const ourBootstrap = makeTempFile("libArgentInjectionBootstrap.dylib");
    const thirdParty = makeTempFile("libSimCamLoader.dylib");

    expect(
      withdrawDyldInsertLibraries(
        [thirdParty, "@loader_path/Other.dylib", ourBootstrap].join(":"),
        ourBootstrap
      )
    ).toBe([thirdParty, "@loader_path/Other.dylib"].join(":"));
  });

  it("is a no-op on an environment that never carried us", () => {
    const ourBootstrap = makeTempFile("libArgentInjectionBootstrap.dylib");
    const thirdParty = makeTempFile("libSimCamLoader.dylib");

    expect(withdrawDyldInsertLibraries(thirdParty, ourBootstrap)).toBe(thirdParty);
  });

  it("undoes exactly what arming did", () => {
    const ourBootstrap = makeTempFile("libArgentInjectionBootstrap.dylib");
    const thirdParty = makeTempFile("libSimCamLoader.dylib");

    const armed = buildDyldInsertLibraries(thirdParty, ourBootstrap);
    expect(withdrawDyldInsertLibraries(armed, ourBootstrap)).toBe(thirdParty);
  });
});
