import { describe, it, expect, afterEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { redirectTmpdir } from "./helpers/tmpdir-env";

// The variable os.tmpdir() consults is platform-dependent — POSIX reads TMPDIR,
// TMP, TEMP in that order and Windows reads TEMP then TMP — so a redirect that
// covers only the local platform's name leaves the other one resolving into the
// machine-wide temp directory. The files that scope the tmpdir to catch a leak
// then scan a directory nothing writes to and pass whatever the code does.
const LOOKUPS = {
  posix: ["TMPDIR", "TMP", "TEMP"],
  win32: ["TEMP", "TMP"],
};

describe("redirectTmpdir", () => {
  const saved = new Map<string, string | undefined>();
  for (const k of ["TMPDIR", "TEMP", "TMP"]) saved.set(k, process.env[k]);

  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it.each(Object.entries(LOOKUPS))(
    "redirects the whole %s lookup chain, not just its first entry",
    (_platform, chain) => {
      const restore = redirectTmpdir("/scratch/owned-by-this-run");
      try {
        for (const key of chain) {
          expect(process.env[key]).toBe("/scratch/owned-by-this-run");
        }
      } finally {
        restore();
      }
    }
  );

  it("restores an absent variable by deleting it rather than setting undefined", () => {
    delete process.env.TEMP;
    process.env.TMPDIR = "/before";

    redirectTmpdir("/scratch")();

    expect("TEMP" in process.env).toBe(false);
    expect(process.env.TMPDIR).toBe("/before");
  });
});

/**
 * These suites call the restorer from `afterEach` unconditionally, and Vitest
 * runs `afterEach` even when `beforeEach` threw. Whatever the teardown reads
 * that the assigning hook never got to is then `undefined`, so the teardown
 * throws a second TypeError beside the genuine failure - the one a reader
 * chases first.
 */

const TEST_ROOT = __dirname;

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) testFiles(p, out);
    else if (p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/** Body of every `name(...)` call in `src`, matched by balancing parentheses. */
function callBodies(src: string, name: string): string {
  const bodies: string[] = [];
  const calls = new RegExp(String.raw`\b${name}\s*\(`, "g");
  for (let call = calls.exec(src); call; call = calls.exec(src)) {
    const start = call.index + call[0].length;
    let depth = 1;
    let i = start;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
    }
    bodies.push(src.slice(start, i - 1));
  }
  return bodies.join("\n");
}

/** Hoisted `let`/`var` declarations carrying no initializer - `=>` is not one. */
function uninitialized(src: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const [decl, name] of src.matchAll(/^[ \t]*(?:let|var)[ \t]+(\w+)[^;\n]*;$/gm)) {
    if (!decl.replace(/=>/g, "").includes("=")) found.set(name, decl.trim());
  }
  return found;
}

const RESTORER = /(?:(const|let|var)[ \t]+)?\w+[ \t]*=[ \t]*redirectTmpdir\(/g;

describe("suites that redirect the tmpdir for a whole file", () => {
  it("initialize every hoisted variable their teardown reads", () => {
    const offenders: string[] = [];
    let scanned = 0;

    for (const file of testFiles(TEST_ROOT)) {
      const src = readFileSync(file, "utf8");
      // A block-scoped restorer cannot outlive the block that assigned it.
      if (![...src.matchAll(RESTORER)].some((m) => !m[1])) continue;
      scanned++;
      const teardown = callBodies(src, "afterEach");
      for (const [name, decl] of uninitialized(src))
        if (new RegExp(String.raw`\b${name}\b`).test(teardown))
          offenders.push(`${relative(TEST_ROOT, file)}: ${decl}`);
    }

    expect(scanned).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
