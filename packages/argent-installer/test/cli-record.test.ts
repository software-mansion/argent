import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  cliRecordPath,
  readCliRecord,
  removeCliRecordFor,
  writeCliRecord,
} from "../src/cli-record.js";

/**
 * `~/.argent/cli.json` is how a device provider finds argent's CLI without
 * `PATH`. Two properties worth pinning: it names paths that actually exist and
 * uninstalling one of two coexisting installs leaves the other's record alone.
 */

/**
 * Only the global-install probe is stubbed, because it shells out to `which
 * argent`; everything else runs against real files in a temp home. Read at
 * call time so each test can point it elsewhere. (`import * as topology` +
 * `spyOn` would work too, but makes `topology.ts`'s other exports read as dead
 * to knip.)
 */
const installed = vi.hoisted(() => ({ globalPackageRoot: null as string | null }));

vi.mock("../src/topology.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  getGloballyInstalledPackageRoot: () => installed.globalPackageRoot,
}));

let home: string;
let globalRoot: string;
let projectRoot: string;

/** A package directory shaped like an installed @swmansion/argent. */
function fakeInstall(root: string, version: string): string {
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ bin: { argent: "dist/cli.js" }, name: "@swmansion/argent", version })
  );
  fs.writeFileSync(path.join(root, "dist", "cli.js"), "// entrypoint\n");
  return path.join(root, "dist", "cli.js");
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "argent-cli-record-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);

  installed.globalPackageRoot = null;
  globalRoot = path.join(home, "global-install");
  projectRoot = path.join(home, "project");
  fs.mkdirSync(projectRoot, { recursive: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("writeCliRecord", () => {
  it("records the node binary and the global install's entrypoint", () => {
    const cli = fakeInstall(globalRoot, "1.2.3");
    installed.globalPackageRoot = globalRoot;

    expect(writeCliRecord({ mode: "global", projectRoot, version: "1.2.3" })).toBe(cliRecordPath());

    const record = readCliRecord()!;
    expect(record).toMatchObject({ cli, mode: "global", node: process.execPath, version: "1.2.3" });
    expect(fs.existsSync(record.cli)).toBe(true);
    expect(Date.parse(record.updatedAt)).not.toBeNaN();
  });

  it("records the project-local install's entrypoint in local mode", () => {
    const localRoot = path.join(projectRoot, "node_modules", "@swmansion", "argent");
    const cli = fakeInstall(localRoot, "1.2.3");

    expect(writeCliRecord({ mode: "local", projectRoot, version: "1.2.3" })).toBe(cliRecordPath());
    expect(fs.realpathSync(readCliRecord()!.cli)).toBe(fs.realpathSync(cli));
  });

  /** No record beats one pointing at nothing and init still passes. */
  it("writes nothing when the install cannot be located", () => {
    installed.globalPackageRoot = null;

    expect(writeCliRecord({ mode: "global", projectRoot, version: "1.2.3" })).toBeNull();
    expect(fs.existsSync(cliRecordPath())).toBe(false);
  });

  it("leaves no temporary file behind", () => {
    fakeInstall(globalRoot, "1.2.3");
    installed.globalPackageRoot = globalRoot;

    writeCliRecord({ mode: "global", projectRoot, version: "1.2.3" });

    expect(
      fs.readdirSync(path.dirname(cliRecordPath())).filter((name) => name.includes(".tmp"))
    ).toEqual([]);
  });

  it("overwrites an existing record — last writer wins", () => {
    fakeInstall(globalRoot, "1.2.3");
    installed.globalPackageRoot = globalRoot;
    writeCliRecord({ mode: "global", projectRoot, version: "1.2.3" });

    const localRoot = path.join(projectRoot, "node_modules", "@swmansion", "argent");
    fakeInstall(localRoot, "1.3.0");
    writeCliRecord({ mode: "local", projectRoot, version: "1.3.0" });

    expect(readCliRecord()).toMatchObject({ mode: "local", version: "1.3.0" });
  });
});

describe("removeCliRecordFor", () => {
  it("removes the record when it names the install being removed", () => {
    fakeInstall(globalRoot, "1.2.3");
    installed.globalPackageRoot = globalRoot;
    writeCliRecord({ mode: "global", projectRoot, version: "1.2.3" });

    expect(removeCliRecordFor(globalRoot)).toBe(true);
    expect(fs.existsSync(cliRecordPath())).toBe(false);
  });

  /**
   * Uninstalling the install that did not write the record must leave provider
   * CLI discovery working.
   */
  it("keeps a record that names a different, surviving install", () => {
    const localRoot = path.join(projectRoot, "node_modules", "@swmansion", "argent");
    fakeInstall(localRoot, "1.3.0");
    writeCliRecord({ mode: "local", projectRoot, version: "1.3.0" });

    fakeInstall(globalRoot, "1.2.3");

    expect(removeCliRecordFor(globalRoot)).toBe(false);
    expect(fs.existsSync(cliRecordPath())).toBe(true);
  });

  it("is a no-op when there is no record, or no install directory to compare", () => {
    expect(removeCliRecordFor(globalRoot)).toBe(false);
    expect(removeCliRecordFor(null)).toBe(false);
  });
});

describe("readCliRecord", () => {
  it("returns null rather than throwing on a corrupt record", () => {
    fs.mkdirSync(path.dirname(cliRecordPath()), { recursive: true });
    fs.writeFileSync(cliRecordPath(), "{ not json");
    expect(readCliRecord()).toBeNull();
  });

  it("returns null for a document missing the paths it exists to carry", () => {
    fs.mkdirSync(path.dirname(cliRecordPath()), { recursive: true });
    fs.writeFileSync(cliRecordPath(), JSON.stringify({ mode: "global", version: "1.2.3" }));
    expect(readCliRecord()).toBeNull();
  });
});
