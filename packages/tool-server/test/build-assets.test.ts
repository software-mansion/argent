import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const WORKSPACE_ROOT = path.resolve(__dirname, "../../..");
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const COPY_SCRIPT = path.join(PACKAGE_ROOT, "scripts", "copy-build-assets.mjs");

/**
 * The files `tsc` leaves behind, and the one build step that puts them in
 * `dist/`.
 *
 * Nothing asserted this. `flow-script-protocol.test.ts` hand-copies the three
 * `.mjs` files into a temporary directory, so it stays green with the copy
 * script deleted, and the CI `test -f` guards only the published bundle, which
 * copies from `src`. `windows-e2e.yml` and the Vega E2E script both boot
 * `packages/tool-server/dist` as a real tool server: no flow `script` step
 * exists yet, so a short `dist/` boots today, and from the PR that wires the
 * step up it fails every one of them at flow-execute time.
 */
const ASSETS = [
  "utils/ios-profiler/Argent.tracetemplate",
  "tools/flows/script/flow-script-runner.mjs",
  "tools/flows/script/flow-script-watchdog-lifeline.mjs",
  "tools/flows/script/flow-script-watchdog-deadline.mjs",
];

const temporary: string[] = [];

afterEach(() => {
  while (temporary.length) fs.rmSync(temporary.pop()!, { recursive: true, force: true });
});

/**
 * A package root holding only the copy script and the assets named in `include`.
 *
 * The script resolves its own package root from its own location, so running a
 * copy of it out of a temporary tree is what lets a case leave an asset out —
 * and what keeps every case off the real `dist/`, which is the one directory a
 * unit test must not materialise on a tree that has never been built.
 */
function fixtureRoot(include: readonly string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "argent-build-assets-"));
  temporary.push(root);
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.copyFileSync(COPY_SCRIPT, path.join(root, "scripts", path.basename(COPY_SCRIPT)));
  for (const asset of include) {
    const to = path.join(root, "src", asset);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(PACKAGE_ROOT, "src", asset), to);
  }
  return root;
}

function runCopy(root: string): void {
  execFileSync(process.execPath, [path.join(root, "scripts", path.basename(COPY_SCRIPT))], {
    stdio: "pipe",
  });
}

describe("tool-server build assets", () => {
  it("copies every listed asset into dist, byte for byte", () => {
    // Run rather than assume: a suite that only checked an existing `dist/`
    // would pass on whatever the last build left there, including a build that
    // predates a file being added to the list. `cpSync` creates parents, so
    // this works on a tree that has never been built.
    const root = fixtureRoot(ASSETS);
    runCopy(root);

    for (const asset of ASSETS) {
      const source = path.join(PACKAGE_ROOT, "src", asset);
      const copied = path.join(root, "dist", asset);
      expect(fs.existsSync(copied), `${asset} is missing from dist/`).toBe(true);
      expect(fs.readFileSync(copied)).toEqual(fs.readFileSync(source));
    }
  });

  it("refuses to finish when a listed asset is not there", () => {
    // The list is hand-maintained against four other places, so the failure
    // mode that matters is a rename. It has to stop the build rather than
    // produce a dist that is quietly short a file — and the only proof of that
    // is running it against a tree with one asset missing.
    const dropped = ASSETS[1]!;
    const root = fixtureRoot(ASSETS.filter((asset) => asset !== dropped));

    expect(() => runCopy(root)).toThrow();
    try {
      runCopy(root);
    } catch (err) {
      expect(String((err as { stderr?: Buffer }).stderr)).toContain("Build asset missing");
    }
    expect(fs.existsSync(path.join(root, "dist", ASSETS[0]!))).toBe(true);
    expect(fs.existsSync(path.join(root, "dist", dropped))).toBe(false);
  });

  it("lists exactly the files that are in src", () => {
    const listed = fs
      .readFileSync(COPY_SCRIPT, "utf8")
      .match(/"src\/[^"]+"/g)
      ?.map((quoted) => quoted.slice(1, -1));

    expect(listed).toBeDefined();
    for (const asset of listed ?? []) {
      expect(fs.existsSync(path.join(PACKAGE_ROOT, asset)), `${asset} is listed but absent`).toBe(
        true
      );
    }
    expect(listed?.map((asset) => path.relative("src", asset)).sort()).toEqual([...ASSETS].sort());
  });

  it("is run by every build that produces this package's dist", () => {
    // The step above proves the script works; this proves a build runs it.
    // Without it, deleting `&& node scripts/copy-build-assets.mjs` from either
    // `package.json` leaves the whole file green while `dist` ships short.
    const buildScript = (file: string): string =>
      (JSON.parse(fs.readFileSync(file, "utf8")) as { scripts: Record<string, string> }).scripts
        .build ?? "";

    expect(buildScript(path.join(WORKSPACE_ROOT, "package.json"))).toContain(
      "copy-build-assets.mjs"
    );
    expect(buildScript(path.join(PACKAGE_ROOT, "package.json"))).toContain("copy-build-assets.mjs");
  });
});
