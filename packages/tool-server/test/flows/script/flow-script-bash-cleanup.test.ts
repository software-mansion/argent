import { rmSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let refuseRemoval: ((target: string) => boolean) | undefined;
let refuseWrite: ((target: string) => boolean) | undefined;
const removedSync: string[] = [];
const removesAsync = { inFlight: 0, most: 0, recursiveOnFull: [] as string[] };
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
      } catch {}
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

describe("removing a directory the step may not list", () => {
  it("removes an empty directory it may not list", async () => {
    const ws = createScriptWorkspace("bash-unreadable-rm");
    const exchangeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argent-unreadable-rm-root-"));
    const script = ws.write(
      "unreadable.sh",
      `set -euo pipefail
cd "$(dirname "$ARGENT_OUTPUT")"
mkdir -m 000 closed
mkdir -m 300 blind
printf '{"ok":true}' > "$ARGENT_OUTPUT"`
    );
    try {
      const result = await new FlowScriptExecutor({ concurrency: 2, exchangeRoot }).execute({
        scriptPath: script,
        interpreter: "bash",
        projectRoot: ws.dir,
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

describe("an exchange directory when the step is cancelled", () => {
  // Every OTHER outcome of a bash step is covered by the two describes above,
  // which reach the removal through a refusal. A cancellation takes a different
  // exit out of `runChild` — the process is stopped rather than waited for —
  // and nothing asserted that the directory the step exchanges its document and
  // its reason through is taken with it. A leaked one accumulates under the
  // temporary directory for every cancelled run.
  it("removes it", async () => {
    const ws = createScriptWorkspace("bash-cancel");
    // Its OWN exchange root, not `os.tmpdir()`: every other file in this
    // directory makes exchange directories there too, and vitest runs them
    // together — a listing of the shared temp directory answers about their
    // steps as much as this one's.
    const exchangeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argent-cancel-root-"));
    const listing = (): string[] =>
      fs.readdirSync(exchangeRoot).filter((entry) => entry.startsWith(exchangeDirPrefix()));
    try {
      const script = ws.write("sleep.sh", "sleep 30\n");
      const controller = new AbortController();
      const executor = new FlowScriptExecutor({
        concurrency: 4,
        maxTimeoutMs: 60_000,
        exchangeRoot,
      });
      const run = executor.execute({
        scriptPath: script,
        interpreter: "bash",
        projectRoot: ws.dir,
        signal: controller.signal,
      });
      // Long enough for the fork and the exchange directory, short against the
      // script's own 30 seconds.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const during = listing();
      controller.abort();
      const result = await run;

      // Not vacuous: the assertion below says nothing unless the running step
      // really had a directory of its own to lose.
      expect(during).toHaveLength(1);
      expect(result.failure?.kind).toBe("cancelled");
      expect(listing()).toEqual([]);
    } finally {
      ws.cleanup();
      fs.rmSync(exchangeRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
