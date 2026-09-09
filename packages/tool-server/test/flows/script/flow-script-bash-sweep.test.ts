import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

  // The throttle bounds how OFTEN the root is read, not what one read costs -
  // and in production that root is `os.tmpdir()`, shared with every process on
  // the host and bounded by nothing. A whole-directory read builds one array of
  // every name on the main thread however it was scheduled, so the sweep of a
  // large root stalled the tool server's event loop: no MCP request, device
  // socket or timer ran during it. A handle read in small batches leaves the
  // loop between them.
  it("sweeps a large root without stalling the event loop", async () => {
    const ws = createScriptWorkspace("bash-sweep-stall");
    const crowded = fs.mkdtempSync(path.join(os.tmpdir(), "argent-sweep-crowded-"));
    for (let i = 0; i < 40_000; i += 1) fs.mkdirSync(path.join(crowded, `junk-${i}`));

    let worstBlockMs = 0;
    let last = process.hrtime.bigint();
    const heartbeat = setInterval(() => {
      const now = process.hrtime.bigint();
      worstBlockMs = Math.max(worstBlockMs, Number(now - last) / 1e6 - 5);
      last = now;
    }, 5);
    try {
      const script = ws.write("crowded.sh", `printf '{"ok":true}' > "$ARGENT_OUTPUT"`);
      const result = await new FlowScriptExecutor({
        concurrency: 2,
        maxTimeoutMs: 60_000,
        exchangeRoot: crowded,
      }).execute({ scriptPath: script, interpreter: "bash", projectRoot: ws.dir });

      expect(result.ok).toBe(true);
      // 21-22 ms on this machine before, 0 after; the margin is for a loaded one.
      expect(worstBlockMs).toBeLessThan(12);
    } finally {
      clearInterval(heartbeat);
      fs.rmSync(crowded, { recursive: true, force: true });
      ws.cleanup();
    }
  }, 120_000);

  // The bound a directory carries has to be a whole number of milliseconds,
  // because the sweep reads it back with `/^(\d+)-/` and a `.` matches nothing
  // there. `flow-script-step-parse.test.ts` pins `timeout: 1500.5` as a legal
  // step and `clampTimeout` returns a wanted value un-rounded, so the
  // fractional value really reaches the name - and a directory named
  // `argent-flow-script-<n>.5-XXXXXX` would be passed over forever, keeping an
  // `output.json` that may hold values derived from a secret under the shared
  // `os.tmpdir()`.
  it("stamps a fractional time limit as a whole millisecond", async () => {
    const ws = createScriptWorkspace("bash-fractional");
    try {
      // The step reports its own exchange directory, which is otherwise removed
      // before anything outside the executor could look at it.
      const script = ws.write(
        "fractional.sh",
        `printf '{"dir":"%s"}' "$(dirname "$ARGENT_OUTPUT")" > "$ARGENT_OUTPUT.t"
         mv "$ARGENT_OUTPUT.t" "$ARGENT_OUTPUT"`
      );
      const result = await new FlowScriptExecutor({
        concurrency: 2,
        maxTimeoutMs: 60_000,
        exchangeRoot,
      }).execute({
        scriptPath: script,
        interpreter: "bash",
        projectRoot: ws.dir,
        timeoutMs: 1500.5,
      });

      expect(result.ok).toBe(true);
      const name = path.basename(String(result.output?.dir));
      expect(name.startsWith(exchangeDirPrefix())).toBe(true);
      expect(name.slice(exchangeDirPrefix().length)).toMatch(/^\d+-/);
    } finally {
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

  // The throttle is the whole of the "a single read a minute rather than one
  // per step" bound the sweep's docstring claims, and in production the root is
  // `os.tmpdir()` - shared with every process on the host and bounded by
  // nothing, where one read cost 48 ms of blocked event loop on a machine
  // holding 88 000 entries. Counted at `opendir`, which is the read.
  it("reads the root once however many steps run inside the interval", async () => {
    const ws = createScriptWorkspace("bash-throttle");
    const opendir = vi.spyOn(fs.promises, "opendir");
    try {
      const script = ws.write("throttle.sh", `printf '{"ok":true}' > "$ARGENT_OUTPUT"`);
      const runs = new FlowScriptExecutor({
        concurrency: 2,
        maxTimeoutMs: 60_000,
        exchangeRoot,
        exchangeSweepIntervalMs: 60_000,
      });
      for (let step = 0; step < 4; step += 1) {
        const result = await runs.execute({
          scriptPath: script,
          interpreter: "bash",
          projectRoot: ws.dir,
        });
        expect(result.ok).toBe(true);
      }

      const reads = opendir.mock.calls.filter(([target]) => target === exchangeRoot);
      expect(reads.length).toBeLessThanOrEqual(1);
    } finally {
      opendir.mockRestore();
      ws.cleanup();
    }
  }, 60_000);

  // A step never outlives its own sweep: `runOne` waits on it, so the root is
  // readable the moment `execute` resolves and a document a dead owner left is
  // gone by then rather than shortly after. Without the wait a small root still
  // passed, because `rm` won the race - so the sweep's own removal is slowed
  // here, which is the only thing that tells the two apart.
  it("has finished its sweep by the time the step resolves", async () => {
    const ws = createScriptWorkspace("bash-await-sweep");
    const abandoned = fs.mkdtempSync(
      path.join(exchangeRoot, `${exchangeDirPrefix()}${Date.now() - 1_000}-`)
    );
    fs.writeFileSync(path.join(abandoned, "output.json"), '{"token":"derived-from-a-secret"}');
    const realRm = fs.promises.rm;
    const rm = vi
      .spyOn(fs.promises, "rm")
      .mockImplementation(async (target: Parameters<typeof realRm>[0], options) => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return realRm(target, options);
      });
    try {
      // Past the interval, so this step's own sweep is not the throttled one.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const script = ws.write("await-sweep.sh", `printf '{"ok":true}' > "$ARGENT_OUTPUT"`);
      const result = await new FlowScriptExecutor({
        concurrency: 2,
        maxTimeoutMs: 60_000,
        exchangeRoot,
        exchangeSweepIntervalMs: 1,
      }).execute({ scriptPath: script, interpreter: "bash", projectRoot: ws.dir });

      expect(result.ok).toBe(true);
      expect(fs.existsSync(abandoned)).toBe(false);
    } finally {
      rm.mockRestore();
      fs.rmSync(abandoned, { recursive: true, force: true });
      ws.cleanup();
    }
  }, 30_000);
});

afterEach(() => vi.restoreAllMocks());
