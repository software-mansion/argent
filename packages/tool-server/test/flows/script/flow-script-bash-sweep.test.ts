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
  it("judges each exchange directory by the bound its own step wrote", async () => {
    const ws = createScriptWorkspace("bash-sweep");
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);

    const unstamped = fs.mkdtempSync(path.join(exchangeRoot, exchangeDirPrefix()));
    fs.utimesSync(unstamped, longAgo, longAgo);

    const stamped = (owned: number): string =>
      fs.mkdtempSync(path.join(exchangeRoot, `${exchangeDirPrefix()}${Date.now() + owned}-`));
    const liveElsewhere = stamped(60 * 60 * 1000);
    fs.utimesSync(liveElsewhere, longAgo, longAgo);
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
  //
  // Not on Windows: its timers tick at about 15.6 ms, above the bound itself, so
  // a 5 ms heartbeat cannot resolve that bound there.
  it.skipIf(process.platform === "win32")(
    "sweeps a large root without stalling the event loop",
    async () => {
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
        expect(worstBlockMs).toBeLessThan(12);
      } finally {
        clearInterval(heartbeat);
        fs.rmSync(crowded, { recursive: true, force: true });
        ws.cleanup();
      }
    },
    120_000
  );

  it("stamps a fractional time limit as a whole millisecond", async () => {
    const ws = createScriptWorkspace("bash-fractional");
    try {
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

  // The sweep takes anything whose name carries the executor's prefix and a
  // past stamp. A link planted under such a name is removed as a link: the
  // directory it points to is not the sweep's, and the recursive `rm` the
  // batched remove replaced never followed it either. POSIX only, because a
  // symbolic link on Windows needs a privilege the CI runner lacks.
  it.skipIf(process.platform === "win32")(
    "removes a planted link, never what it points to",
    async () => {
      const ws = createScriptWorkspace("bash-sweep-link");
      const victim = fs.mkdtempSync(path.join(os.tmpdir(), "argent-sweep-victim-"));
      fs.writeFileSync(path.join(victim, "keep.txt"), "not the sweep's");
      const link = path.join(exchangeRoot, `${exchangeDirPrefix()}${Date.now() - 1_000}-planted`);
      fs.symlinkSync(victim, link);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const script = ws.write("link.sh", `printf '{"ok":true}' > "$ARGENT_OUTPUT"`);
        const result = await new FlowScriptExecutor({
          concurrency: 2,
          maxTimeoutMs: 60_000,
          exchangeRoot,
          exchangeSweepIntervalMs: 1,
        }).execute({ scriptPath: script, interpreter: "bash", projectRoot: ws.dir });

        expect(result.ok).toBe(true);
        expect(fs.readFileSync(path.join(victim, "keep.txt"), "utf8")).toBe("not the sweep's");
        expect(() => fs.lstatSync(link)).toThrow();
      } finally {
        fs.rmSync(link, { force: true });
        fs.rmSync(victim, { recursive: true, force: true });
        ws.cleanup();
      }
    },
    30_000
  );

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
        // The abandoned directory alone: the step removes its own exchange
        // through `fs.promises.rm` too, and slowing that as well let the sweep
        // finish first with or without the wait.
        if (String(target).startsWith(abandoned)) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return realRm(target, options);
      });
    try {
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
