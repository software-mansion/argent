import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAILURE_COMMANDS, getFailureSignal } from "@argent/registry";
import { runHdc } from "../src/utils/harmony-hdc";

// A real stub via `$DEVECO_STUDIO_HOME`, so a host's own DevEco `hdc` is never run.
const root = mkdtempSync(join(tmpdir(), "argent-deveco-"));
const binDir = join(root, "sdk", "default", "openharmony", "toolchains");
mkdirSync(binDir, { recursive: true });
// A wedged `hdc`, deaf to SIGTERM; `exec` so the timeout kills the sleeper itself.
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
    // `execFile` sends `killSignal` once and never escalates.
    const started = Date.now();

    // An instant HARMONY_HDC_NOT_FOUND would also reject, so the message is pinned.
    const err = await runHdc(["list", "targets"], 800).then(
      () => {
        throw new Error("expected a rejection, got a resolution");
      },
      (e: unknown) => e as Error
    );

    const elapsed = Date.now() - started;
    expect(err.message).not.toMatch(/not found|not installed/i);
    expect(elapsed).toBeGreaterThanOrEqual(700); // the 800ms timeout, less timer slack
    expect(elapsed).toBeLessThan(6_000);

    // The telemetry sanitiser drops a `failure_command` not in its list.
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
