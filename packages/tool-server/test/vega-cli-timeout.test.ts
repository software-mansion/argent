import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
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
// another's. Sentinels share the `6910x` range so afterEach can sweep them all with
// a single tight pattern (see sweep()).
const SENTINEL_DEADLINE = "69101";
const SENTINEL_REAP = "69102";
const SENTINEL_OVERFLOW = "69103";
const SENTINEL_LINGER = "69104";
const SENTINEL_OVERFLOW_ERR = "69105";
const SENTINEL_LINGER_NEAR_DEADLINE = "69106";
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

function sweep(): void {
  try {
    // Match only this suite's sentinels (6910[0-9]) rather than a loose `sleep 691`
    // substring, so a stray `sleep` from unrelated work on the machine is never killed.
    // Anchored to the whole command line (`^…$`) for the same reason as strayCount: an
    // unanchored `-f` pattern would also match the wrapper shell execSync spawns to run
    // it (whose argv contains the literal pattern). The real sleeps' cmdline is exactly
    // `sleep 6910<n>`.
    execSync(`pkill -f '^sleep 6910[0-9]$' || true`);
  } catch {
    /* nothing to clean */
  }
}

function strayCount(sentinel: string): number {
  try {
    // Anchor the pattern to the WHOLE command line (`^sleep <sentinel>$`). With a bare
    // `sleep <sentinel>` substring, Linux's procps `pgrep -f` also matches the wrapper
    // shell `/bin/sh -c "pgrep -f 'sleep <sentinel>' || true"` that execSync spawns —
    // its own argv contains the literal `sleep <sentinel>`, and pgrep excludes only its
    // own pid, not that parent shell — so a clean reap still reported 1 phantom stray
    // and every waitForClear assertion failed on CI. (macOS's BSD pgrep doesn't match
    // the wrapper, which is why it only bit Linux.) The anchors restrict the match to a
    // real `sleep <sentinel>` process, whose full cmdline is exactly that.
    const out = execSync(`pgrep -f '^sleep ${sentinel}$' || true`, { encoding: "utf-8" });
    return out.split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

// Poll until this test's workers are gone (reap is a SIGKILL the OS applies
// asynchronously). Returns the final count; a complete reap reaches 0 within a
// moment, whereas an orphaned tree would survive for the full sleep and never clear.
async function waitForClear(sentinel: string, timeoutMs = 3_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let count = strayCount(sentinel);
  while (count > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    count = strayCount(sentinel);
  }
  return count;
}

describe("runVega timeout (real subprocess)", () => {
  it("rejects on its own deadline when the CLI never returns", async () => {
    const start = Date.now();
    await expect(runVega(["hang", SENTINEL_DEADLINE], { timeoutMs: 400 })).rejects.toThrow(
      /timed out/i
    );
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
