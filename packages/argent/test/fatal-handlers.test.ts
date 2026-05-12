import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as esbuild from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Compile src/fatal-handlers.ts to a tmp .mjs once before all tests so the
// spawned child node processes can `import` it without depending on a prior
// `npm run build` step. Self-contained: no dist/ build dependency.
let handlerUrl = "";
let tmpDir = "";

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-fatal-handlers-"));
  const srcPath = path.resolve(import.meta.dirname, "../src/fatal-handlers.ts");
  const out = await esbuild.transform(fs.readFileSync(srcPath, "utf8"), {
    loader: "ts",
    format: "esm",
    target: "node20",
  });
  const handlerPath = path.join(tmpDir, "fatal-handlers.mjs");
  fs.writeFileSync(handlerPath, out.code);
  handlerUrl = JSON.stringify(`file://${handlerPath}`);
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

function runChild(scriptBody: string, timeoutMs = 3_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    // Override HOME (and USERPROFILE for Windows) so fatal-log breadcrumbs go
    // under the test tmpdir, not the developer's real ~/.argent.
    const child = spawn(process.execPath, ["--input-type=module", "-e", scriptBody], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: tmpDir, USERPROFILE: tmpDir },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    const killer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(`child still running after ${timeoutMs}ms — fix is broken; output: ${stderr}`)
      );
    }, timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(killer);
      resolve({
        exitCode: code,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - start,
      });
    });
    child.on("error", (err) => {
      clearTimeout(killer);
      reject(err);
    });
  });
}

describe("installFatalHandlers", () => {
  it("exits cleanly when stderr is broken (the orphaned-process loop scenario)", async () => {
    // Reproduces the production bug: an orphaned MCP process whose stderr
    // pipe broke entered an exception loop. Each stderr.write emitted an
    // async 'error' event, which without a listener became another
    // uncaughtException, calling the handler again, ...
    const script = `
      import { installFatalHandlers } from ${handlerUrl};
      const origWrite = process.stderr.write.bind(process.stderr);
      let writes = 0;
      process.stderr.write = (chunk, ...rest) => {
        writes++;
        if (writes > 50) {
          // Hardstop: if we get here the fix is broken.
          process._rawDebug("LOOP NOT FIXED writes=" + writes);
          process.exit(99);
        }
        // Synthesize the broken-pipe behavior: every write emits an async error.
        setImmediate(() => process.stderr.emit("error", new Error("synthetic EPIPE")));
        return true;
      };
      installFatalHandlers({ isMcpServer: true });
      throw new Error("initial boom");
    `;
    const result = await runChild(script);
    expect(result.exitCode).toBe(1);
    expect(result.durationMs).toBeLessThan(2_000);
    const fatalLog = fs.readFileSync(path.join(tmpDir, ".argent", "mcp-fatal.log"), "utf8");
    expect(fatalLog).toMatch(/Broken (stdout|stderr)|synthetic EPIPE|initial boom/);
    expect(fatalLog).toContain("pid=");
  });

  it("exits with code 1 in non-mcp mode on uncaught exception", async () => {
    const script = `
      import { installFatalHandlers } from ${handlerUrl};
      installFatalHandlers({ isMcpServer: false });
      throw new Error("boom");
    `;
    const result = await runChild(script);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[argent] Uncaught exception");
    expect(result.stderr).toContain("boom");
  });

  it("does NOT exit in mcp mode when stderr works (transient errors stay non-fatal)", async () => {
    // Regression guard: the bug fix must not change the existing "MCP server
    // keeps running on uncaught exceptions" semantics. After throwing once,
    // the process should still be alive and able to do work.
    const script = `
      import { installFatalHandlers } from ${handlerUrl};
      installFatalHandlers({ isMcpServer: true });
      process.nextTick(() => { throw new Error("transient"); });
      setTimeout(() => {
        process.stdout.write("STILL_ALIVE");
        process.exit(0);
      }, 200);
    `;
    const result = await runChild(script);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("STILL_ALIVE");
    expect(result.stderr).toContain("[argent] Uncaught exception");
    expect(result.stderr).toContain("transient");
  });

  it("formats unhandled rejections", async () => {
    const script = `
      import { installFatalHandlers } from ${handlerUrl};
      installFatalHandlers({ isMcpServer: false });
      Promise.reject(new Error("rejected-thing"));
    `;
    const result = await runChild(script);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[argent] Unhandled rejection");
    expect(result.stderr).toContain("rejected-thing");
  });

  it("survives errors thrown from inside the stack-formatter (defaultPrepareStackTrace)", async () => {
    // Real production trace showed time spent in defaultPrepareStackTrace,
    // suggesting the original error's .stack getter was throwing. The fix
    // wraps the formatter in a try/catch so a failing .stack does not start
    // the loop.
    const script = `
      import { installFatalHandlers } from ${handlerUrl};
      installFatalHandlers({ isMcpServer: false });
      const err = new Error("boom");
      Object.defineProperty(err, "stack", { get() { throw new Error("stack-getter-blew-up"); } });
      throw err;
    `;
    const result = await runChild(script);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[argent] Uncaught exception");
  });
});
