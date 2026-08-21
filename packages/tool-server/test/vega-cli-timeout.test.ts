import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync, spawn, spawnSync } from "node:child_process";
import { getFailureSignal } from "@argent/registry";
import { runVega, __resetVegaBinaryCacheForTests } from "../src/utils/vega-cli";

// Real-subprocess regression cover for the `list-devices` "hang" + process leak.
// Against a wedged device agent the `vega` CLI forks a launcher → worker tree that
// never returns; a worker holding the stdout pipe kept the old execFile-based call
// pending for the full timeout, and SIGKILLing only the direct child orphaned the
// rest of the tree. runVega spawns the launcher `detached` (its own process
// group), SIGKILLs the whole group on timeout, AND sweeps any descendant that
// escaped the group — so a timed-out call settles on its own deadline and leaves no
// orphans behind it. We exercise that with a fake `vega` on PATH (not mocks) so the real
// spawn / detached / group-kill / descendant-sweep path is what runs.
//
// The fake is a node launcher that (a) forks a `detached` `sleep <secs>` worker — its
// OWN process group, so a group-only kill can't reach it (this reproduces the
// setsid'd `dutyfree-vega` worker the group SIGKILL alone would orphan) — which also
// inherits the launcher's stdout (reproducing the pipe-held-open freeze), and (b)
// itself blocks on a same-group `sleep <secs>` so the launcher stays alive long
// enough to be timed out and snapshotted. Once both workers exist the descendant sweep
// reaps them by itself; the group kill covers the window before they do, which is what the
// overflow tests hit — their reap trips on the launcher's first write, so under load it can
// snapshot an empty tree and only killing the group stops the sleep from outliving the call.
// Each test passes its OWN sentinel so one test's strays can't be mistaken for
// another's, and every sentinel shares a per-run prefix so afterEach can sweep them
// all with a single tight pattern (see sweep()).
//
// That prefix must be unique to THIS test process, because strayCount/sweep match
// sentinels against the command line of every process on the machine. A second
// concurrent run of this file — two agents running the suite at once, or the suite
// alongside a single-file run — would otherwise share one sentinel namespace, and each
// run's afterEach sweep would kill the other run's live workers: the `hang`
// launcher's blocking `sleep` returns, the launcher exits 0, and runVega resolves
// cleanly at ~100ms instead of timing out, so both `hang` tests fail. The tag is the
// pid (unique among live processes, so two concurrent runs can never share one) plus
// three random digits, so a worker leaked by an earlier run is mistaken for one of
// ours only if its pid has since been recycled AND the random digits collide (1/1000).
//
// It rides in the FRACTION of the sleep duration rather than being the duration: a run
// killed before afterAll leaves the workers behind, so the whole-second part caps that
// leak at ~ten minutes. That part must also outlast the longest assertion window - the
// drain test's 10s observation plus its 3s clearance poll - by a wide margin, because a
// worker that dies of old age inside it satisfies every clearance assertion without a
// reap: at 5s the descendant sweep can be deleted with the suite still 12/12 green.
const randomTagBlock = (): string => String(Math.floor(Math.random() * 1000)).padStart(3, "0");
const RUN_TAG = `${process.pid}${randomTagBlock()}`;
const WORKER_LIFETIME_SECONDS = 600;
const SENTINEL_PREFIX = `${WORKER_LIFETIME_SECONDS}.${RUN_TAG}`;
/**
 * One worker slot. The slot is a single digit by type and has to stay one: it makes every
 * sentinel exactly `<pid><3 digits><1 digit>` wide, which — together with the `$` anchor in
 * cmdlinePattern — is what keeps one run from matching another's workers. Equal-width
 * sentinels force equal-width pids, hence the same pid, which two live processes cannot
 * have. A two-digit slot breaks that: pid 1234 / 567 / slot 10 spells `600.123456710`,
 * which pid 12345 / 671's sweep glob `600\.12345671[0-9]` matches and kills.
 */
type SentinelSlot = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
const sentinel = (slot: SentinelSlot): string => `${SENTINEL_PREFIX}${slot}`;
const SENTINEL_DEADLINE = sentinel(1);
const SENTINEL_REAP = sentinel(2);
const SENTINEL_OVERFLOW = sentinel(3);
const SENTINEL_LINGER = sentinel(4);
const SENTINEL_OVERFLOW_ERR = sentinel(5);
const SENTINEL_LINGER_NEAR_DEADLINE = sentinel(6);
const SENTINEL_LINGER_GROUPED = sentinel(7);
const SENTINEL_SWEEP = sentinel(8);
let dir: string;
let prevPath: string | undefined;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "argent-fakevega-"));
  writeFileSync(
    join(dir, "vega"),
    `#!/usr/bin/env node
const { spawn, spawnSync } = require("node:child_process");
const [cmd, secs] = process.argv.slice(2);
if (cmd === "hang") {
  // A worker that ESCAPES the launcher's process group (detached → its own session/
  // pgid, like the real CLI's setsid'd worker), so the group-only SIGKILL can't reach
  // it — only the descendant sweep does. It also inherits our stdout, reproducing the
  // pipe-held-open freeze. \`secs\` is a per-test sentinel so pgrep finds strays
  // unambiguously.
  const worker = spawn("sleep", [secs], { detached: true, stdio: ["ignore", "inherit", "ignore"] });
  worker.unref();
  // The launcher itself also hangs so it stays alive to be timed out and snapshotted.
  // This sleep is a descendant, so the sweep reaps it before the group kill runs.
  spawnSync("sleep", [secs]);
  process.exit(0);
}
if (cmd === "fail") {
  // A fast, non-timeout failure: exit non-zero with stderr (like "device offline").
  // runVega must reject classifying this as a "subprocess" failure, NOT a "timeout".
  process.stderr.write("device offline");
  process.exit(3);
}
if (cmd === "flood") {
  // Emit more than the test's maxOutputBytes, then hang on a sentinel sleep so the
  // OVERFLOW reap — not a natural exit — is what settles runVega. The reap must clear
  // this sleep too. \`secs\` is the per-test sentinel.
  process.stdout.write("x".repeat(4096));
  spawnSync("sleep", [secs]);
  process.exit(0);
}
if (cmd === "flood-err") {
  // Same as \`flood\` but floods STDERR instead of stdout — the cap applies per stream
  // (like execFile's maxBuffer), so an stderr flood must also reap+reject rather than
  // grow unbounded. Hangs on a sentinel sleep so the overflow reap is what settles it.
  process.stderr.write("x".repeat(4096));
  spawnSync("sleep", [secs]);
  process.exit(0);
}
if (cmd === "linger") {
  // A CLEAN exit whose \`close\` is delayed: fork a detached worker that INHERITS our
  // stdout (holding the write end open) and unref it, then write the result and let
  // the launcher exit 0 naturally. \`close\` on our parent won't fire until the worker
  // dies (its sentinel sleep), but \`exit\` fires now — runVega must resolve from the
  // exit + drain grace with the captured stdout instead of waiting out the timeout.
  const worker = spawn("sleep", [secs], { detached: true, stdio: ["ignore", "inherit", "ignore"] });
  worker.unref();
  process.stdout.write("OK-linger");
  // No process.exit: with the worker unref'd nothing keeps our loop alive, so we exit
  // 0 naturally (flushing stdout) while the detached worker keeps the pipe open.
  return;
}
if (cmd === "linger-grouped") {
  // Like \`linger\`, but the worker is NOT detached — so it stays in the launcher's
  // process group (pgid == launcher pid) while still inheriting our stdout (delaying
  // \`close\`) and being unref'd so the launcher exits 0 naturally. This is the COMMON
  // pipe-inheritance case (the detached \`linger\` worker deliberately escapes into its
  // own group): a live group member pins the launcher's pid as a pgid, so runVega can
  // reap it post-exit via a pgid-membership group kill. \`secs\` is the per-test sentinel.
  const worker = spawn("sleep", [secs], { stdio: ["ignore", "inherit", "ignore"] });
  worker.unref();
  process.stdout.write("OK-linger");
  return;
}
process.stdout.write("OK-" + cmd);
`,
    { mode: 0o755 }
  );
  prevPath = process.env.PATH;
  process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
  // macOS charges the FIRST exec of a newly written file (~110-180ms idle, far more under
  // load) and nothing after it; a fresh `#!/bin/sh` script shows the same jump, so this is
  // not `node` starting and warming `node` elsewhere does not help — only running THIS
  // file does. It has to happen here because the near-deadline test gives the launcher
  // 900ms and cannot give it more. Without this, whichever test runs first pays it, so
  // only a solo run of that test was exposed, and only at concurrency: 38 of 60 solo runs
  // rejected at 20-way, none sequentially. Linux has no such penalty, so this
  // buys CI nothing. Any unknown argument takes the write-and-exit default.
  spawnSync(join(dir, "vega"), ["warmup"], { stdio: "ignore" });
  // Explicit because this hook spawns: a hook resolves its budget when it is REGISTERED,
  // so the vi.setConfig below - which runs later - cannot reach it, and its hookTimeout
  // would silently leave this on the 10s default.
}, 20_000);

afterAll(() => {
  process.env.PATH = prevPath;
  sweep();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  __resetVegaBinaryCacheForTests();
});

afterEach(() => sweep());

/**
 * `pgrep`/`pkill` ERE matching a worker whose whole command line is exactly
 * `sleep <target>`, where `target` is one sentinel or `<SENTINEL_PREFIX>[0-9]` for all
 * of this run's.
 *
 * `$` is what confines a sweep to its own run: without it the glob also matches the
 * sentinels of a run whose pid is one digit longer (see `SentinelSlot`). `^` pins the
 * match to argv[0], so a longer command line that merely ends in one of our sentinels
 * cannot match — including the `/bin/sh -c "pgrep -f '<pattern>' || true"` wrapper
 * execSync spawns, whose own argv carries the pattern text.
 *
 * The sentinel's `.` is its one ERE metacharacter, so escape it; a `[0-9]` slot glob
 * passes through as the character class it is. Each of the three independently excludes
 * that wrapper, and only GNU procps (CI) can match it at all: BSD pgrep drops its own
 * ancestors, so macOS never reproduces it.
 */
function cmdlinePattern(target: string): string {
  return `^sleep ${target.replaceAll(".", "\\.")}$`;
}

function sweep(): void {
  try {
    execSync(`pkill -f '${cmdlinePattern(`${SENTINEL_PREFIX}[0-9]`)}' || true`);
  } catch {
    // `|| true` maps every `pkill` exit - no-match, or `pkill` itself missing - to 0, so
    // only the shell itself failing reaches here - fork EAGAIN under load, the same mode
    // strayCount absorbs, or the shell dying on a signal. Throwing out of cleanup would
    // mask the result of the test that just ran, and any stray this misses dies within
    // WORKER_LIFETIME_SECONDS.
  }
}

// How many `sleep <sentinel>` workers are live, and how many distinct process groups they
// occupy, from ONE `ps` rather than this file's usual `pgrep`. A pgrep for the pids
// followed by a `ps` for their groups is two looks: the second can land after the reap has
// begun and pair a count of 2 with 0 groups, failing the observation over a state that
// never existed. One table read cannot disagree with itself.
function sampleWorkers(sentinel: string): { workers: number; groups: number } {
  try {
    // Whole table: `-p <pids>` would need the pid list this call exists to avoid reading
    // separately. maxBuffer is raised because -A scales with the machine, not the match.
    const out = execSync("ps -Ao pgid=,command=", {
      encoding: "utf-8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const groups = new Set<number>();
    let workers = 0;
    for (const line of out.split("\n")) {
      const row = line.trim();
      const gap = row.indexOf(" ");
      // Whole-command equality, the same shape cmdlinePattern's `^`/`$` anchor for pgrep.
      if (gap < 0 || row.slice(gap + 1) !== `sleep ${sentinel}`) continue;
      workers += 1;
      groups.add(Number(row.slice(0, gap)));
    }
    return { workers, groups: groups.size };
  } catch {
    // -1s, not 0s: see strayCount. Here 0 would fail the assertion too, so this is only
    // to keep a failed look legible in the diff instead of reading as "none spawned yet".
    return { workers: -1, groups: -1 };
  }
}

// Poll until `want` workers are up, or the deadline passes; either way return the last
// sample - group count included, not waited on (see below). Values rather than a
// timed-out flag, so the caller asserts on the numbers.
async function waitForWorkerGroups(
  sentinel: string,
  want: number,
  timeoutMs: number
): Promise<{ workers: number; groups: number }> {
  const deadline = Date.now() + timeoutMs;
  let sample = sampleWorkers(sentinel);
  // Waits on the workers appearing, not on the groups being right: `detached` gives a child
  // its own pgid before it execs, so once `want` of them are up the group count is already
  // final. Polling on the groups as well would burn the whole budget whenever the premise is
  // false, and by then the reap has run - reporting {0,0} instead of the count that shows
  // which half broke.
  while (sample.workers !== want && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    sample = sampleWorkers(sentinel);
  }
  return sample;
}

function strayCount(sentinel: string): number {
  try {
    const out = execSync(`pgrep -f '${cmdlinePattern(sentinel)}' || true`, { encoding: "utf-8" });
    return out.split("\n").filter((l) => l.trim()).length;
  } catch {
    // -1, not 0: 0 is the pass value of every clearance assertion, so a look that never
    // happened would read as "reaped, nothing left behind". -1 matches no `want`, so
    // waitForCount polls on through a transient spawn failure (EAGAIN under load); it
    // surfaces only when the failure was the last poll before the deadline.
    return -1;
  }
}

// Poll `strayCount` until it reaches `want`, or the deadline passes. Returns the final
// count, so the caller asserts on a number rather than on having timed out.
async function waitForCount(sentinel: string, want: number, timeoutMs = 3_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let count = strayCount(sentinel);
  while (count !== want && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    count = strayCount(sentinel);
  }
  return count;
}

// Signal delivery and teardown are asynchronous, so poll rather than sample once.
async function waitForClear(sentinel: string, timeoutMs = 3_000): Promise<number> {
  return waitForCount(sentinel, 0, timeoutMs);
}

// Regressions here fail SLOWLY: a test waits out its runVega deadline (up to 10s, with any
// worker observation running concurrently against it), then polls 3s for the reap. Under
// vitest's 5s default that reports "Test timed out" instead of the assertion naming what
// actually broke.
vi.setConfig({ testTimeout: 20_000 });

describe("runVega timeout (real subprocess)", () => {
  it("rejects on its own deadline when the CLI never returns", async () => {
    const start = Date.now();
    const err = await runVega(["hang", SENTINEL_DEADLINE], { timeoutMs: 400 }).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/timed out/i);
    // The message alone proves nothing about classification — `rejectTimeout` builds
    // it unconditionally. What listVegaDevices keys its recovery-skip off is
    // `error_kind: "timeout"`, so assert it here, derived from a REAL runVega timeout
    // (not a fabricated FailureError). A regression that dropped killed/signal from the
    // rejection shape — so a genuine timeout classified as `subprocess` — would pass the
    // message match but re-introduce the stacked ~40s stall; this assertion catches it.
    expect(getFailureSignal(err)?.error_kind).toBe("timeout");
    const elapsed = Date.now() - start;
    // Settles right around the 400ms deadline — proving it does NOT wait on the
    // worker that holds the stdout pipe open.
    expect(elapsed).toBeLessThan(2_500);
  });

  it("reaps the ENTIRE worker tree on timeout — including a worker that escaped the group", async () => {
    // Settled through `.catch` rather than left floating: nothing awaits this promise
    // until the observation below finishes, and an unawaited rejection is reported as
    // an unhandled one that vitest does not retract when the handler attaches late.
    // Both workers have to be up before this reaps them, so their spawn races this
    // deadline. The observation below has taken 1485ms at 50-way concurrency - more than
    // the launcher's own start, since it also covers the second spawn, pgrep's fork and
    // the 50ms poll step - and this leaves that 2.7x.
    const REAP_DEADLINE_MS = 4_000;
    const run = runVega(["hang", SENTINEL_REAP], { timeoutMs: REAP_DEADLINE_MS }).catch(
      (e: unknown) => e
    );
    // Observe the pair BEFORE the reap: `waitForClear` reads 0 just as readily for a
    // launcher that never spawned them, so without this the reap below is asserted
    // against nothing. Two GROUPS, not just two workers — that is what makes one of them
    // escaped, and the descendant sweep rather than the group SIGKILL the only thing that
    // can reap it; left unasserted, the fake's `detached: true` can be dropped and this
    // test stays green with the sweep deleted. The poll gets the whole deadline as its
    // budget, for the reason the drain observation below spells out. The two output-cap
    // reaps stay unpinned for want of such a window — theirs fires within ~100ms of the
    // spawn (#841).
    expect(await waitForWorkerGroups(SENTINEL_REAP, 2, REAP_DEADLINE_MS)).toEqual({
      workers: 2,
      groups: 2,
    });
    const err = await run;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/timed out/i);
    // Two sleeps must disappear: the launcher's own child AND the worker that escaped
    // into its own group. Both fall to the descendant sweep — killing the launcher alone
    // leaves both behind, and a group kill without the sweep still misses the escaped one.
    expect(await waitForClear(SENTINEL_REAP)).toBe(0);
  });

  it("returns normally when the CLI responds before the deadline", async () => {
    await expect(runVega(["go"], { timeoutMs: 5_000 })).resolves.toEqual({
      stdout: "OK-go",
      stderr: "",
    });
  });

  it("resolves a clean exit even when a worker holds the stdout pipe open (delayed close)", async () => {
    // The pipe-inheritance freeze on the SUCCESS path: the launcher exits 0 with its
    // output already written, but a grandchild keeps the stdout pipe open so `close`
    // never arrives. Resolving only on `close` would stall this finished call until the
    // timeout and then reject it as a timeout — discarding valid output. runVega instead
    // falls back to `exit` + a short drain grace and resolves with the captured stdout.
    const start = Date.now();
    await expect(runVega(["linger", SENTINEL_LINGER], { timeoutMs: 10_000 })).resolves.toEqual({
      stdout: "OK-linger",
      stderr: "",
    });
    // Settles around the ~1s drain grace, well under the 10s timeout — proving it does
    // not wait out the timeout (which would also have rejected rather than resolved).
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it("resolves a clean exit whose drain grace outlasts the deadline (does not reject as timeout)", async () => {
    // Regression for the drain-grace-vs-deadline race: the child exits CLEANLY (code 0,
    // output ready) but a grandchild holds the stdout pipe open, so `close` is delayed
    // and the exit falls back to the drain grace (~1s). If the main timeout fires before
    // that grace elapses, settling on it would reject a finished call AS A TIMEOUT —
    // discarding valid output and (worse) classifying `error_kind: "timeout"`, which
    // suppresses listVegaDevices' `device info` recovery and drops a running VVD. With
    // any `timeoutMs` below VEGA_EXIT_DRAIN_GRACE_MS (1000) the deadline is always due
    // before the drain the exit schedules 1s out, so the race is forced. The child having
    // exited makes the wall-clock deadline moot, so it must resolve from the exit/drain
    // with the captured output, not reject. What the value has to clear is the launcher's
    // own startup, since the deadline is armed at the spawn but the drain only at the exit:
    // 32-37ms warmed, rising to 643ms at 4x CPU oversubscription and 700ms at 80-way.
    // One const for both: the assertion below is what proves the deadline fell due before
    // the drain, so raising this past VEGA_EXIT_DRAIN_GRACE_MS has to break it rather than
    // quietly stop forcing the race.
    const NEAR_DEADLINE_MS = 900;
    const start = Date.now();
    await expect(
      runVega(["linger", SENTINEL_LINGER_NEAR_DEADLINE], { timeoutMs: NEAR_DEADLINE_MS })
    ).resolves.toEqual({ stdout: "OK-linger", stderr: "" });
    // Outliving the deadline is the whole point: it proves the timer was DISARMED rather
    // than never reached. Without this the test rests on a source constant it cannot see,
    // and a drain grace shortened below the deadline would settle the call early, leaving
    // it to pass while no longer forcing the race — the drain can only fire at grace ms,
    // so this also holds structurally, never on how fast the launcher started.
    expect(Date.now() - start).toBeGreaterThan(NEAR_DEADLINE_MS);
  });

  it("reaps a pipe-holding worker that stayed in the launcher's process group (drain path)", async () => {
    // The clean-exit drain path with the COMMON pipe-inheritance worker: it inherited our
    // stdout (so `close` is delayed past the launcher's clean exit) but stayed in the
    // launcher's process group. Once the launcher exits, reapVegaGroup's mechanisms can't
    // reach it (ppid sweep → reparented to init; group kill → gated on the launcher being
    // alive), BUT a live group member pins the launcher's pid as a pgid, so a pgid-
    // membership-gated `-pid` group kill is both safe and effective. runVega must resolve
    // with the captured output AND leave NO orphan — proving it doesn't resolve-and-leak on
    // this path. (The detached `linger` worker above escapes into its own group and is the
    // rare genuinely-unreapable case, deliberately not covered by this reap.)
    const DRAIN_DEADLINE_MS = 10_000;
    const run = runVega(["linger-grouped", SENTINEL_LINGER_GROUPED], {
      timeoutMs: DRAIN_DEADLINE_MS,
    }).catch((e: unknown) => e);
    // Same reason as the timeout reap: see the worker alive first, or "no orphan" is a
    // claim about a worker that may never have existed. The window is narrow — the drain
    // grace that ends it leaves ~1.1s — but under load it OPENS late, so the poll spans
    // the whole call: on `waitForCount`'s default a 3.5s launcher start, which the call
    // itself still tolerates, fails the observation of it instead.
    expect(await waitForCount(SENTINEL_LINGER_GROUPED, 1, DRAIN_DEADLINE_MS)).toBe(1);
    expect(await run).toEqual({ stdout: "OK-linger", stderr: "" });
    expect(await waitForClear(SENTINEL_LINGER_GROUPED)).toBe(0);
  });

  it("rejects a non-zero exit as a `subprocess` failure (not `timeout`)", async () => {
    // The common, non-hung failure path (e.g. "device offline"). It must surface the
    // child's stderr AND classify as `subprocess`: a `timeout` classification would
    // wrongly suppress the listVegaDevices `device info` recovery for a healthy VVD.
    const err = await runVega(["fail"], { timeoutMs: 5_000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/device offline/);
    expect(getFailureSignal(err)?.error_kind).toBe("subprocess");
  });

  it("rejects + reaps when output exceeds the cap, classified as `subprocess`", async () => {
    // A runaway child: output past the cap reaps the group and rejects. Like the
    // non-zero exit (and unlike a timeout) it is a misbehaving child, so it must
    // classify as `subprocess` — the killed=true shape would otherwise read as a
    // wedged-agent "timeout". The sentinel sleep it hangs on must be reaped too.
    const err = await runVega(["flood", SENTINEL_OVERFLOW], {
      maxOutputBytes: 100,
      timeoutMs: 5_000,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    // The message prefers the child's captured output (matching execFile's maxBuffer
    // error), so it's the flood, not "output exceeded" — what matters is that it
    // rejected as a misbehaving child, i.e. classified `subprocess` not `timeout`.
    expect(getFailureSignal(err)?.error_kind).toBe("subprocess");
    expect(await waitForClear(SENTINEL_OVERFLOW)).toBe(0);
  });

  it("rejects + reaps when STDERR exceeds the cap, classified as `subprocess`", async () => {
    // The cap is per-stream (like execFile's maxBuffer): a child that floods stderr
    // instead of stdout must trip the same overflow path, not grow stderr unbounded
    // until the timeout — otherwise a misbehaving CLI could exhaust the long-lived
    // tool-server's memory. Classifies `subprocess` (a misbehaving child, not a wedged
    // agent) and the sentinel sleep it hangs on must be reaped too.
    const err = await runVega(["flood-err", SENTINEL_OVERFLOW_ERR], {
      maxOutputBytes: 100,
      timeoutMs: 5_000,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(getFailureSignal(err)?.error_kind).toBe("subprocess");
    expect(await waitForClear(SENTINEL_OVERFLOW_ERR)).toBe(0);
  });
});

describe("sentinel bookkeeping", () => {
  it("keeps the random block a fixed three digits", () => {
    // The other half of the equal-width invariant `SentinelSlot` documents: the slot is a
    // compile error if it widens, but the random block only stays three digits because it
    // is padded. Dropping the padding narrows it 10% of the time — too rare to surface as
    // a failing run, and it hands a shorter-pid run a sweep glob that reaches into ours.
    const widths = new Set(Array.from({ length: 2_000 }, () => randomTagBlock().length));
    expect([...widths]).toEqual([3]);
  });

  it("sees a live worker and sweeps it", async () => {
    // Positive control for every `waitForClear(...)).toBe(0)` above. Those read 0 both
    // when a reap succeeded and when the pattern matches nothing at all — a
    // `cmdlinePattern` that stopped matching the shape `spawn` actually produces, or a
    // host without `pgrep`/`pkill`, where `|| true` makes strayCount return 0 rather
    // than throw. Requiring a count of 1 first makes that failure loud.
    //
    // It also pins sweep(), which is otherwise unasserted: the two `linger` tests'
    // detached workers are documented as unreapable by runVega, so this is the only
    // thing that removes them.
    const worker = spawn("sleep", [SENTINEL_SWEEP], { stdio: "ignore" });
    worker.unref();
    expect(await waitForCount(SENTINEL_SWEEP, 1)).toBe(1);
    sweep();
    expect(await waitForClear(SENTINEL_SWEEP)).toBe(0);
  });

  it("leaves a longer-pid run's sentinel alone", async () => {
    // A run whose pid has one more digit builds sentinels that begin with our entire tag
    // and carry two trailing digits where ours carry one, so a sweep without `$` reaches
    // into its namespace and kills its live workers — which no single-run suite notices.
    // Being that shape, the decoy sits in that run's namespace rather than ours, so
    // afterEach cannot reach it either: hence the kill in `finally`.
    const foreign = `${SENTINEL_PREFIX}12`;
    const decoy = spawn("sleep", [foreign], { stdio: "ignore" });
    try {
      expect(await waitForCount(foreign, 1)).toBe(1);
      sweep();
      // Require that it never clears: a mis-scoped sweep gets the full window to land
      // rather than being declared harmless before the signal arrives.
      expect(await waitForCount(foreign, 0, 500)).toBe(1);
    } finally {
      decoy.kill("SIGKILL");
    }
  });
});
