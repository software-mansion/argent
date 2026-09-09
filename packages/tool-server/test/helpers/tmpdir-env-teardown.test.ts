import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * A suite that hoists its `redirectTmpdir` restorer into a `let` assigned by
 * `beforeEach` calls that restorer from `afterEach` unconditionally. Vitest
 * still runs `afterEach` when `beforeEach` throws, so an unassigned hoisted
 * variable turns the teardown into `undefined()` — a `TypeError` reported
 * beside the genuine failure, which is the one a reader then chases.
 *
 * Both the restorer and the directory it was given have to survive that,
 * because the same teardown deletes the directory.
 */

const TEST_ROOT = join(__dirname, "..");

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) testFiles(p, out);
    else if (p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/** Declaration statement for `name`, or null when it is not a hoisted `let`/`var`. */
function declarationOf(src: string, name: string): string | null {
  const m = new RegExp(String.raw`^[ \t]*(?:let|var)[ \t]+${name}\b[^;\n]*;`, "m").exec(src);
  return m?.[0] ?? null;
}

/** `=>` is not an assignment: `let f: () => void;` carries no initializer. */
function hasInitializer(declaration: string): boolean {
  return declaration.replace(/=>/g, "").includes("=");
}

const ASSIGNMENT = /(?:(const|let|var)[ \t]+)?(\w+)[ \t]*=[ \t]*redirectTmpdir\((\w+)\)/g;

describe("redirectTmpdir teardown state", () => {
  const offenders: string[] = [];
  let sites = 0;

  for (const file of testFiles(TEST_ROOT)) {
    const src = readFileSync(file, "utf8");
    for (const [, declarator, restorer, dir] of src.matchAll(ASSIGNMENT)) {
      if (declarator) continue; // scoped to the assigning block; never observed unassigned
      sites++;
      for (const name of [restorer, dir]) {
        const declaration = declarationOf(src, name);
        if (declaration && !hasInitializer(declaration))
          offenders.push(`${relative(TEST_ROOT, file)}: ${declaration.trim()}`);
      }
    }
  }

  it("hoisted restorers and their scratch directories carry an initializer", () => {
    expect(sites).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
