import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { traceProcessorShellPath } from "../src/index";
import { TraceProcessorUnavailableError } from "../src/errors";

// The resolver reads these env vars; snapshot & restore so tests don't leak.
const ENV_KEYS = [
  "ARGENT_TRACE_PROCESSOR_PATH",
  "ARGENT_NATIVE_DEVTOOLS_ANDROID_BIN_DIR",
];

describe("traceProcessorShellPath — env overrides (step 1 & 2)", () => {
  let saved: Record<string, string | undefined>;
  let tmpDir: string;

  beforeEach(async () => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tp-resolver-"));
  });

  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns ARGENT_TRACE_PROCESSOR_PATH when it points at an executable file", async () => {
    const bin = path.join(tmpDir, "trace_processor_shell");
    await fsp.writeFile(bin, "#!/bin/sh\n", { mode: 0o755 });
    process.env.ARGENT_TRACE_PROCESSOR_PATH = bin;

    expect(traceProcessorShellPath()).toBe(bin);
  });

  it("throws env_path_invalid when ARGENT_TRACE_PROCESSOR_PATH is bogus", () => {
    process.env.ARGENT_TRACE_PROCESSOR_PATH = path.join(tmpDir, "does-not-exist");
    try {
      traceProcessorShellPath();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TraceProcessorUnavailableError);
      expect((err as TraceProcessorUnavailableError).kind).toBe("env_path_invalid");
    }
  });

  it("uses ARGENT_NATIVE_DEVTOOLS_ANDROID_BIN_DIR/trace_processor_shell when present", async () => {
    const bin = path.join(tmpDir, "trace_processor_shell");
    await fsp.writeFile(bin, "binary", { mode: 0o755 });
    process.env.ARGENT_NATIVE_DEVTOOLS_ANDROID_BIN_DIR = tmpDir;

    expect(traceProcessorShellPath()).toBe(bin);
  });
});
