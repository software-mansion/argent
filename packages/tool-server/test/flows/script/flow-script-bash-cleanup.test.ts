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

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const rmSync: typeof actual.rmSync = (target, options) => {
    if (refuseRemoval?.(String(target))) {
      throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    }
    return actual.rmSync(target, options);
  };
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
    default: { ...actual, rmSync, writeFileSync },
  };
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  exchangeDirPrefix,
  FlowScriptExecutor,
} from "../../../src/tools/flows/script/flow-script-executor";
import { createScriptWorkspace } from "../../helpers/flow-script-workspace";
import { resolveHostBash } from "../../helpers/host-bash";

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

describe("an exchange directory that could not be filled", () => {
  // `mkdtemp` succeeds and then a write does not. The caller is handed a throw
  // with no exchange in it, so the `finally` that owns the directory's life has
  // nothing to remove — and the directory is left under the shared temporary
  // root holding the document it was seeded with.
  it("is removed by the call that made it, not left behind", async () => {
    const ws = createScriptWorkspace("bash-nospace");
    const exchangeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argent-nospace-root-"));
    const script = ws.write("never-runs.sh", `printf '{"ok":true}' > "$ARGENT_OUTPUT"`);
    refuseWrite = (target) => target.endsWith("reason.txt");
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
