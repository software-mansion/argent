import { rmSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two ways the filesystem can refuse the exchange directory, neither of
 * which a POSIX host reaches on its own: `EBUSY` on the removal, which Windows
 * answers while a surviving descendant still holds a file in it, and a write
 * that fails after the directory has been made (`ENOSPC`, `EROFS`, `EDQUOT`).
 * Only the named call is refused here; everything else passes straight through.
 *
 * Its own file, because the mock is module-wide.
 *
 * Deliberately NOT in the Windows job's list (`.github/workflows/windows-e2e.yml`):
 * both refusals arrive from the mock above rather than from a filesystem, so
 * what is asserted here is the same on every platform and the ubuntu job proves
 * it. Windows is named only as the host that produces the real `EBUSY`.
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
        // Not a directory, or not there.
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

describe("an exchange directory that will not go", () => {
  it("becomes a note on the result, never a throw", async () => {
    const ws = createScriptWorkspace("bash-busy");
    const script = ws.write("held.sh", `printf '{"ok":true}' > "$ARGENT_OUTPUT"`);
    refuseRemoval = (target) => target.includes(exchangeDirPrefix());
    try {
      const result = await new FlowScriptExecutor({ concurrency: 2 }).execute({
        scriptPath: script,
        interpreter: "bash",
        projectRoot: ws.dir,
      });

      expect(result.ok).toBe(true);
      expect(result.output).toEqual({ ok: true });
      const note = result.notes.join(" ");
      expect(note).toContain("could not be removed");
      expect(note).toContain("EBUSY");
      // The note names the directory it left behind, which is how the next
      // tool server's sweep finds it — and how this test cleans up after
      // itself rather than leaving a document under os.tmpdir().
      const left = new RegExp(`(\\S*${exchangeDirPrefix()}\\S+?) could not be removed`).exec(
        note
      )?.[1];
      expect(left).toBeDefined();
      refuseRemoval = undefined;
      rmSync(left!, { recursive: true, force: true });
    } finally {
      refuseRemoval = undefined;
      ws.cleanup();
    }
  }, 30_000);
});

describe("removing the exchange directory", () => {
  // A script can leave many files in its private directory - a fixture it
  // unpacked there, a clone. A synchronous recursive remove of 100 000 of them
  // held every request, device socket and flow on the host for 3.9 s, and an
  // awaited recursive `fs.promises.rm` of the whole tree still held it for 1.2 s,
  // because it starts one operation per entry at once.
  it("removes it in bounded batches, never in one call, before the step returns", async () => {
    const ws = createScriptWorkspace("bash-async-rm");
    const exchangeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argent-async-rm-root-"));
    const script = ws.write(
      "scratch.sh",
      `work="$(dirname "$ARGENT_OUTPUT")/work"
for d in 1 2 3; do mkdir -p "$work/$d" && (cd "$work/$d" && seq 1 100 | xargs touch); done
printf '{"ok":true}' > "$ARGENT_OUTPUT"`
    );
    removedSync.length = 0;
    removesAsync.most = 0;
    removesAsync.recursiveOnFull.length = 0;
    try {
      const result = await new FlowScriptExecutor({ concurrency: 2, exchangeRoot }).execute({
        scriptPath: script,
        interpreter: "bash",
        projectRoot: ws.dir,
      });

      const exchangePaths = (targets: string[]) =>
        targets.filter((target) => target.includes(exchangeDirPrefix()));
      expect(result.ok).toBe(true);
      expect(exchangePaths(removedSync)).toEqual([]);
      expect(exchangePaths(removesAsync.recursiveOnFull)).toEqual([]);
      expect(removesAsync.most).toBeLessThanOrEqual(64);
      expect(fs.readdirSync(exchangeRoot)).toEqual([]);
    } finally {
      fs.rmSync(exchangeRoot, { recursive: true, force: true });
      ws.cleanup();
    }
  }, 30_000);
});

describe("removing an exchange directory deeper than a path can name", () => {
  // A tree the script leaves can run deeper than the longest path the system
  // takes - 1 024 bytes on macOS, 4 096 on Linux - and no call by full path
  // gets through it. A remove that stopped at the limit left it behind for
  // good, because every later sweep stopped at the same place. Long names
  // rather than many levels, because bash takes quadratic time to `cd` down a
  // chain of short ones: 2 500 levels took 22 s to build, 25 of these 0.1 s.
  it("removes a tree whose paths run past the longest the system takes", async () => {
    const ws = createScriptWorkspace("bash-deep-rm");
    const exchangeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argent-deep-rm-root-"));
    const script = ws.write(
      "deep.sh",
      `set -euo pipefail
cd "$(dirname "$ARGENT_OUTPUT")"
name=$(printf 'd%.0s' $(seq 1 200))
for i in $(seq 1 25); do mkdir "$name" && cd "$name"; done
touch leaf
printf '{"ok":true}' > "$ARGENT_OUTPUT"`
    );
    try {
      const result = await new FlowScriptExecutor({ concurrency: 2, exchangeRoot }).execute({
        scriptPath: script,
        interpreter: "bash",
        projectRoot: ws.dir,
        timeoutMs: 20_000,
      });

      expect(result.ok).toBe(true);
      expect(result.notes.join(" ")).not.toContain("could not be removed");
      expect(fs.readdirSync(exchangeRoot)).toEqual([]);
    } finally {
      removeLeftovers(exchangeRoot);
      ws.cleanup();
    }
  }, 90_000);

  // APFS takes 255 characters in a name, and a character can take three bytes
  // in UTF-8, so one name can add 765 bytes: a parent of a few hundred is then
  // enough to carry the path past the 1 024 macOS takes. macOS only: Linux
  // file systems cap a name at 255 bytes.
  it.skipIf(process.platform !== "darwin")(
    "removes names that are long in bytes",
    async () => {
      const ws = createScriptWorkspace("bash-mb-rm");
      const exchangeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argent-mb-rm-root-"));
      const script = ws.write(
        "mb.sh",
        `set -euo pipefail
cd "$(dirname "$ARGENT_OUTPUT")"
a=$(printf 'a%.0s' $(seq 1 190))
wide=$(printf '字%.0s' $(seq 1 200))
mkdir -p "$a/$a" && cd "$a/$a"
touch "x$wide"
mkdir "$wide" && (cd "$wide" && touch "$wide")
printf '{"ok":true}' > "$ARGENT_OUTPUT"`
      );
      try {
        const result = await new FlowScriptExecutor({ concurrency: 2, exchangeRoot }).execute({
          scriptPath: script,
          interpreter: "bash",
          projectRoot: ws.dir,
          timeoutMs: 20_000,
        });

        expect(result.ok).toBe(true);
        expect(result.notes.join(" ")).not.toContain("could not be removed");
        expect(fs.readdirSync(exchangeRoot)).toEqual([]);
      } finally {
        removeLeftovers(exchangeRoot);
        ws.cleanup();
      }
    },
    30_000
  );
});

describe("where the batched remove moves a directory up", () => {
  // The point is set by APFS, where one name can add 765 bytes. No Linux file
  // system takes such a name, so the removals CI runs pass at any point below
  // 4 096 - which is why the move itself is pinned here: a directory whose
  // path has passed 257 bytes is moved before it is walked.
  it("moves a directory up once its path passes 257 bytes", async () => {
    const ws = createScriptWorkspace("bash-hoist-at");
    const exchangeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argent-hoist-at-root-"));
    const script = ws.write(
      "hoist.sh",
      `set -euo pipefail
cd "$(dirname "$ARGENT_OUTPUT")"
a=$(printf 'a%.0s' $(seq 1 150))
mkdir -p "$a/$a/$a"
printf '{"ok":true}' > "$ARGENT_OUTPUT"`
    );
    movedUp.length = 0;
    try {
      const result = await new FlowScriptExecutor({ concurrency: 2, exchangeRoot }).execute({
        scriptPath: script,
        interpreter: "bash",
        projectRoot: ws.dir,
      });

      const moved = movedUp
        .filter((from) => from.includes(exchangeDirPrefix()))
        .map((from) => Buffer.byteLength(from));
      expect(result.ok).toBe(true);
      expect(moved.length).toBeGreaterThan(0);
      expect(Math.min(...moved)).toBeGreaterThan(257);
      expect(Math.min(...moved)).toBeLessThanOrEqual(512);
      expect(fs.readdirSync(exchangeRoot)).toEqual([]);
    } finally {
      removeLeftovers(exchangeRoot);
      ws.cleanup();
    }
  }, 30_000);
});

describe("removing a read-only directory deep in the tree", () => {
  // Moving a directory to another parent needs write permission on the
  // directory itself, so an empty read-only one refuses the move - which the
  // plain `rmdir` of the recursive remove never asked of it. Such a directory
  // is removed where it is.
  it("removes an empty read-only directory whose path has grown long", async () => {
    const ws = createScriptWorkspace("bash-ro-rm");
    const exchangeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argent-ro-rm-root-"));
    const script = ws.write(
      "ro.sh",
      `set -euo pipefail
cd "$(dirname "$ARGENT_OUTPUT")"
long=$(printf 'r%.0s' $(seq 1 200))
mkdir -p "$long/$long" && chmod 500 "$long/$long"
printf '{"ok":true}' > "$ARGENT_OUTPUT"`
    );
    try {
      const result = await new FlowScriptExecutor({ concurrency: 2, exchangeRoot }).execute({
        scriptPath: script,
        interpreter: "bash",
        projectRoot: ws.dir,
        timeoutMs: 20_000,
      });

      expect(result.ok).toBe(true);
      expect(result.notes.join(" ")).not.toContain("could not be removed");
      expect(fs.readdirSync(exchangeRoot)).toEqual([]);
    } finally {
      removeLeftovers(exchangeRoot);
      ws.cleanup();
    }
  }, 30_000);
});

describe("an exchange directory that could not be filled", () => {
  // `mkdtemp` succeeds and then the write of the seeded document does not. The
  // caller is handed a throw with no exchange in it, so the `finally` that owns
  // the directory's life has nothing to remove — and the directory is left
  // under the shared temporary root, holding whatever the write got down.
  it("is removed by the call that made it, not left behind", async () => {
    const ws = createScriptWorkspace("bash-nospace");
    const exchangeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argent-nospace-root-"));
    const script = ws.write("never-runs.sh", `printf '{"ok":true}' > "$ARGENT_OUTPUT"`);
    refuseWrite = (target) =>
      target.includes(exchangeDirPrefix()) && path.basename(target) === "output.json";
    try {
      const result = await new FlowScriptExecutor({ concurrency: 2, exchangeRoot }).execute({
        scriptPath: script,
        interpreter: "bash",
        projectRoot: ws.dir,
      });

      expect(result.ok).toBe(false);
      expect(result.failure?.kind).toBe("spawn");
      expect(result.failure?.message).toContain("ENOSPC");
      expect(fs.readdirSync(exchangeRoot)).toEqual([]);
    } finally {
      refuseWrite = undefined;
      fs.rmSync(exchangeRoot, { recursive: true, force: true });
      ws.cleanup();
    }
  }, 30_000);
});
