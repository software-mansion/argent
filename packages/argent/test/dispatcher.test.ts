import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// End-to-end tests for the `argent-simulator-server` dispatcher (`packages/
// argent/scripts/argent-simulator-server.cjs`). The dispatcher resolves
// `<__dirname>/<process.platform>/simulator-server` and execs it; verifying
// that behavior requires a real child process, so each test stages a tmpdir
// with the dispatcher copied in and a fake simulator-server placed at the
// expected per-platform subpath.

const DISPATCHER_SRC = path.resolve(import.meta.dirname, "../scripts/argent-simulator-server.cjs");

let tmpRoot = "";
const sessionTmpDirs: string[] = [];

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argent-dispatcher-"));
});

afterAll(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  // Cleanup between cases keeps tmpdirs bounded if the suite grows.
  while (sessionTmpDirs.length > 0) {
    const d = sessionTmpDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

// Mirrors the dispatcher's host platform key: process.platform, except
// "linux-arm64" on arm64 Linux. Keeps the suite green on every host the
// dispatcher itself supports.
const HOST_PLATFORM_KEY =
  process.platform === "linux" && process.arch === "arm64" ? "linux-arm64" : process.platform;

/**
 * Stage a tmp dispatcher dir. Returns the path to the copied dispatcher .cjs
 * (suitable to pass to `node`) and the per-platform bin dir where the caller
 * should drop a fake simulator-server.
 */
function stageDispatcher(platformKey: string = HOST_PLATFORM_KEY): {
  dispatcher: string;
  platformDir: string;
} {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "case-"));
  sessionTmpDirs.push(dir);
  const dispatcher = path.join(dir, "argent-simulator-server.cjs");
  fs.copyFileSync(DISPATCHER_SRC, dispatcher);
  const platformDir = path.join(dir, platformKey);
  fs.mkdirSync(platformDir, { recursive: true });
  return { dispatcher, platformDir };
}

/**
 * Write an executable POSIX shell script as the fake simulator-server. The
 * dispatcher exec's whatever file lives at the resolved path — a shell script
 * with `#!/usr/bin/env bash` works on darwin and linux runners and lets each
 * test control exit code, stdout/stderr, and signal behavior with one literal.
 */
function writeFakeBinary(platformDir: string, body: string): string {
  const p = path.join(platformDir, "simulator-server");
  fs.writeFileSync(p, body, { mode: 0o755 });
  return p;
}

interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runDispatcher(
  dispatcher: string,
  args: string[] = [],
  opts: { signalAfterMs?: number; signal?: NodeJS.Signals } = {}
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [dispatcher, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ exitCode: code, signal, stdout, stderr }));
    if (opts.signalAfterMs && opts.signal) {
      setTimeout(() => {
        try {
          child.kill(opts.signal);
        } catch {
          // child already exited
        }
      }, opts.signalAfterMs);
    }
  });
}

describe("argent-simulator-server dispatcher", () => {
  it("exits 1 with a helpful message when no per-platform binary exists", async () => {
    // Stage the dispatcher but leave the <platform>/ dir empty — the resolved
    // path won't exist and the dispatcher should bail out with a clear error
    // naming the platform and the path it tried, rather than letting `exec`
    // bubble up an ENOENT.
    const { dispatcher } = stageDispatcher();
    const result = await runDispatcher(dispatcher);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("argent-simulator-server: no binary");
    expect(result.stderr).toContain(process.platform);
    expect(result.stderr).toContain("Supported hosts today: darwin, linux");
  });

  it("resolves the linux-arm64 binary when running on arm64 Linux", async () => {
    // The dispatcher reads process.platform / process.arch at require time,
    // so the test fakes both inside a child process (via `node -e`) before
    // requiring the dispatcher — exercising the real resolution logic on any
    // host. The fake binary is a bash script, so executing it works even
    // though the staged directory is named for a different platform.
    const { dispatcher, platformDir } = stageDispatcher("linux-arm64");
    writeFakeBinary(platformDir, "#!/usr/bin/env bash\necho arm64-ok\nexit 0\n");
    const stub =
      'Object.defineProperty(process, "platform", { value: "linux" });' +
      'Object.defineProperty(process, "arch", { value: "arm64" });' +
      "require(process.argv[1]);";
    const result = await new Promise<RunResult>((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", stub, dispatcher], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c.toString()));
      child.stderr.on("data", (c) => (stderr += c.toString()));
      child.on("error", reject);
      child.on("exit", (code, signal) => resolve({ exitCode: code, signal, stdout, stderr }));
    });
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("arm64-ok");
    expect(result.exitCode).toBe(0);
  });

  it("propagates the child's exit code on a clean exit", async () => {
    // Fake binary exits 0 — dispatcher must mirror that exactly. A
    // `process.exit(code ?? 1)` regression that defaults 0→1 would surface
    // here.
    const { dispatcher, platformDir } = stageDispatcher();
    writeFakeBinary(platformDir, "#!/usr/bin/env bash\nexit 0\n");
    const result = await runDispatcher(dispatcher);
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
  });

  it("propagates a non-zero child exit code", async () => {
    const { dispatcher, platformDir } = stageDispatcher();
    writeFakeBinary(platformDir, "#!/usr/bin/env bash\nexit 42\n");
    const result = await runDispatcher(dispatcher);
    expect(result.exitCode).toBe(42);
  });

  it("passes argv through to the child unchanged", async () => {
    // The child echoes its argv as JSON; the dispatcher must hand over
    // `process.argv.slice(2)` verbatim (no quoting, no extra args).
    const { dispatcher, platformDir } = stageDispatcher();
    // argv layout for a shebang-launched node script: [node, script, ...args].
    // slice(2) drops both the node executable and the script path, leaving
    // exactly the arguments the dispatcher passed through.
    writeFakeBinary(
      platformDir,
      `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`
    );
    const result = await runDispatcher(dispatcher, ["--flag", "value with spaces", "tail"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["--flag", "value with spaces", "tail"]);
  });

  it("forwards SIGTERM to the child binary", async () => {
    // The regression this guards against: a supervisor (systemd / container
    // stop / `kill -TERM <dispatcher_pid>`) signals only the dispatcher PID;
    // without explicit `process.on("SIGTERM")` mirroring the child stays
    // running as an orphan reparented to init. The fake binary installs a
    // SIGTERM handler that exits 99 so the test can read the signal back
    // through the exit code.
    const { dispatcher, platformDir } = stageDispatcher();
    writeFakeBinary(
      platformDir,
      "#!/usr/bin/env bash\ntrap 'exit 99' TERM\n# Wait long enough for the test to send the signal.\nsleep 5 &\nwait $!\n"
    );
    const result = await runDispatcher(dispatcher, [], {
      signalAfterMs: 250,
      signal: "SIGTERM",
    });
    expect(result.exitCode).toBe(99);
  });
});
