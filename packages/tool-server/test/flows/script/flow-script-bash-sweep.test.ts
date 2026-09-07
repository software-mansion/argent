import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  exchangeDirPrefix,
  FlowScriptExecutor,
} from "../../../src/tools/flows/script/flow-script-executor";
import { createScriptWorkspace } from "../../helpers/flow-script-workspace";
import { resolveHostBash } from "../../helpers/host-bash";

/**
 * The sweep of abandoned exchange directories, which a process runs on a bash
 * step and then not again until its interval has passed — so it needs a test
 * file of its own, where no earlier bash step has already taken a turn. vitest
 * isolates the module registry per file, which is what makes that hold.
 *
 * It exists for the orphan case: when the tool server dies mid-step the
 * lifeline kills the runner and nobody reaches the exchange directory, and the
 * document in it may hold values derived from a secret.
 *
 * The root is this file's own rather than `os.tmpdir()`: that one holds the
 * exchange directories of every other argent install on the machine, so what a
 * sweep does there is not a fact about these fixtures.
 */
let noBash: string | undefined;

beforeAll(async () => {
  const found = await resolveHostBash();
  if (!("path" in found)) noBash = found.problem;
});

beforeEach((ctx) => {
  if (noBash) ctx.skip(`this host has no bash to run a .sh step with: ${noBash}`);
});

let exchangeRoot: string;

beforeAll(() => {
  exchangeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argent-sweep-root-"));
});

afterAll(() => fs.rmSync(exchangeRoot, { recursive: true, force: true }));

describe("a bash step's sweep of the exchange root", () => {
  // One test for the judging, because the first bash step of the process is
  // where every directory planted before it is judged.
  it("judges each exchange directory by the bound its own step wrote", async () => {
    const ws = createScriptWorkspace("bash-sweep");
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);

    // A name this executor never wrote, carrying no bound of its own. Its age
    // is all there is to read, and an age cannot say what time limit the step
    // that made it was given — so it is left alone rather than judged by this
    // install's own bound.
    const unstamped = fs.mkdtempSync(path.join(exchangeRoot, exchangeDirPrefix()));
    fs.utimesSync(unstamped, longAgo, longAgo);

    // A step of another install, still running, whose own time limit is longer
    // than anything this install would allow. A directory's mtime does advance
    // when a file is created inside it, but it can never carry the OWNER's
    // bound, which is the whole reason the name does.
    const stamped = (owned: number): string =>
      fs.mkdtempSync(path.join(exchangeRoot, `${exchangeDirPrefix()}${Date.now() + owned}-`));
    const liveElsewhere = stamped(60 * 60 * 1000);
    fs.utimesSync(liveElsewhere, longAgo, longAgo);
    // And one whose own bound has passed, which is abandoned however new the
    // directory is.
    const finishedElsewhere = stamped(-1_000);
    fs.writeFileSync(
      path.join(finishedElsewhere, "output.json"),
      '{"token":"derived-from-a-secret"}'
    );

    try {
      const script = ws.write("sweep.sh", `printf '{"ok":true}' > "$ARGENT_OUTPUT"`);
      const result = await new FlowScriptExecutor({
        concurrency: 2,
        maxTimeoutMs: 60_000,
        exchangeRoot,
      }).execute({ scriptPath: script, interpreter: "bash", projectRoot: ws.dir });

      expect(result.ok).toBe(true);
      expect(fs.existsSync(finishedElsewhere)).toBe(false);
      expect(fs.existsSync(unstamped)).toBe(true);
      expect(fs.existsSync(liveElsewhere)).toBe(true);
    } finally {
      for (const dir of [unstamped, liveElsewhere, finishedElsewhere]) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      ws.cleanup();
    }
  }, 30_000);

  // The orphan a crashed tool server leaves is stamped with a moment in the
  // FUTURE — its dead owner's whole time limit still ahead of it — so the next
  // server's first bash step reads it as live and passes over it. A process
  // that swept exactly once then left it for good, which is neither what the
  // reference promises nor what the document in it deserves.
  it("comes back for a directory whose owner died with its bound still ahead", async () => {
    const ws = createScriptWorkspace("bash-resweep");
    const orphan = fs.mkdtempSync(
      path.join(exchangeRoot, `${exchangeDirPrefix()}${Date.now() + 800}-`)
    );
    fs.writeFileSync(path.join(orphan, "output.json"), '{"token":"derived-from-a-secret"}');

    try {
      const script = ws.write("resweep.sh", `printf '{"ok":true}' > "$ARGENT_OUTPUT"`);
      const runs = new FlowScriptExecutor({
        concurrency: 2,
        maxTimeoutMs: 60_000,
        exchangeRoot,
        exchangeSweepIntervalMs: 50,
      });
      const step = (): Promise<{ ok: boolean }> =>
        runs.execute({ scriptPath: script, interpreter: "bash", projectRoot: ws.dir });

      expect((await step()).ok).toBe(true);
      expect(fs.existsSync(orphan)).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 1_000));

      expect((await step()).ok).toBe(true);
      expect(fs.existsSync(orphan)).toBe(false);
    } finally {
      fs.rmSync(orphan, { recursive: true, force: true });
      ws.cleanup();
    }
  }, 30_000);
});
