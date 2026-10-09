import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAILURE_COMMANDS, getFailureSignal } from "@argent/registry";
import { runHdc } from "../src/utils/harmony-hdc";

// Resolve `hdc` through the documented `$DEVECO_STUDIO_HOME` layout rather than
// PATH: pointing the resolver at a real stub is hermetic, where stubbing the
// PATH lookup alone still lets a host with DevEco Studio installed find and run
// the real `hdc`.
const root = mkdtempSync(join(tmpdir(), "argent-deveco-"));
const binDir = join(root, "sdk", "default", "openharmony", "toolchains");
mkdirSync(binDir, { recursive: true });
// A wedged `hdc`: blocked on an unresponsive daemon and deaf to SIGTERM. `exec`
// so the process that ignores the signal IS the one the timeout kills - without
// it the shell dies and leaves the `sleep` orphaned for its full duration.
writeFileSync(join(binDir, "hdc"), "#!/usr/bin/env bash\ntrap '' TERM\nexec sleep 30\n", {
  mode: 0o755,
});

beforeAll(() => vi.stubEnv("DEVECO_STUDIO_HOME", root));
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("runHdc timeout enforcement", () => {
  it("reaps a child that ignores SIGTERM, so the timeout it was given actually fires", async () => {
    // `execFile`'s `timeout` sends `killSignal` once and never escalates, so with
    // the default SIGTERM this call never settles and every per-call budget on
    // the HarmonyOS path is advisory - only `list-devices` has a deadline behind
    // it, and the interaction tools have nothing. Measured against this stub
    // without `killSignal`: still running 6s after a 1s timeout.
    const started = Date.now();

    // The rejection must name the TIMEOUT, not the dependency: an instant
    // `HARMONY_HDC_NOT_FOUND` also satisfies `rejects.toThrow()` and the <6s
    // bound while never having spawned the wedged child at all — so the error
    // text is pinned to the kill, and the lower bound to the timeout having
    // actually been waited out.
    const err = await runHdc(["list", "targets"], 800).then(
      () => {
        throw new Error("expected a rejection, got a resolution");
      },
      (e: unknown) => e as Error
    );

    const elapsed = Date.now() - started;
    expect(err.message).not.toMatch(/not found|not installed/i);
    expect(elapsed).toBeGreaterThanOrEqual(700); // the 800ms timeout, less timer slack
    // Far below the stub's own 30s sleep: the assertion is that the deadline is
    // enforced at all, not its precise latency on a loaded CI box.
    expect(elapsed).toBeLessThan(6_000);

    // Named binary, as every other platform's subprocess failures are — `adb`,
    // `vega`, `xcrun_simctl`. Membership is asserted alongside the value because
    // it is what decides whether the value is ever reported: the telemetry
    // sanitiser validates `failure_command` against this list and silently drops
    // a spelling it does not carry, which would file every `hdc` failure under
    // no binary at all.
    // The kind and the signal come off the child the same way `adb`'s wrapper
    // reads them, so a wedged daemon is counted as a timeout rather than as a
    // command that ran and failed.
    const signal = getFailureSignal(err);
    expect(signal).toMatchObject({
      failure_command: "hdc",
      failure_stage: "harmony_hdc_run",
      error_kind: "timeout",
      failure_signal: "SIGKILL",
    });
    expect(FAILURE_COMMANDS).toContain(signal?.failure_command);
  }, 20_000);
});
