import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exchangeDirPrefix,
  FlowScriptExecutor,
} from "../../../src/tools/flows/script/flow-script-executor";
import { createScriptWorkspace, type ScriptWorkspace } from "../../helpers/flow-script-workspace";
import { resolveHostBash } from "../../helpers/host-bash";

/**
 * The sweep of abandoned exchange directories, which a process runs on a bash
 * step and then not again until its interval has passed, so it needs a file of
 * its own where no earlier bash step took a turn. It exists for the orphan a
 * dead tool server leaves, whose document may hold values derived from a
 * secret. The root is this file's own: `os.tmpdir()` is shared with other
 * installs.
 */
let noBash: string | undefined;
let exchangeRoot: string;

beforeAll(async () => {
  exchangeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argent-sweep-root-"));
  const found = await resolveHostBash();
  if (!("path" in found)) noBash = found.problem;
});

beforeEach((ctx) => {
  if (noBash) ctx.skip(`this host has no bash to run a .sh step with: ${noBash}`);
});

afterAll(() => fs.rmSync(exchangeRoot, { recursive: true, force: true }));

afterEach(() => vi.restoreAllMocks());

const workspaces: ScriptWorkspace[] = [];
afterEach(() => {
  while (workspaces.length) workspaces.pop()!.cleanup();
});

/** One executor whose bash steps sweep `root`, and a step that passes. */
function stepper(options: { root?: string; intervalMs?: number } = {}) {
  const ws = createScriptWorkspace("bash-sweep");
  workspaces.push(ws);
  const runs = new FlowScriptExecutor({
    concurrency: 2,
    maxTimeoutMs: 60_000,
    exchangeRoot: options.root ?? exchangeRoot,
    ...(options.intervalMs === undefined ? {} : { exchangeSweepIntervalMs: options.intervalMs }),
  });
  return (source = `printf '{"ok":true}' > "$ARGENT_OUTPUT"`, timeoutMs?: number) =>
    runs.execute({
      scriptPath: ws.write("step.sh", source),
      interpreter: "bash",
      projectRoot: ws.dir,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
}

/** An exchange directory named the way a step whose bound is `boundAt` names it. */
function planted(boundAt: number, document?: string): string {
  const dir = fs.mkdtempSync(path.join(exchangeRoot, `${exchangeDirPrefix()}${boundAt}-`));
  if (document) fs.writeFileSync(path.join(dir, "output.json"), document);
  return dir;
}

const DERIVED = '{"token":"derived-from-a-secret"}';

describe("a bash step's sweep of the exchange root", () => {
  // One test, because the first bash step of the process is where every
  // directory planted before it is judged.
  it("judges each exchange directory by the bound its own step wrote", async () => {
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    // No bound in the name: an age cannot say what limit its step had.
    const unstamped = fs.mkdtempSync(path.join(exchangeRoot, exchangeDirPrefix()));
    fs.utimesSync(unstamped, longAgo, longAgo);
    // Another install's step, still within a limit longer than this one allows.
    const liveElsewhere = planted(Date.now() + 60 * 60 * 1000);
    fs.utimesSync(liveElsewhere, longAgo, longAgo);
    // Past its own bound, however new the directory is.
    const finishedElsewhere = planted(Date.now() - 1_000, DERIVED);

    try {
      expect((await stepper()()).ok).toBe(true);
      expect(fs.existsSync(finishedElsewhere)).toBe(false);
      expect(fs.existsSync(unstamped)).toBe(true);
      expect(fs.existsSync(liveElsewhere)).toBe(true);
    } finally {
      for (const dir of [unstamped, liveElsewhere, finishedElsewhere]) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 30_000);

  // In production the root is `os.tmpdir()`, bounded by nothing; a
  // whole-directory read builds one array of every name on the main thread.
  // Not on Windows, whose ~15.6 ms timer tick is above the bound itself.
  it.skipIf(process.platform === "win32")(
    "sweeps a large root without stalling the event loop",
    async () => {
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
        expect((await stepper({ root: crowded })()).ok).toBe(true);
        expect(worstBlockMs).toBeLessThan(12);
      } finally {
        clearInterval(heartbeat);
        fs.rmSync(crowded, { recursive: true, force: true });
      }
    },
    120_000
  );

  // The sweep reads the bound back with `/^(\d+)-/`, and a legal
  // `timeout: 1500.5` would otherwise name a directory it passes over forever.
  it("stamps a fractional time limit as a whole millisecond", async () => {
    const result = await stepper()(
      `printf '{"dir":"%s"}' "$(dirname "$ARGENT_OUTPUT")" > "$ARGENT_OUTPUT.t"
       mv "$ARGENT_OUTPUT.t" "$ARGENT_OUTPUT"`,
      1500.5
    );

    expect(result.ok).toBe(true);
    const name = path.basename(String(result.output?.dir));
    expect(name.startsWith(exchangeDirPrefix())).toBe(true);
    expect(name.slice(exchangeDirPrefix().length)).toMatch(/^\d+-/);
  }, 30_000);

  // An owner that died with its bound still ahead leaves a directory that reads
  // as live at first; a later sweep has to come back for it.
  it("comes back for a directory whose owner died with its bound still ahead", async () => {
    const orphan = planted(Date.now() + 800, DERIVED);
    try {
      const step = stepper({ intervalMs: 50 });
      expect((await step()).ok).toBe(true);
      expect(fs.existsSync(orphan)).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 1_000));

      expect((await step()).ok).toBe(true);
      expect(fs.existsSync(orphan)).toBe(false);
    } finally {
      fs.rmSync(orphan, { recursive: true, force: true });
    }
  }, 30_000);

  // The throttle is what bounds reads of a shared root to one per interval.
  // Counted at `opendir`, which is the read.
  it("reads the root once however many steps run inside the interval", async () => {
    const opendir = vi.spyOn(fs.promises, "opendir");
    const step = stepper({ intervalMs: 60_000 });
    for (let i = 0; i < 4; i += 1) expect((await step()).ok).toBe(true);

    const reads = opendir.mock.calls.filter(([target]) => target === exchangeRoot);
    expect(reads.length).toBeLessThanOrEqual(1);
  }, 60_000);

  // A link planted under the prefix is removed as a link, never followed. A
  // symbolic link on Windows needs a privilege the CI runner lacks.
  it.skipIf(process.platform === "win32")(
    "removes a planted link, never what it points to",
    async () => {
      const victim = fs.mkdtempSync(path.join(os.tmpdir(), "argent-sweep-victim-"));
      fs.writeFileSync(path.join(victim, "keep.txt"), "not the sweep's");
      const link = path.join(exchangeRoot, `${exchangeDirPrefix()}${Date.now() - 1_000}-planted`);
      fs.symlinkSync(victim, link);
      try {
        // Past the interval, so this step's sweep is not the throttled one.
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect((await stepper({ intervalMs: 1 })()).ok).toBe(true);
        expect(fs.readFileSync(path.join(victim, "keep.txt"), "utf8")).toBe("not the sweep's");
        expect(() => fs.lstatSync(link)).toThrow();
      } finally {
        fs.rmSync(link, { force: true });
        fs.rmSync(victim, { recursive: true, force: true });
      }
    },
    30_000
  );

  // `runOne` waits on its sweep. The sweep's own removal is slowed, because
  // without the wait a small root still passes when `rm` wins the race.
  it("has finished its sweep by the time the step resolves", async () => {
    const abandoned = planted(Date.now() - 1_000, DERIVED);
    const realRm = fs.promises.rm;
    vi.spyOn(fs.promises, "rm").mockImplementation(
      async (target: Parameters<typeof realRm>[0], options) => {
        // The abandoned directory alone: slowing the step's own removal too
        // let the sweep finish first with or without the wait.
        if (String(target).startsWith(abandoned)) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return realRm(target, options);
      }
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect((await stepper({ intervalMs: 1 })()).ok).toBe(true);
      expect(fs.existsSync(abandoned)).toBe(false);
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(abandoned, { recursive: true, force: true });
    }
  }, 30_000);
});
