import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two refusals no POSIX filesystem gives on its own: `EBUSY` on the removal
 * (Windows, while a surviving descendant holds a file in the directory) and a
 * write that fails after the directory was made (`ENOSPC`). Only the named call
 * is refused; the removal cases use the real filesystem. Its own file because
 * the mock is module-wide, and not in the Windows job because the refusals
 * come from the mock on every platform.
 */
let refuseRemoval: ((target: string) => boolean) | undefined;
let refuseWrite: ((target: string) => boolean) | undefined;
/** Every path the synchronous remove was called on. */
const removedSync: string[] = [];
/**
 * The asynchronous removes: how many were in flight at most, and each recursive
 * one that found a directory with entries in it - the call that starts one
 * operation per entry at once.
 */
const removesAsync = { inFlight: 0, most: 0, recursiveOnFull: [] as string[] };
/** The path each directory had when the batched remove moved it up. */
const movedUp: string[] = [];

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const rmSync: typeof actual.rmSync = (target, options) => {
    removedSync.push(String(target));
    return actual.rmSync(target, options);
  };
  const rm: typeof actual.promises.rm = async (target, options) => {
    if (refuseRemoval?.(String(target))) {
      throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    }
    if (options?.recursive) {
      try {
        if (actual.readdirSync(target).length > 0) {
          removesAsync.recursiveOnFull.push(String(target));
        }
      } catch {
        // Not a directory, not there, or not readable.
      }
    }
    removesAsync.inFlight++;
    removesAsync.most = Math.max(removesAsync.most, removesAsync.inFlight);
    try {
      return await actual.promises.rm(target, options);
    } finally {
      removesAsync.inFlight--;
    }
  };
  const rename: typeof actual.promises.rename = async (from, to) => {
    movedUp.push(String(from));
    return actual.promises.rename(from, to);
  };
  const promises = { ...actual.promises, rm, rename };
  const writeFileSync: typeof actual.writeFileSync = (target, data, options) => {
    if (refuseWrite?.(String(target))) {
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    }
    return actual.writeFileSync(target, data, options);
  };
  return {
    ...actual,
    rmSync,
    writeFileSync,
    promises,
    default: { ...actual, rmSync, writeFileSync, promises },
  };
});

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  exchangeDirPrefix,
  FlowScriptExecutor,
} from "../../../src/tools/flows/script/flow-script-executor";
import { createScriptWorkspace } from "../../helpers/flow-script-workspace";
import { resolveHostBash } from "../../helpers/host-bash";

/**
 * `rm -rf`, which walks a tree by descriptor. What a regressed remove leaves
 * behind can run past the longest path `fs.rmSync` takes on Node 20, and a
 * throw from a `finally` would hide the failure that left it there.
 */
function removeLeftovers(dir: string): void {
  spawnSync("rm", ["-rf", dir]);
}

let noBash: string | undefined;

beforeAll(async () => {
  const found = await resolveHostBash();
  if (!("path" in found)) noBash = found.problem;
});

beforeEach((ctx) => {
  if (noBash) ctx.skip(`this host has no bash to run a .sh step with: ${noBash}`);
});

afterEach(() => {
  refuseRemoval = undefined;
  refuseWrite = undefined;
});

/**
 * Runs `source` as a bash step against an exchange root of its own, and hands
 * back what the root held afterwards.
 */
async function runInRoot(label: string, source: string) {
  const ws = createScriptWorkspace(label);
  const exchangeRoot = fs.mkdtempSync(path.join(os.tmpdir(), `argent-${label}-root-`));
  try {
    const result = await new FlowScriptExecutor({ concurrency: 2, exchangeRoot }).execute({
      scriptPath: ws.write(`${label}.sh`, source),
      interpreter: "bash",
      projectRoot: ws.dir,
      timeoutMs: 20_000,
    });
    return { result, left: fs.readdirSync(exchangeRoot) };
  } finally {
    removeLeftovers(exchangeRoot);
    ws.cleanup();
  }
}

const ok = `printf '{"ok":true}' > "$ARGENT_OUTPUT"`;

describe("an exchange directory that will not go", () => {
  it("becomes a note on the result, never a throw", async () => {
    refuseRemoval = (target) => target.includes(exchangeDirPrefix());
    const { result } = await runInRoot("bash-busy", ok);

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ ok: true });
    expect(result.notes.join(" ")).toMatch(
      new RegExp(`${exchangeDirPrefix()}\\S+ could not be removed.*EBUSY`)
    );
  }, 30_000);
});

describe("an exchange directory that could not be filled", () => {
  // `mkdtemp` succeeds and the seeded document's write does not, so no
  // `finally` downstream owns the directory: the call that made it removes it.
  it("is removed by the call that made it, not left behind", async () => {
    refuseWrite = (target) =>
      target.includes(exchangeDirPrefix()) && path.basename(target) === "output.json";
    const { result, left } = await runInRoot("bash-nospace", ok);

    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe("spawn");
    expect(result.failure?.message).toContain("ENOSPC");
    expect(left).toEqual([]);
  }, 30_000);
});

describe("removing the exchange directory", () => {
  // A synchronous recursive remove of a large tree, or one awaited
  // `fs.promises.rm` that starts an operation per entry at once, holds the
  // tool server's event loop; the remove goes in bounded batches instead.
  it("removes it in bounded batches, never in one call, before the step returns", async () => {
    removedSync.length = 0;
    removesAsync.most = 0;
    removesAsync.recursiveOnFull.length = 0;
    const { result, left } = await runInRoot(
      "bash-async-rm",
      `work="$(dirname "$ARGENT_OUTPUT")/work"
for d in 1 2 3; do mkdir -p "$work/$d" && (cd "$work/$d" && seq 1 100 | xargs touch); done
${ok}`
    );

    const exchangePaths = (targets: string[]) =>
      targets.filter((target) => target.includes(exchangeDirPrefix()));
    expect(result.ok).toBe(true);
    expect(exchangePaths(removedSync)).toEqual([]);
    expect(exchangePaths(removesAsync.recursiveOnFull)).toEqual([]);
    expect(removesAsync.most).toBeLessThanOrEqual(64);
    expect(left).toEqual([]);
  }, 30_000);

  // A tree can run deeper than the longest path the system takes (1 024 bytes
  // on macOS, 4 096 on Linux), so the remove moves a directory up once its
  // path passes 257 bytes. APFS takes 255 three-byte characters in one name,
  // which no Linux file system does, so the move point itself is pinned.
  it("moves a directory up once its path passes 257 bytes", async () => {
    movedUp.length = 0;
    const { result, left } = await runInRoot(
      "bash-hoist-at",
      `set -euo pipefail
cd "$(dirname "$ARGENT_OUTPUT")"
a=$(printf 'a%.0s' $(seq 1 150))
mkdir -p "$a/$a/$a"
${ok}`
    );

    const moved = movedUp
      .filter((from) => from.includes(exchangeDirPrefix()))
      .map((from) => Buffer.byteLength(from));
    expect(result.ok).toBe(true);
    expect(moved.length).toBeGreaterThan(0);
    expect(Math.min(...moved)).toBeGreaterThan(257);
    expect(Math.min(...moved)).toBeLessThanOrEqual(512);
    expect(left).toEqual([]);
  }, 30_000);

  it.each([
    // Long names rather than many levels: bash takes quadratic time to `cd`
    // down a chain of short ones.
    [
      "a tree whose paths run past the longest the system takes",
      `name=$(printf 'd%.0s' $(seq 1 200))
for i in $(seq 1 25); do mkdir "$name" && cd "$name"; done
touch leaf`,
    ],
    ...(process.platform === "darwin"
      ? [
          [
            "names that are long in bytes",
            `a=$(printf 'a%.0s' $(seq 1 190))
wide=$(printf '字%.0s' $(seq 1 200))
mkdir -p "$a/$a" && cd "$a/$a"
touch "x$wide"
mkdir "$wide" && (cd "$wide" && touch "$wide")`,
          ],
        ]
      : []),
    // A move needs write permission on the directory itself, which an empty
    // read-only one refuses, so it is removed where it is.
    [
      "an empty read-only directory whose path has grown long",
      `long=$(printf 'r%.0s' $(seq 1 200))
mkdir -p "$long/$long" && chmod 500 "$long/$long"`,
    ],
    // Removing an empty directory asks only its parent, so one the step may
    // not list goes all the same.
    ["an empty directory the step may not list", `mkdir -m 000 closed\nmkdir -m 300 blind`],
  ])(
    "removes %s",
    async (_label, shape) => {
      const { result, left } = await runInRoot(
        "bash-shape-rm",
        `set -euo pipefail
cd "$(dirname "$ARGENT_OUTPUT")"
(${shape})
${ok}`
      );

      expect(result.ok).toBe(true);
      expect(result.notes.join(" ")).not.toContain("could not be removed");
      expect(left).toEqual([]);
    },
    90_000
  );
});
