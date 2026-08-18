import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync, spawn } from "node:child_process";
import { getFailureSignal } from "@argent/registry";
import { runVega, __resetVegaBinaryCacheForTests } from "../src/utils/vega-cli";

// Real-subprocess regression cover for the `list-devices` "hang" + process leak.
// Against a wedged device agent the `vega` CLI forks a launcher → worker tree that
// never returns; a worker holding the stdout pipe kept the old execFile-based call
// pending for the full timeout, and SIGKILLing only the direct child orphaned the
// rest of the tree. runVega now spawns the launcher `detached` (its own process
// group), SIGKILLs the whole group on timeout, AND sweeps any descendant that
// escaped the group — so it settles on its own deadline and leaves no orphans. We
// exercise that with a fake `vega` on PATH (not mocks) so the real spawn / detached
// / group-kill / descendant-sweep path is what runs.
//
// The fake is a node launcher that (a) forks a `detached` `sleep <secs>` worker — its
// OWN process group, so a group-only kill can't reach it (this reproduces the
// setsid'd `dutyfree-vega` worker the group SIGKILL alone would orphan) — which also
// inherits the launcher's stdout (reproducing the pipe-held-open freeze), and (b)
// itself blocks on a same-group `sleep <secs>` so the launcher stays alive long
// enough to be timed out and snapshotted. A complete reap therefore requires BOTH the
// group kill (launcher + its sleep) and the descendant sweep (the detached worker).
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
// ours only if its pid has since been recycled AND the random digits collide (1/900).
//
// It rides in the FRACTION of the sleep duration rather than being the duration: the
// workers only need to outlive the assertions (a few seconds), but a run killed before
// afterAll leaves them behind, so the whole-second part caps that leak at ~ten minutes.
const RUN_TAG = `${process.pid}${Math.floor(Math.random() * 900 + 100)}`;
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
  // The launcher itself also hangs (same group as us) so it stays alive to be timed
  // out and snapshotted; the group SIGKILL reaps this one.
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
});

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
 * Both anchors are load-bearing. `$` confines a run to its own sentinels: they are all
 * `<pid><3 digits><1 digit>` wide (see `sentinel`), and without the tail anchor a run's
 * sweep glob also matches the sentinels of a run whose pid is one digit longer. `^` keeps
 * the `/bin/sh -c "pgrep -f '<pattern>' || true"` wrapper execSync spawns from counting as
 * a stray — the wrapper's own argv carries the pattern text, and Linux's procps excludes
 * only pgrep's own pid, not that parent shell (BSD pgrep excludes its ancestors, so the
 * asymmetry shows up only on Linux). Both also keep a `sleep` from unrelated work on the
 * machine off `pkill`.
 *
 * The sentinel's decimal point is its one ERE metacharacter, so escape it; a `[0-9]`
 * slot glob passes through as the character class it is.
 */
function cmdlinePattern(target: string): string {
  return `^sleep ${target.replaceAll(".", "\\.")}$`;
}

function sweep(): void {
  try {
    execSync(`pkill -f '${cmdlinePattern(`${SENTINEL_PREFIX}[0-9]`)}' || true`);
  } catch {
    /* nothing to clean */
  }
}

function strayCount(sentinel: string): number {
  try {
    const out = execSync(`pgrep -f '${cmdlinePattern(sentinel)}' || true`, {
      encoding: "utf-8",
    });
    return out.split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0;
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

// Poll until this test's workers are gone (reap is a SIGKILL the OS applies
// asynchronously). Returns the final count; a complete reap reaches 0 within a
// moment, whereas an orphaned tree would survive for the full sleep and never clear.
async function waitForClear(sentinel: string, timeoutMs = 3_000): Promise<number> {
  return waitForCount(sentinel, 0, timeoutMs);
}

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
    await expect(runVega(["hang", SENTINEL_REAP], { timeoutMs: 400 })).rejects.toThrow(
      /timed out/i
    );
    // Two sleeps must disappear: the launcher's same-group sleep (reaped by the group
    // SIGKILL) AND the detached worker in its OWN group (reaped only by the descendant
    // sweep). With a group-only kill — or the old single-child kill — the escaped
    // worker would survive its full sleep and this would never reach 0.
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
    // `timeoutMs` (600) below VEGA_EXIT_DRAIN_GRACE_MS (1000) the exit-at-~0ms schedules
    // its drain ~1s out while the deadline is only 600ms away, so the race is forced
    // deterministically. The child having exited makes the wall-clock deadline moot, so
    // it must resolve from the exit/drain with the captured output, not reject.
    await expect(
      runVega(["linger", SENTINEL_LINGER_NEAR_DEADLINE], { timeoutMs: 600 })
    ).resolves.toEqual({ stdout: "OK-linger", stderr: "" });
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
    await expect(
      runVega(["linger-grouped", SENTINEL_LINGER_GROUPED], { timeoutMs: 10_000 })
    ).resolves.toEqual({ stdout: "OK-linger", stderr: "" });
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
  it("sees a live worker and sweeps it", async () => {
    // Positive control for every `waitForClear(...)).toBe(0)` above. Those read 0 both
    // when a reap succeeded and when the pattern matches nothing at all, so a sentinel
    // whose escaping broke — or a host without `pgrep`/`pkill`, where `|| true` makes
    // strayCount return 0 rather than throw — would turn all of them vacuously green.
    // Requiring a count of 1 first makes that failure loud.
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
});
