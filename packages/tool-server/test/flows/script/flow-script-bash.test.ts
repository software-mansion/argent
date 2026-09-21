import { fork, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  exchangeDirPrefix,
  FlowScriptExecutor,
  type FlowScriptExecutorOptions,
  type FlowScriptRequest,
  type FlowScriptResult,
  SCRIPT_STEP_LOG_LIMIT_BYTES,
} from "../../../src/tools/flows/script/flow-script-executor";
import { SCRIPT_MAX_OUTPUT_BYTES } from "../../../src/tools/flows/script/flow-script-protocol";
import {
  createScriptWorkspace,
  SOURCE_RUNNER_DIR,
  type ScriptWorkspace,
} from "../../helpers/flow-script-workspace";
import { resolveHostBash } from "../../helpers/host-bash";

/**
 * Every case below runs a real bash. Resolved in `beforeAll` and applied per
 * test, because the resolver is async and `describe.skipIf` is decided while
 * the file is collected. See {@link hostBashProblem} for what a missing bash
 * means here, and what it means on CI.
 */
let noBash: string | undefined;

let hostBash: string;

let exchangeRoot: string;

beforeAll(async () => {
  exchangeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argent-bash-exchange-"));
  const found = await resolveHostBash();
  if ("path" in found) hostBash = found.path;
  else noBash = found.problem;
});

afterAll(() => fs.rmSync(exchangeRoot, { recursive: true, force: true }));

beforeEach((ctx) => {
  if (noBash) ctx.skip(`this host has no bash to run a .sh step with: ${noBash}`);
});

const workspaces: ScriptWorkspace[] = [];

function workspace(): ScriptWorkspace {
  const ws = createScriptWorkspace("bash");
  workspaces.push(ws);
  return ws;
}

async function withGlobalBash<T>(value: string, body: () => Promise<T>): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "argent-bash-home-"));
  const real = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  fs.mkdirSync(path.join(home, ".argent"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".argent", "config.json"),
    JSON.stringify({ scripts: { bash: value } })
  );
  try {
    return await body();
  } finally {
    for (const [name, previous] of Object.entries(real)) {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/**
 * A home holding an empty configuration, and `dir` first on the tool server's
 * own PATH — the two things the bash SEARCH path needs to be the one taken. A
 * developer who pinned a bash globally would otherwise never reach it, and the
 * search reads `process.env.PATH` through `commandOnPath` rather than the
 * step's environment.
 */
async function withSearchPath<T>(dir: string, body: () => Promise<T>, document = "{}"): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "argent-bash-search-"));
  const real = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    PATH: process.env.PATH,
  };
  fs.mkdirSync(path.join(home, ".argent"), { recursive: true });
  fs.writeFileSync(path.join(home, ".argent", "config.json"), document);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PATH = `${dir}${path.delimiter}${real.PATH ?? ""}`;
  try {
    return await body();
  } finally {
    for (const [name, previous] of Object.entries(real)) {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const strays: number[] = [];

afterEach(() => {
  while (strays.length) {
    try {
      process.kill(strays.pop()!, "SIGKILL");
    } catch {}
  }
  while (workspaces.length) workspaces.pop()!.cleanup();
});

function executor(options: FlowScriptExecutorOptions = {}): FlowScriptExecutor {
  return new FlowScriptExecutor({
    concurrency: 4,
    maxTimeoutMs: 60_000,
    exchangeRoot,
    ...options,
  });
}

function runBash(
  ws: ScriptWorkspace,
  name: string,
  source: string,
  extras: Partial<FlowScriptRequest> = {},
  options: FlowScriptExecutorOptions = {}
): Promise<FlowScriptResult> {
  const script = ws.write(`${name}.sh`, source);
  return executor(options).execute({
    scriptPath: script,
    interpreter: "bash",
    projectRoot: ws.dir,
    ...extras,
  });
}

const onPosix = it.skipIf(process.platform === "win32");

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A background job that writes its own pid, for a case that asks the operating
 * system whether a descendant is still alive. Under Git Bash `$!` is an MSYS
 * number rather than one `process.kill` can ask Windows about, and a small one
 * can belong to an unrelated Windows process - so a `sleep`'s `$!` read as dead,
 * or as alive, by chance there.
 */
function backgroundJob(pidFile: string): string {
  const node = JSON.stringify(process.execPath.replace(/\\/g, "/"));
  const file = JSON.stringify(pidFile.replace(/\\/g, "/"));
  return `${node} -e 'require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);' ${file} &`;
}

async function waitForExit(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await delay(50);
  }
  return false;
}

async function readPidFile(
  file: string,
  timeoutMs = 20_000,
  driverStderr?: () => string
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = fs.readFileSync(file, "utf8").trim();
      if (raw) return Number(raw);
    } catch {}
    await delay(50);
  }
  const said = driverStderr?.() ?? "";
  throw new Error(`No pid appeared in ${file}${said ? `; the driver said: ${said}` : ""}`);
}

function exchangeDirs(): string[] {
  return fs.readdirSync(exchangeRoot).filter((entry) => entry.startsWith(exchangeDirPrefix()));
}

const BASH_SOURCE = "${BASH_SOURCE[0]}";

describe("a bash step that passes", () => {
  it("returns the document the script wrote, and what it printed as the log", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "seed",
      `set -euo pipefail
       echo "seeding order"
       echo "a warning" >&2
       printf '{"order":{"id":"ord_1","total":42}}' > "$ARGENT_OUTPUT"`
    );

    expect(result.failure).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ order: { id: "ord_1", total: 42 } });
    expect(result.durationMs).toBeGreaterThan(0);
    // Both streams, as a `.mjs` step's are. Not their order: two writes this
    // close together can reach the parent in either order across two pipes.
    expect(result.log).toContain("seeding order\n");
    expect(result.log).toContain("a warning\n");
    expect(result.logTruncated).toBe(false);
  }, 30_000);

  it("returns the document it was given when the script never touches the file", async () => {
    const ws = workspace();
    const result = await runBash(ws, "quiet", `echo hello`, { output: { given: 41 } });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ given: 41 });
  }, 30_000);

  it("hands the script the flow's own document to read", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "read-given",
      `set -euo pipefail
       cp "$ARGENT_OUTPUT" "$ARGENT_OUTPUT.new"
       mv "$ARGENT_OUTPUT.new" "$ARGENT_OUTPUT"`,
      { output: { given: 41 } }
    );
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ given: 41 });
  }, 30_000);

  it("takes one queue slot per step, whichever language runs", async () => {
    const ws = workspace();
    const shared = executor({ concurrency: 1 });
    const log = ws.resolve("slot.log");
    const sh = ws.write(
      "slot.sh",
      `printf 'sh-in\\n' >> ${JSON.stringify(log)}
       sleep 1
       printf 'sh-out\\n' >> ${JSON.stringify(log)}
       printf '{"sh":true}' > "$ARGENT_OUTPUT"`
    );
    const mjs = ws.write(
      "slot.mjs",
      `import fs from "node:fs";\n` +
        `fs.appendFileSync(${JSON.stringify(log)}, "mjs-in\\n");\n` +
        `await new Promise((r) => setTimeout(r, 1000));\n` +
        `fs.appendFileSync(${JSON.stringify(log)}, "mjs-out\\n");\n` +
        `output.mjs = true;`
    );
    const [first, second] = await Promise.all([
      shared.execute({ scriptPath: sh, interpreter: "bash", projectRoot: ws.dir }),
      shared.execute({ scriptPath: mjs, projectRoot: ws.dir }),
    ]);

    expect(first.output).toEqual({ sh: true });
    expect(second.output).toEqual({ mjs: true });
    const order = fs.readFileSync(log, "utf8").trim().split(/\n+/);
    expect([
      ["sh-in", "sh-out", "mjs-in", "mjs-out"],
      ["mjs-in", "mjs-out", "sh-in", "sh-out"],
    ]).toContainEqual(order);
    expect(shared.activeCount).toBe(0);
  }, 60_000);
});

describe("the document a bash step returns", () => {
  it("refuses a document the script removed", async () => {
    const ws = workspace();
    const result = await runBash(ws, "removed", `rm "$ARGENT_OUTPUT"`);
    expect(result.failure?.kind).toBe("output");
    expect(result.failure?.message).toContain("$ARGENT_OUTPUT is gone");
  }, 30_000);

  it("refuses an empty document, naming the idiom that avoids one", async () => {
    const ws = workspace();
    const result = await runBash(ws, "emptied", `> "$ARGENT_OUTPUT"`);
    expect(result.failure?.kind).toBe("output");
    expect(result.failure?.message).toContain("empty");
    expect(result.failure?.message).toContain("mv");
  }, 30_000);

  it("refuses a document that is not a JSON object, saying which it was", async () => {
    const ws = workspace();
    for (const [name, written, says] of [
      ["array", "[1,2]", "was not an object"],
      ["string", '"done"', "was not an object"],
      ["garbage", "not json", "did not parse"],
    ] as const) {
      const result = await runBash(
        ws,
        name,
        `printf '%s' ${JSON.stringify(written)} > "$ARGENT_OUTPUT"`
      );
      expect(result.failure?.kind, written).toBe("output");
      expect(result.failure?.message, written).toContain(says);
    }
  }, 60_000);

  it("says a document did not parse without quoting the document", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "unquoted-parse-failure",
      `printf '%s' '{"auth":s3cr3t-token-value}' > "$ARGENT_OUTPUT"`
    );

    expect(result.failure?.kind).toBe("output");
    expect(result.failure?.message).toContain("did not parse");
    expect(result.failure?.message).toContain("Unexpected token");
    expect(result.failure?.message).not.toContain("s3cr3t");
    expect(result.failure?.message).not.toContain('"');
  }, 30_000);

  onPosix(
    "refuses a document the runner may not read, naming why",
    async () => {
      const ws = workspace();
      const result = await runBash(
        ws,
        "unreadable",
        `printf '{"real":true}' > "$ARGENT_OUTPUT"
       chmod 000 "$ARGENT_OUTPUT"`
      );

      expect(result.failure?.kind).toBe("output");
      expect(result.failure?.message).toContain("$ARGENT_OUTPUT could not be read");
      expect(result.failure?.message).toContain("EACCES");
    },
    30_000
  );

  it("refuses an own __proto__ key, as it does from a .mjs", async () => {
    const ws = workspace();
    const result = await runBash(ws, "proto", `printf '{"__proto__":{"x":1}}' > "$ARGENT_OUTPUT"`);
    expect(result.failure?.kind).toBe("output");
    expect(result.failure?.message).toContain("__proto__");
  }, 30_000);

  it("refuses a number JSON can spell and JavaScript cannot hold", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "infinite",
      `printf '%s' '{"n":1e999,"neg":-1e999}' > "$ARGENT_OUTPUT.n"
     mv "$ARGENT_OUTPUT.n" "$ARGENT_OUTPUT"`
    );
    expect(result.failure?.kind).toBe("output");
    expect(result.failure?.message).toContain("output.n is Infinity");
    expect(result.failure?.message).toContain("must be finite");
  }, 30_000);

  it("refuses a document nested past the depth a later step can encode", async () => {
    const ws = workspace();
    const deep = ws.write("deep.json", `${'{"a":'.repeat(5_000)}1${"}".repeat(5_000)}`);
    const result = await runBash(
      ws,
      "deep",
      `cp ${JSON.stringify(deep)} "$ARGENT_OUTPUT.n"
     mv "$ARGENT_OUTPUT.n" "$ARGENT_OUTPUT"`
    );
    expect(result.failure?.kind).toBe("output");
    expect(result.failure?.message).toContain("nests deeper than");
    expect(result.failure!.message.length).toBeLessThan(200);
  }, 30_000);

  it("takes a document nested deeply enough for any author", async () => {
    const ws = workspace();
    const deep = ws.write("ok.json", `${'{"a":'.repeat(3_000)}1${"}".repeat(3_000)}`);
    const result = await runBash(
      ws,
      "deep-ok",
      `cp ${JSON.stringify(deep)} "$ARGENT_OUTPUT.n"
     mv "$ARGENT_OUTPUT.n" "$ARGENT_OUTPUT"`
    );
    expect(result.failure).toBeUndefined();
    expect(result.ok).toBe(true);
  }, 30_000);

  it("refuses a document that is not valid UTF-8 rather than rewriting it", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "bad-utf8",
      `printf '{"token":"\\xc3\\x28abc"}' > "$ARGENT_OUTPUT.t"
       mv "$ARGENT_OUTPUT.t" "$ARGENT_OUTPUT"`
    );

    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe("output");
    expect(result.failure?.message).toContain("not valid UTF-8");
  }, 30_000);

  it("refuses a document over the limit only by its own replacement characters", async () => {
    const ws = workspace();
    const padding = SCRIPT_MAX_OUTPUT_BYTES - 10;
    const result = await runBash(
      ws,
      "at-limit-invalid",
      `set -euo pipefail
       printf '{"big":"' > "$ARGENT_OUTPUT.t"
       head -c ${padding} /dev/zero | LC_ALL=C tr '\\0' '\\377' >> "$ARGENT_OUTPUT.t"
       printf '"}' >> "$ARGENT_OUTPUT.t"
       mv "$ARGENT_OUTPUT.t" "$ARGENT_OUTPUT"`
    );

    expect(result.failure?.kind).toBe("output");
    expect(result.failure?.message).toContain("not valid UTF-8");
    expect(result.failure?.message).not.toContain("limit");
  }, 60_000);

  it("takes a document of exactly the limit and refuses one byte more", async () => {
    const ws = workspace();
    const padding = (bytes: number) =>
      `set -euo pipefail
       printf '{"big":"' > "$ARGENT_OUTPUT.t"
       head -c ${bytes} /dev/zero | tr '\\0' 'z' >> "$ARGENT_OUTPUT.t"
       printf '"}' >> "$ARGENT_OUTPUT.t"
       mv "$ARGENT_OUTPUT.t" "$ARGENT_OUTPUT"`;
    const exact = await runBash(ws, "at-limit", padding(SCRIPT_MAX_OUTPUT_BYTES - 10));
    const over = await runBash(ws, "over-limit", padding(SCRIPT_MAX_OUTPUT_BYTES - 9));

    expect(exact.failure).toBeUndefined();
    expect((exact.output?.big as string).length).toBe(SCRIPT_MAX_OUTPUT_BYTES - 10);
    expect(over.failure?.kind).toBe("output");
    expect(over.failure?.message).toContain("limit");
  }, 60_000);

  // `open` on a named pipe with no writer blocks on the runner's own thread,
  // inside the exit handler, where the runner holds SIGTERM — so the parent's
  // graceful stop could not reach it either and the whole stop grace was spent
  // before the SIGKILL. A script that failed in ten milliseconds was reported
  // as having spent its entire time limit.
  //
  // The pipe is a POSIX case: Git Bash's `mkfifo` makes a Cygwin FIFO that Node
  // sees as no file at all, so there the step reports the document gone.
  it.each([
    ...(process.platform === "win32" ? [] : [["a named pipe", `mkfifo "$ARGENT_OUTPUT"`]]),
    ["a directory", `mkdir "$ARGENT_OUTPUT"`],
  ])(
    "refuses %s in the place of the document, at once",
    async (kind, make) => {
      const ws = workspace();
      const startedAt = Date.now();
      const result = await runBash(ws, "irregular", `rm -f "$ARGENT_OUTPUT"\n       ${make}`, {
        timeoutMs: 3_000,
      });

      expect(result.failure?.kind).toBe("output");
      expect(result.failure?.message).toContain(`${kind} rather than a regular file`);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
    },
    30_000
  );

  it("does not read the document of a non-zero exit", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "wrote-then-failed",
      `printf '{"order":{"id":"ord_1"}}' > "$ARGENT_OUTPUT"
       exit 1`
    );
    expect(result.ok).toBe(false);
    expect(result.output).toBeUndefined();
    expect(result.failure?.kind).toBe("exit");
  }, 30_000);
});

describe("what a failing bash step says", () => {
  it("names the exit code and the interpreter that ran it", async () => {
    const ws = workspace();
    const result = await runBash(ws, "code3", `exit 3`);
    expect(result.failure?.kind).toBe("exit");
    expect(result.failure?.message).toMatch(/exited with code 3/);
    expect(result.failure?.message).toMatch(/bash: \S+/);
  }, 30_000);

  it("appends the last line the script wrote to stderr", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "with-reason",
      `echo "the orders API answered 503" >&2
       exit 1`
    );
    expect(result.failure?.kind).toBe("exit");
    expect(result.failure?.message).toMatch(
      /^The script exited with code 1 \(bash: .+\)\. the orders API answered 503$/
    );
    expect(result.log).toContain("the orders API answered 503\n");
  }, 30_000);

  onPosix(
    "keeps a job's answer to the stop out of the reason",
    async () => {
      const ws = workspace();
      const result = await runBash(
        ws,
        "job-left-running",
        `( trap 'echo "helper: stopping" >&2; exit 0' TERM
           while true; do sleep 0.05; done ) &
         echo "the orders API answered 503" >&2
         exit 1`
      );
      expect(result.failure?.kind).toBe("exit");
      expect(result.failure?.message).toMatch(/\)\. the orders API answered 503$/);
      expect(result.log).toContain("helper: stopping\n");
    },
    30_000
  );

  onPosix(
    "keeps a stderr consumer's last line when a quiet job holds the streams",
    async () => {
      const ws = workspace();
      const result = await runBash(
        ws,
        "consumer-and-job",
        `exec 2> >(while IFS= read -r l; do sleep 0.02; printf '%s\\n' "$l"; done >&2)
         sleep 30 &
         echo "step 1: seeding" >&2
         echo "FATAL: the real error" >&2
         exit 1`
      );
      expect(result.failure?.kind).toBe("exit");
      expect(result.failure?.message).toMatch(/\)\. FATAL: the real error$/);
    },
    30_000
  );

  onPosix(
    "keeps what a stderr consumer writes after bash exits",
    async () => {
      const ws = workspace();
      const result = await runBash(
        ws,
        "slow-consumer",
        `exec 2> >(while IFS= read -r l; do sleep 0.02; printf '%s\\n' "$l"; done >&2)
         for i in $(seq 1 40); do echo "progress line $i" >&2; done
         echo "FATAL: the real error" >&2
         exit 1`
      );
      expect(result.failure?.message).toMatch(/\)\. FATAL: the real error$/);
      expect(result.log).toContain("progress line 40\n");
      expect(result.logTruncated).toBe(false);
    },
    30_000
  );

  onPosix(
    "marks the log cut when a job is still writing at the limit",
    async () => {
      const ws = workspace();
      const result = await runBash(
        ws,
        "chatty-job",
        `( sleep 0.3; while true; do echo "[logcat] heartbeat" >&2; sleep 0.05; done ) &
         echo "the orders API answered 503" >&2
         exit 1`
      );
      expect(result.failure?.message).toMatch(/\)\. the orders API answered 503$/);
      expect(result.log).toContain("[logcat] heartbeat\n");
      expect(result.logTruncated).toBe(true);
      expect(result.notes.join(" ")).toContain("was still writing to the log");
      expect(result.durationMs).toBeLessThan(15_000);
    },
    30_000
  );

  onPosix(
    "keeps a stderr consumer's last line when a job keeps writing to stdout",
    async () => {
      const ws = workspace();
      const result = await runBash(
        ws,
        "consumer-and-chatty-stdout",
        `exec 2> >(while IFS= read -r l; do sleep 0.02; printf '%s\\n' "$l"; done >&2)
         ( while true; do echo "[mock] GET /health 200"; sleep 0.1; done ) &
         echo "FATAL: the real error" >&2
         exit 1`
      );
      expect(result.failure?.message).toMatch(/\)\. FATAL: the real error$/);
      expect(result.logTruncated).toBe(true);
    },
    30_000
  );

  onPosix(
    "leaves out a stderr line a job writes after stderr went quiet",
    async () => {
      const ws = workspace();
      const result = await runBash(
        ws,
        "late-job-line",
        `( for i in $(seq 1 10); do echo "[mock] GET /health 200"; sleep 0.1; done
           echo "mock-server: listening on :8080" >&2
           while true; do echo "[mock] GET /health 200"; sleep 0.1; done ) &
         echo "seed failed: orders API answered 503" >&2
         exit 1`
      );
      expect(result.failure?.message).toMatch(/\)\. seed failed: orders API answered 503$/);
      expect(result.log).toContain("mock-server: listening on :8080");
    },
    30_000
  );

  onPosix(
    "keeps the late line when the loop stalls across the quiet mark",
    async () => {
      const ws = workspace();
      const exited = ws.resolve("exited");
      const script = ws.write(
        "stall.sh",
        `exec 2> >(while IFS= read -r l; do sleep 0.1; printf '%s\\n' "$l"; done >&2)
         sleep 30 &
         echo "step 1: seeding" >&2
         echo "FATAL: the real error" >&2
         touch ${JSON.stringify(exited)}
         exit 1`
      );
      const pending = executor().execute({
        scriptPath: script,
        interpreter: "bash",
        projectRoot: ws.dir,
      });
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(exited) && Date.now() < deadline) await delay(10);
      await delay(150);
      // Blocked from before the error arrives until past the quiet mark, and
      // from an I/O callback, where a synchronous request handler runs: a block
      // inside a timer callback leaves the loop's clock where it was, and the
      // quiet timer waits for the next turn, after the poll.
      await new Promise<void>((resolve) =>
        fs.stat(exited, () => {
          const until = Date.now() + 700;
          while (Date.now() < until) {}
          resolve();
        })
      );
      const result = await pending;

      expect(result.failure?.message).toMatch(/\)\. FATAL: the real error$/);
    },
    30_000
  );

  onPosix(
    "keeps a consumer's late line when a cancel ends the wait",
    async () => {
      const ws = workspace();
      const exited = ws.resolve("exited");
      const script = ws.write(
        "cancel-late.sh",
        `exec 2> >(while IFS= read -r l; do sleep 0.1; printf '%s\\n' "$l"; done >&2)
         sleep 30 &
         echo "step 1: seeding" >&2
         echo "FATAL: the real error" >&2
         touch ${JSON.stringify(exited)}
         exit 1`
      );
      const cancel = new AbortController();
      const pending = executor().execute({
        scriptPath: script,
        interpreter: "bash",
        projectRoot: ws.dir,
        signal: cancel.signal,
      });
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(exited) && Date.now() < deadline) await delay(10);
      await delay(500);
      cancel.abort();
      const result = await pending;

      expect(result.failure?.kind).toBe("exit");
      expect(result.failure?.message).toMatch(/\)\. FATAL: the real error$/);
    },
    30_000
  );

  onPosix(
    "keeps a consumer's late line when a cancel lands before it is written",
    async () => {
      const ws = workspace();
      const exited = ws.resolve("exited");
      const script = ws.write(
        "cancel-early.sh",
        `exec 2> >(while IFS= read -r l; do sleep 0.1; printf '%s\\n' "$l"; done >&2)
         sleep 30 &
         echo "step 1: seeding" >&2
         echo "FATAL: the real error" >&2
         touch ${JSON.stringify(exited)}
         exit 1`
      );
      const cancel = new AbortController();
      const pending = executor().execute({
        scriptPath: script,
        interpreter: "bash",
        projectRoot: ws.dir,
        signal: cancel.signal,
      });
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(exited) && Date.now() < deadline) await delay(10);
      await delay(150);
      cancel.abort();
      const result = await pending;

      expect(result.failure?.kind).toBe("exit");
      expect(result.failure?.message).toMatch(/\)\. FATAL: the real error$/);
    },
    30_000
  );

  onPosix(
    "ends the wait for a job still writing when the run is cancelled",
    async () => {
      const ws = workspace();
      const exited = ws.resolve("exited");
      const script = ws.write(
        "cancel-settle.sh",
        `( while true; do echo tick >&2; sleep 0.05; done ) &
         printf '{"ok":true}' > "$ARGENT_OUTPUT"
         echo done > ${JSON.stringify(exited)}`
      );
      const cancel = new AbortController();
      const pending = executor().execute({
        scriptPath: script,
        interpreter: "bash",
        projectRoot: ws.dir,
        signal: cancel.signal,
      });
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(exited) && Date.now() < deadline) await delay(20);
      await delay(300);
      const cancelledAt = Date.now();
      cancel.abort();
      const result = await pending;

      expect(result.ok).toBe(true);
      expect(Date.now() - cancelledAt).toBeLessThan(1_500);
      expect(result.logTruncated).toBe(true);
    },
    30_000
  );

  onPosix(
    "still marks the log cut when a run cancelled mid-script leaves a writer",
    async () => {
      const ws = workspace();
      const pidFile = ws.resolve("writer.pid");
      const script = ws.write(
        "cancel-midscript.sh",
        `set -m
         ( while true; do echo tick >&2; sleep 0.05; done ) &
         echo $! > ${JSON.stringify(pidFile)}
         sleep 30`
      );
      const cancel = new AbortController();
      const pending = executor().execute({
        scriptPath: script,
        interpreter: "bash",
        projectRoot: ws.dir,
        signal: cancel.signal,
      });
      strays.push(await readPidFile(pidFile));
      await delay(300);
      cancel.abort();
      const result = await pending;

      expect(result.failure?.kind).toBe("cancelled");
      expect(result.logTruncated).toBe(true);
    },
    30_000
  );

  it("says only the code when the script wrote nothing to stderr", async () => {
    const ws = workspace();
    const result = await runBash(ws, "silent", `exit 7`);
    expect(result.failure?.message).toMatch(/^The script exited with code 7 \(bash: .+\)\.$/);
  }, 30_000);

  it("says only the code when stderr held nothing but whitespace", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "blank-stderr",
      `printf '\\n   \\n\\t\\r\\n \\r' >&2
       exit 7`
    );
    expect(result.failure?.message).toMatch(/^The script exited with code 7 \(bash: .+\)\.$/);
  }, 30_000);

  it("skips a whitespace-only stderr line longer than the head it would keep", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "long-blank",
      `echo "the orders API answered 503" >&2
       head -c 100000 /dev/zero | LC_ALL=C tr '\\0' ' ' >&2
       exit 9`
    );
    expect(result.failure?.message).toMatch(/\)\. the orders API answered 503$/);
  }, 30_000);

  it("ends the reason with the last line that is not blank, trimmed", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "several-lines",
      `echo "connecting to the orders API" >&2
       echo "  the orders API answered 503  " >&2
       printf '\\n   \\n\\t\\r\\n' >&2
       exit 5`
    );
    expect(result.failure?.kind).toBe("exit");
    expect(result.failure?.message).toMatch(/\(bash: .+\)\. the orders API answered 503$/);
    expect(result.failure?.message).not.toContain("connecting");
  }, 30_000);

  // stdout is the log's and nothing else's: what a script prints on its way
  // out - a cleanup notice, a summary - is not why it failed. The pause puts
  // the stdout line after the stderr one in arrival order too, not only in the
  // script.
  it("never takes the reason from stdout, even when stdout spoke last", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "stdout-last",
      `echo "the orders API answered 503" >&2
       sleep 0.2
       echo "cleaning up"
       exit 1`
    );
    expect(result.failure?.message).toMatch(/\)\. the orders API answered 503$/);
    expect(result.failure?.message).not.toContain("cleaning up");
    expect(result.log).toContain("cleaning up\n");
  }, 30_000);

  it("takes the error of the command set -e stopped on as the reason", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "set-e",
      `set -euo pipefail
       echo "reading the fixture"
       cat ./no-such-fixture.json
       echo "never reached" >&2`
    );
    expect(result.failure?.kind).toBe("exit");
    expect(result.failure?.message).toContain("code 1");
    expect(result.failure?.message).toMatch(
      /\)\. cat: \.\/no-such-fixture\.json: No such file or directory$/
    );
    expect(result.failure?.message).not.toContain("never reached");
  }, 30_000);

  it("joins a stderr line that arrived in two pieces", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "two-pieces",
      `printf 'the orders API ' >&2
       sleep 0.3
       printf 'answered 503\\n' >&2
       exit 1`
    );
    expect(result.failure?.message).toMatch(/\)\. the orders API answered 503$/);
  }, 30_000);

  // The log stops at its limit and the reason does not: a script that floods
  // stderr with progress and then says why it failed still says it. The flood
  // is one line, so the reason is the only line after it. The short line in
  // front moves the limit off the edge of a pipe chunk, so the log is cut
  // inside one, as it is for most real output.
  it("takes the last line after a stderr flood past the log's limit", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "flood-then-reason",
      `echo "starting the flood" >&2
       head -c ${SCRIPT_STEP_LOG_LIMIT_BYTES * 2} /dev/zero | tr '\\0' 'e' >&2
       printf '\\nthe orders API answered 503\\n' >&2
       exit 1`
    );
    expect(result.failure?.kind).toBe("exit");
    expect(result.failure?.message).toMatch(/\)\. the orders API answered 503$/);
    expect(result.logTruncated).toBe(true);
    expect(Buffer.byteLength(result.log)).toBeLessThanOrEqual(SCRIPT_STEP_LOG_LIMIT_BYTES);
    expect(result.log).not.toContain("503");
  }, 30_000);

  it("has no failure for a passing step that wrote to stderr", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "stderr-on-pass",
      `echo "not a failure" >&2
       printf '{"ok":true}' > "$ARGENT_OUTPUT"`
    );
    expect(result.ok).toBe(true);
    expect(result.failure).toBeUndefined();
    expect(result.output).toEqual({ ok: true });
    expect(result.log).toContain("not a failure\n");
  }, 30_000);

  it("adds no stderr line to a time limit", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "timeout-with-stderr",
      `echo "still waiting on the orders API" >&2
       while true; do sleep 1; done`,
      { timeoutMs: 1_000 }
    );
    expect(result.failure?.kind).toBe("timeout");
    expect(result.failure?.message).not.toContain("still waiting");
    expect(result.log).toContain("still waiting on the orders API");
  }, 30_000);

  onPosix(
    "adds no stderr line to a signal death",
    async () => {
      const ws = workspace();
      const result = await runBash(
        ws,
        "signal-with-stderr",
        `echo "about to be killed" >&2
       kill -KILL $$`
      );
      expect(result.failure?.kind).toBe("signal");
      expect(result.failure?.message).toContain("SIGKILL");
      expect(result.failure?.message).not.toContain("about to be killed");
    },
    30_000
  );

  it("adds no stderr line to a document it could not use", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "output-with-stderr",
      `echo "wrote the document" >&2
       printf 'not json' > "$ARGENT_OUTPUT"`
    );
    expect(result.failure?.kind).toBe("output");
    expect(result.failure?.message).toContain("did not parse");
    expect(result.failure?.message).not.toContain("wrote the document");
  }, 30_000);

  it("keeps the head of a long stderr line and counts the rest", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "loud-reason",
      `head -c 40000 /dev/zero | tr '\\0' 'x' >&2
       exit 1`
    );
    expect(result.failure?.kind).toBe("exit");
    expect(result.failure?.message).toMatch(/\)\. x{1000}… \[39000 more characters omitted]$/);
  }, 30_000);

  it("counts what it omitted from a long line behind leading whitespace", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "padded-reason",
      `set -euo pipefail
       {
         head -c 400 /dev/zero | LC_ALL=C tr '\\0' ' '
         head -c 5000 /dev/zero | LC_ALL=C tr '\\0' 'Z'
       } >&2
       exit 9`
    );

    expect(result.failure?.kind).toBe("exit");
    expect(result.failure?.message).toMatch(/\)\. Z{600}… \[4400 more characters omitted]$/);
  }, 30_000);

  // A character split across two pipe chunks has to be decoded whole, or the
  // reason carries a replacement character where a euro sign was. The pause
  // splits one for certain, inside the head the reason keeps, and the line
  // runs past the limit so the cut meets multi-byte text too. Octal escapes
  // rather than `\u`, which bash 3.2 does not know.
  it("keeps the head of a long multi-byte stderr line without breaking a character", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "wide-reason",
      `euros() {
         i=0
         while [ $i -lt "$1" ]; do printf '\\342\\202\\254ab'; i=$((i + 1)); done
       }
       {
         euros 100
         printf '\\342'
         sleep 0.3
         printf '\\202\\254ab'
         euros 299
       } >&2
       exit 2`
    );

    const message = result.failure?.message ?? "";
    const expected = `). ${"\u20ACab".repeat(400).slice(0, 1_000)}… [200 more characters omitted]`;
    expect(result.failure?.kind).toBe("exit");
    expect(message).not.toContain("\uFFFD");
    expect(message.slice(-expected.length)).toBe(expected);
  }, 30_000);

  it("keeps the head of a long stderr line without splitting an astral character", async () => {
    const ws = workspace();
    ws.write("emoji-line.txt", `a${"\u{1F600}".repeat(9_000)}`);
    const result = await runBash(
      ws,
      "emoji-line",
      `cat emoji-line.txt >&2
       exit 1`
    );

    const message = result.failure?.message ?? "";
    const expected = `). a${"\u{1F600}".repeat(499)}… [17002 more characters omitted]`;
    expect(result.failure?.kind).toBe("exit");
    expect(message.isWellFormed()).toBe(true);
    expect(message.slice(-expected.length)).toBe(expected);
  }, 30_000);

  it("hints at the two exit codes that are bash's own, not the script's", async () => {
    const ws = workspace();
    const missing = await runBash(ws, "missing-tool", `argent-no-such-command-here`);
    expect(missing.failure?.kind).toBe("exit");
    expect(missing.failure?.message).toContain("code 127");
    expect(missing.failure?.message).toContain("command not found");

    // Running a directory is the portable way to reach 126.
    const notExecutable = await runBash(
      ws,
      "not-exec",
      `set +e
       "$(dirname "${BASH_SOURCE}")"
       exit $?`
    );
    expect(notExecutable.failure?.message).toContain("code 126");
    expect(notExecutable.failure?.message).toContain("could not be run");
    expect(notExecutable.failure?.message).toContain("may not READ");
    expect(notExecutable.failure?.message).toContain("not executable");
  }, 60_000);

  // A `.sh` checked out with CRLF carries the carriage return into the last
  // word of every line, so `> "$ARGENT_OUTPUT"` writes a file one carriage
  // return past the one the parent reads — and the parent's own seeded document
  // is what an exit code of 0 then returns. The one CRLF symptom that is green.
  //
  // POSIX bash only, like the two cases after it: Git for Windows' bash drops a
  // carriage return from the line it reads, so a CRLF script runs there as its
  // LF twin would - which is what the Windows runner showed for all three.
  onPosix(
    "refuses an exit 0 whose redirection landed one carriage return away",
    async () => {
      const ws = workspace();
      const script = ws.write("crlf.sh", `printf '%s' '{"seeded":true}' > "$ARGENT_OUTPUT"\r\n`);
      const result = await executor().execute({
        scriptPath: script,
        interpreter: "bash",
        projectRoot: ws.dir,
      });

      expect(result.ok).toBe(false);
      expect(result.failure?.kind).toBe("output");
      expect(result.failure?.message).toContain("CRLF");
      expect(result.failure?.message).toContain("$ARGENT_OUTPUT");
    },
    30_000
  );

  onPosix(
    "refuses a wholly CRLF script that ran to the end and exited 0",
    async () => {
      const ws = workspace();
      const script = ws.write(
        "crlf-whole.sh",
        "printf '%s' '{\"seeded\":true}' > \"$ARGENT_OUTPUT\"\r\n"
      );
      const result = await executor().execute({
        scriptPath: script,
        interpreter: "bash",
        projectRoot: ws.dir,
      });

      expect(result.failure?.kind).toBe("output");
      expect(result.failure?.message).toContain("CRLF");
      expect(result.failure?.message).toContain("$ARGENT_OUTPUT");
    },
    30_000
  );

  // What CRLF does to a script that fails is bash's own complaint on stderr,
  // so that complaint is what the report ends with: to bash a blank line is a
  // lone carriage return, and a command it cannot find. GNU bash 5.x spells the
  // name `$'\r'`; Apple's 3.2 writes the carriage return itself.
  onPosix(
    "hands a CRLF script's own bash error to the reason and to the log",
    async () => {
      const ws = workspace();
      const result = await runBash(ws, "crlf-blank", "echo start\r\n\r\n");

      const said = /crlf-blank\.sh: line 2: (\$'\\r'|\r): command not found/;
      expect(result.failure?.kind).toBe("exit");
      expect(result.failure?.message).toContain("code 127");
      expect(result.failure?.message).toMatch(new RegExp(`${said.source}$`));
      expect(result.log).toMatch(said);
    },
    30_000
  );

  it("refuses the same redirection under the name msys2 gives it", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "crlf-msys",
      `printf '%s' '{"seeded":true}' > "$ARGENT_OUTPUT"$'\uf00d'`
    );

    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe("output");
    expect(result.failure?.message).toContain("CRLF");
  }, 30_000);

  // The stray is written the way each platform's bash names one. Git Bash drops
  // a carriage return from the line it reads, which turned `$'<CR>'` into an
  // empty word and the redirection into one that emptied the real document; it
  // names the stray with U+F00D, as the case above does.
  it("keeps the document of a script that also left a stray sibling", async () => {
    const ws = workspace();
    const stray = process.platform === "win32" ? "" : "\r";
    const result = await runBash(
      ws,
      "stray-sibling",
      `printf '{"real":true}' > "$ARGENT_OUTPUT.t"
       mv "$ARGENT_OUTPUT.t" "$ARGENT_OUTPUT"
       : > "$ARGENT_OUTPUT"$'${stray}'`
    );

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ real: true });
  }, 30_000);

  onPosix(
    "reads a 128+N exit as the script's own status, not as a signal",
    async () => {
      const ws = workspace();
      const result = await runBash(
        ws,
        "forwarded-signal",
        `set +e
       "$(command -v sh)" -c 'kill -9 $$'
       exit $?`
      );
      expect(result.failure?.kind).toBe("exit");
      expect(result.failure?.message).toContain("code 137");
      expect(result.failure?.message).not.toContain("killed by");
    },
    30_000
  );

  onPosix(
    "reports bash killed by a signal as an error naming it",
    async () => {
      const ws = workspace();
      const result = await runBash(ws, "self-signalled", `kill -TERM $$; sleep 30`);
      expect(result.failure?.kind).toBe("signal");
      expect(result.failure?.message).toContain("SIGTERM");
    },
    30_000
  );

  // `trap 'kill 0' EXIT` is the standard bash idiom for reaping background jobs,
  // and `kill 0` is the whole process group — the one this step leads, so it
  // reaches the runner as well as the jobs it was aimed at. Ended there, the
  // runner never read `$ARGENT_OUTPUT` and never sent a verdict, and the parent
  // described the SIGTERM on ITS OWN child as one the script did not choose.
  //
  // Which of the two verdicts follows is the bash's own, the same split the
  // SIGQUIT case below records: GNU bash 5.x dies with the group and the step
  // reports the `kill 0` guidance, Apple's 3.2 — the bash a stock Mac offers,
  // and one `flow-script-interpreter.ts` accepts — does not, and the step
  // passes on the document it wrote. Neither is the parent calling this a
  // signal from the host, which is what this pins.
  onPosix(
    "reads a group-wide kill as the script's own answer, not as a signal from the host",
    async () => {
      const ws = workspace();
      const result = await runBash(
        ws,
        "kill-group",
        `trap 'kill 0' EXIT
       sleep 30 &
       printf '{"seeded":true}' > "$ARGENT_OUTPUT.t"
       mv "$ARGENT_OUTPUT.t" "$ARGENT_OUTPUT"`
      );
      expect(result.failure?.message ?? "").not.toContain("did not stop itself");
      if (result.ok) {
        expect(result.output).toEqual({ seeded: true });
      } else {
        expect(result.failure?.kind).toBe("exit");
        expect(result.failure?.message).toContain("process group was sent SIGTERM");
        expect(result.failure?.message).toContain("kill 0");
      }
    },
    30_000
  );

  onPosix.each([100, 500, 900])(
    "reports a signalled bash as a signal under a %sms time limit",
    async (timeoutMs) => {
      const ws = workspace();
      const result = await runBash(ws, `self-signalled-${timeoutMs}`, `kill -s TERM $$; sleep 30`, {
        timeoutMs,
      });

      expect(result.failure?.kind).toBe("signal");
      expect(result.failure?.message).toContain("SIGTERM");
    },
    30_000
  );

  // The one signal where bash and Node disagree in the direction that matters:
  // GNU bash 5.x IGNORES SIGQUIT in a non-interactive shell and Node's default
  // kills on it, so `kill -QUIT 0` ended the runner and left bash running - the
  // failure `holdGroupSignals` exists to prevent. The parent then reported "the
  // script process was killed by SIGQUIT … it did not stop itself" about a
  // script that had already written a complete document.
  //
  // Which of the two verdicts follows is the bash's own: 5.x survives and the
  // step passes on the document it wrote, Apple's 3.2 dies and the step reports
  // the same `kill 0` guidance the SIGTERM case does. Neither is the runner
  // dying, which is what this pins.
  onPosix(
    "survives a SIGQUIT the script sent its own group",
    async () => {
      const ws = workspace();
      const result = await runBash(
        ws,
        "kill-group-quit",
        `trap 'kill -QUIT 0' EXIT
       sleep 30 &
       printf '{"seeded":true}' > "$ARGENT_OUTPUT.t"
       mv "$ARGENT_OUTPUT.t" "$ARGENT_OUTPUT"`
      );

      expect(result.failure?.message ?? "").not.toContain("did not stop itself");
      if (result.ok) expect(result.output).toEqual({ seeded: true });
      else expect(result.failure?.message).toContain("kill 0");
    },
    30_000
  );

  // The OTHER spelling of the same mistake. A `kill 0` in the body of the
  // script — with bash still to run the rest of it — kills bash, and where else
  // it lands is the platform's to decide. Measured on macOS, neither the runner
  // nor a plain `sleep` in the same process group receives it, so it arrives
  // exactly as a host's SIGTERM on bash alone would; on Linux the runner that
  // leads the group receives it too, and reports the group signal. Either way
  // the report names `kill 0` and the remedy rather than leaving the author
  // with a bare signal, which is what this pins.
  onPosix(
    "names a self-sent group kill in the message, whichever process it reached",
    async () => {
      const ws = workspace();
      const result = await runBash(
        ws,
        "kill-group-body",
        `kill -TERM 0
       sleep 30`
      );
      const message = result.failure?.message ?? "";
      if (result.failure?.kind === "signal") {
        expect(message).toContain("killed by SIGTERM");
        expect(message).toContain("`kill 0` in the body of the script");
      } else {
        expect(result.failure?.kind).toBe("exit");
        expect(message).toContain("process group was sent SIGTERM");
        expect(message).toContain("`kill 0` reaches bash itself");
      }
      expect(message).toContain("signal each job's own pid instead");
    },
    30_000
  );

  onPosix(
    "does not offer `kill -- -$$`, which reaches nothing and lets the step pass",
    async () => {
      const ws = workspace();
      const result = await runBash(
        ws,
        "kill-dash-dollar",
        `trap 'kill -- -$$' EXIT
       printf '{"ran":true}' > "$ARGENT_OUTPUT.t"
       mv "$ARGENT_OUTPUT.t" "$ARGENT_OUTPUT"`
      );

      expect(result.failure).toBeUndefined();
      expect(result.output).toEqual({ ran: true });
    },
    30_000
  );

  // The same idiom, repeatedly, because the answer above used to be decided one
  // `setImmediate` after bash's exit — a callback in the SAME loop iteration as
  // the exit it was waiting behind. The signal and the exit both arrive through
  // libuv's signal pipe with no order between them, so the unchanged script
  // landed on the `signal` side about once in thirty runs on an idle machine
  // and about once in twelve under load. One run cannot see that; these can.
  //
  // ONE verdict, not a named one: which it is belongs to the bash, as above.
  // The race is what puts a second kind in the set, and `signal` is the side it
  // lands on.
  onPosix(
    "reads a group-wide kill the same way on every run",
    async () => {
      const ws = workspace();
      const script = ws.write(
        "kill-group-repeat.sh",
        `trap 'kill 0' EXIT
       sleep 30 &
       printf '{"seeded":true}' > "$ARGENT_OUTPUT.t"
       mv "$ARGENT_OUTPUT.t" "$ARGENT_OUTPUT"`
      );
      const width = 8;
      const runs = executor({ concurrency: width });
      const kinds = new Set<string | undefined>();
      // In waves of the executor's own width, so that what these count is the
      // verdict and not the queue: everything past the waiting cap is refused
      // before it is run.
      for (let wave = 0; wave < 15; wave += 1) {
        const verdicts = await Promise.all(
          Array.from({ length: width }, async () => {
            const result = await runs.execute({
              scriptPath: script,
              interpreter: "bash",
              projectRoot: ws.dir,
            });
            return result.failure?.kind;
          })
        );
        for (const kind of verdicts) kinds.add(kind);
      }

      expect(kinds.size).toBe(1);
      expect(kinds.has("signal")).toBe(false);
    },
    180_000
  );

  onPosix(
    "never says a script did not start when the script ended the runner",
    async () => {
      const ws = workspace();
      const markers = path.join(ws.dir, "ran");
      fs.mkdirSync(markers, { recursive: true });
      const script = ws.write("kill-runner.sh", `touch "${markers}/$$"\n       kill -9 $PPID`);
      const width = 8;
      const runs = executor({ concurrency: width });
      const kinds = new Set<string | undefined>();
      for (let wave = 0; wave < 20; wave += 1) {
        const verdicts = await Promise.all(
          Array.from({ length: width }, async () => {
            const result = await runs.execute({
              scriptPath: script,
              interpreter: "bash",
              projectRoot: ws.dir,
            });
            return result.failure?.kind;
          })
        );
        for (const kind of verdicts) kinds.add(kind);
      }

      expect(fs.readdirSync(markers).length).toBe(width * 20);
      expect(kinds).toEqual(new Set(["signal"]));
    },
    180_000
  );

  onPosix(
    "waits for its own copy of the signal before blaming something outside the group",
    async () => {
      const ws = workspace();
      const startedAt = Date.now();
      const result = await runBash(ws, "self-signalled-wait", `kill -TERM $$; sleep 30`);
      const elapsed = Date.now() - startedAt;

      expect(result.failure?.kind).toBe("signal");
      expect(elapsed).toBeGreaterThanOrEqual(500);
    },
    30_000
  );

  onPosix(
    "reports an interpreter that disappeared after the check as a spawn error",
    async () => {
      const ws = workspace();
      const project = fs.mkdtempSync(path.join(os.tmpdir(), "argent-bad-bash-"));
      const vanishing = path.join(project, "bash");
      fs.writeFileSync(
        vanishing,
        "#!/bin/sh\nprintf '\\nargent-bash-version:5.2.0-stub\\n'\nrm -f \"$0\"\n"
      );
      fs.chmodSync(vanishing, 0o755);
      const script = ws.write("never-runs.sh", `printf '{"ok":true}' > "$ARGENT_OUTPUT"`);

      try {
        const result = await withGlobalBash(vanishing, () =>
          executor().execute({
            scriptPath: script,
            interpreter: "bash",
            projectRoot: project,
          })
        );

        expect(result.failure?.kind).toBe("spawn");
        expect(result.failure?.message).toContain(vanishing);
        expect(result.failure?.message).toContain("could not be started");
      } finally {
        fs.rmSync(project, { recursive: true, force: true });
      }
    },
    30_000
  );
});

describe("the runner's own channels in bash mode", () => {
  onPosix(
    "gives bash writable null devices where its own channels are, so no write can forge a verdict",
    async () => {
      const ws = workspace();
      const forged = '{"type":"result","outputJson":"{\\"forged\\":true}"}';
      const result = await runBash(
        ws,
        "forger",
        `set +e
       wrote=""
       for fd in 3 4 5; do
         if echo '${forged}' >&$fd 2>/dev/null; then wrote="$wrote$fd"; fi
       done
       printf '{"real":true,"wrote":"%s"}' "$wrote" > "$ARGENT_OUTPUT"
       exit 0`
      );

      expect(result.ok).toBe(true);
      expect(result.output).toEqual({ real: true, wrote: "345" });
    },
    30_000
  );

  it("gives the script an empty stdin, so a read gets end of file", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "stdin",
      `set +e
       if read -r line; then status=read; else status=eof; fi
       printf '{"stdin":"%s"}' "$status" > "$ARGENT_OUTPUT"
       exit 0`
    );
    expect(result.output).toEqual({ stdin: "eof" });
  }, 30_000);

  it("survives a flood on stdout, keeping only the head of it in the log", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "flood",
      `set -euo pipefail
       head -c 4000000 /dev/zero | tr '\\0' 'z'
       printf '{"ok":true}' > "$ARGENT_OUTPUT"`
    );
    expect(result.failure).toBeUndefined();
    expect(result.output).toEqual({ ok: true });
    expect(result.logTruncated).toBe(true);
    expect(Buffer.byteLength(result.log)).toBeLessThanOrEqual(SCRIPT_STEP_LOG_LIMIT_BYTES);
    expect(Buffer.byteLength(result.log)).toBeGreaterThan(SCRIPT_STEP_LOG_LIMIT_BYTES - 2048);
    expect(result.log).toMatch(/^z+$/);
  }, 60_000);

  it("reads a child's V8 heap banner as the script's exit code, not as a heap limit", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "banner",
      `set +e
       echo "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory" >&2
       exit 9`
    );
    expect(result.failure?.kind).toBe("exit");
    expect(result.failure?.message).toContain("code 9");
  }, 30_000);
});

describe("finding the interpreter", () => {
  onPosix(
    "says how long finding bash took when it outlasts the step's own limit",
    async () => {
      const ws = workspace();
      const bin = ws.resolve("slowbin");
      fs.mkdirSync(bin, { recursive: true });
      const slow = path.join(bin, "bash");
      fs.writeFileSync(
        slow,
        `#!/bin/sh\ncase "$*" in *argent-bash-version*) sleep 2 ;; esac\nexec ${hostBash} "$@"\n`
      );
      fs.chmodSync(slow, 0o755);
      const script = ws.write("quick.sh", `printf '{"ok":true}' > "$ARGENT_OUTPUT"`);

      const result = await withSearchPath(bin, () =>
        executor().execute({
          scriptPath: script,
          interpreter: "bash",
          projectRoot: ws.dir,
          timeoutMs: 500,
        })
      );

      expect(result.ok).toBe(true);
      expect(result.notes.join(" ")).toContain("Finding the bash for this step took");
      expect(result.notes.join(" ")).toContain("outside the step's own 500 ms limit");
      expect(result.durationMs).toBeGreaterThan(1_500);
    },
    30_000
  );

  // The executor wires the request's abort into the lookup. Nothing else pinned
  // that it does: dropping `request.signal` from the call left the whole suite
  // green, and the `"cancelled" in found` arm beside it reachable through no
  // test. Aborted DURING the lookup rather than before it, because the check at
  // the top of `runOne` answers a signal already raised and would pass either
  // way.
  onPosix(
    "cancels a step while it is still looking for bash",
    async () => {
      const ws = workspace();
      const bin = ws.resolve("deafbin");
      fs.mkdirSync(bin, { recursive: true });
      const deaf = path.join(bin, "bash");
      fs.writeFileSync(deaf, `#!/bin/sh\ntrap '' TERM\nwhile :; do sleep 1; done\n`);
      fs.chmodSync(deaf, 0o755);
      const script = ws.write("cancel-lookup.sh", `printf '{"ok":true}' > "$ARGENT_OUTPUT"`);
      const cancel = new AbortController();
      setTimeout(() => cancel.abort(), 300);

      const startedAt = Date.now();
      const result = await withSearchPath(bin, () =>
        executor().execute({
          scriptPath: script,
          interpreter: "bash",
          projectRoot: ws.dir,
          signal: cancel.signal,
        })
      );

      expect(result.failure?.kind).toBe("cancelled");
      expect(Date.now() - startedAt).toBeLessThan(4_000);
    },
    30_000
  );

  onPosix(
    "says the global configuration was not read when it could not be parsed",
    async () => {
      const ws = workspace();
      const script = ws.write("lost.sh", `printf '{"ok":true}' > "$ARGENT_OUTPUT"`);

      const result = await withSearchPath(
        path.dirname(hostBash),
        () =>
          executor().execute({
            scriptPath: script,
            interpreter: "bash",
            projectRoot: ws.dir,
          }),
        '{"scripts":{"bash":"/bin/ba'
      );

      expect(result.ok).toBe(true);
      expect(result.notes.join(" ")).toContain("global configuration was not read");
      expect(result.notes.join(" ")).toContain("is not valid JSON");
    },
    30_000
  );

  onPosix(
    "probes a PATH bash in the directory the step runs in",
    async () => {
      const ws = workspace();
      ws.write(".tool-versions", "bash host\n");
      const bin = ws.resolve("shimbin");
      fs.mkdirSync(bin, { recursive: true });
      const shim = path.join(bin, "bash");
      fs.writeFileSync(
        shim,
        `#!/bin/sh\nif [ -f .tool-versions ]; then export ARGENT_TEST_SHIM=1; exec ${hostBash} "$@"; fi\n` +
          `echo "No version is set for command bash" >&2\nexit 126\n`
      );
      fs.chmodSync(shim, 0o755);
      const script = ws.write(
        "pinned.sh",
        `printf '{"shim":"%s"}' "\${ARGENT_TEST_SHIM:-}" > "$ARGENT_OUTPUT"`
      );

      const result = await withSearchPath(bin, () =>
        executor().execute({ scriptPath: script, interpreter: "bash", projectRoot: ws.dir })
      );

      expect(result.ok).toBe(true);
      expect(result.output).toEqual({ shim: "1" });
      expect(result.notes.join(" ")).not.toContain("refused");
    },
    30_000
  );

  it("says nothing about the lookup when bash answers at once", async () => {
    const ws = workspace();
    const result = await runBash(ws, "quiet", `printf '{"ok":true}' > "$ARGENT_OUTPUT"`, {
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(true);
    expect(result.notes.join(" ")).not.toContain("Finding the bash");
  }, 30_000);
});

describe("environment and working directory", () => {
  it("gives the script the same allowlist a .mjs gets, plus the exchange name", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "printenv",
      `set -euo pipefail
       printf '{"names":"%s"}' "$(printenv | sed 's/=.*//' | sort | tr '\\n' ' ')" > "$ARGENT_OUTPUT"`
    );
    const names = String((result.output as { names: string }).names).split(" ");
    expect(names).toContain("PATH");
    expect(names).toContain("ARGENT_OUTPUT");
    expect(names).not.toContain("ARGENT_REASON");
    expect(names).not.toContain("ARGENT_FLOW_SCRIPT_RUNNER");
    expect(names).not.toContain("NODE_CHANNEL_FD");
    for (const name of ["BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "CDPATH", "GLOBIGNORE"]) {
      expect(names, name).not.toContain(name);
    }
  }, 30_000);

  it("refuses the exchange name in a caller's override map", async () => {
    const ws = workspace();
    const result = await runBash(ws, "env-output", `exit 0`, {
      env: { ARGENT_OUTPUT: "/tmp/x" },
    });
    expect(result.failure?.kind).toBe("invalid");
    expect(result.failure?.message).toContain("ARGENT_OUTPUT");
  }, 30_000);

  it("hands ARGENT_REASON to the script like any other name", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "env-reason",
      `printf '{"value":"%s"}' "$ARGENT_REASON" > "$ARGENT_OUTPUT"`,
      { env: { ARGENT_REASON: "the caller's own" } }
    );
    expect(result.failure).toBeUndefined();
    expect(result.output).toEqual({ value: "the caller's own" });
  }, 30_000);

  // Written as two files rather than as two path strings: under Git Bash `$PWD`
  // is a `/c/…` path no Node call can stat, while `$0` and `$ARGENT_OUTPUT`
  // arrive as `C:/…`. Where each marker lands answers both questions on every
  // platform — and the second one only lands at all because `$0` carries a
  // separator for `dirname` to split on.
  it("runs in project_root, and gives $0 a separator dirname can split on", async () => {
    const ws = workspace();
    const nested = path.join(ws.dir, "nested");
    fs.mkdirSync(nested, { recursive: true });
    const script = ws.write(
      "nested/where.sh",
      `set -euo pipefail
       printf 'cwd' > ./cwd-marker
       printf 'dir' > "$(dirname "${BASH_SOURCE}")/dir-marker"
       printf '{"ok":true}' > "$ARGENT_OUTPUT"`
    );
    const result = await executor().execute({
      scriptPath: script,
      interpreter: "bash",
      projectRoot: ws.dir,
    });

    expect(result.failure).toBeUndefined();
    expect(fs.existsSync(path.join(ws.dir, "cwd-marker"))).toBe(true);
    expect(fs.existsSync(path.join(nested, "dir-marker"))).toBe(true);
  }, 30_000);
});

describe("limits and stopping", () => {
  it("stops a looping script at its time limit and leaves no process behind", async () => {
    const ws = workspace();
    const pidFile = ws.resolve("child.pid");
    const script = ws.write(
      "loop.sh",
      `${backgroundJob(pidFile)}
       while true; do sleep 1; done`
    );
    const pending = executor().execute({
      scriptPath: script,
      interpreter: "bash",
      projectRoot: ws.dir,
      timeoutMs: 2_000,
    });
    const grandchild = await readPidFile(pidFile);
    strays.push(grandchild);
    const result = await pending;

    expect(result.failure?.kind).toBe("timeout");
    expect(await waitForExit(grandchild, 10_000)).toBe(true);
  }, 60_000);

  onPosix(
    "still empties the group when the script traps SIGTERM and keeps running",
    async () => {
      const ws = workspace();
      const pidFile = ws.resolve("trapped.pid");
      const script = ws.write(
        "trap.sh",
        `trap 'true' TERM
       sleep 120 &
       echo $! > ${JSON.stringify(pidFile)}
       while true; do sleep 1; done`
      );
      const pending = executor().execute({
        scriptPath: script,
        interpreter: "bash",
        projectRoot: ws.dir,
        timeoutMs: 2_000,
      });
      const grandchild = await readPidFile(pidFile);
      strays.push(grandchild);
      const result = await pending;

      expect(result.failure?.kind).toBe("timeout");
      expect(await waitForExit(grandchild, 10_000)).toBe(true);
    },
    60_000
  );

  it("cancels a running script after it started, and empties the group", async () => {
    const ws = workspace();
    const pidFile = ws.resolve("cancelled.pid");
    const script = ws.write(
      "wait.sh",
      `${backgroundJob(pidFile)}
       while true; do sleep 1; done`
    );
    const controller = new AbortController();
    const pending = executor().execute({
      scriptPath: script,
      interpreter: "bash",
      projectRoot: ws.dir,
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    const grandchild = await readPidFile(pidFile);
    strays.push(grandchild);
    controller.abort();
    const result = await pending;

    expect(result.failure?.kind).toBe("cancelled");
    expect(result.failure?.beforeFork).toBeUndefined();
    expect(await waitForExit(grandchild, 10_000)).toBe(true);
  }, 60_000);

  it("has the deadline watchdog take the whole group when the tool server stalls", async () => {
    const ws = workspace();
    const pidFile = ws.resolve("stalled.pid");
    const script = ws.write(
      "stalled.sh",
      `${backgroundJob(pidFile)}
       while true; do sleep 1; done`
    );
    const timeoutMs = 2_000;
    const startedAt = Date.now();
    const pending = executor().execute({
      scriptPath: script,
      interpreter: "bash",
      projectRoot: ws.dir,
      timeoutMs,
    });
    const descendant = await readPidFile(pidFile);
    strays.push(descendant);

    const probe = (afterDeadlineMs: number) => {
      while (Date.now() - startedAt < timeoutMs + afterDeadlineMs) {}
      return isAlive(descendant);
    };
    const withinMargin = probe(1_200);
    const pastMargin = probe(3_500);
    const result = await pending;

    expect(withinMargin).toBe(true);
    expect(pastMargin).toBe(false);
    expect(result.failure).toMatchObject({ kind: "timeout" });
  }, 60_000);

  onPosix(
    "returns the document of a script that exits 0 with a job still running",
    async () => {
      const ws = workspace();
      const pidFile = ws.resolve("backgrounded.pid");
      const result = await runBash(
        ws,
        "background-then-pass",
        `set -euo pipefail
       sleep 30 &
       echo $! > ${JSON.stringify(pidFile)}
       printf '{"ok":true}' > "$ARGENT_OUTPUT"`
      );
      const job = await readPidFile(pidFile, 10_000);
      strays.push(job);

      expect(result.failure).toBeUndefined();
      expect(result.output).toEqual({ ok: true });
      expect(await waitForExit(job, 10_000)).toBe(true);
    },
    30_000
  );

  it("clamps a time limit above the host maximum and says so, as it does for a .mjs", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "clamped",
      `printf '{"ok":true}' > "$ARGENT_OUTPUT"`,
      { timeoutMs: 90_000 },
      { maxTimeoutMs: 5_000 }
    );
    expect(result.ok).toBe(true);
    expect(result.notes.join(" ")).toContain("above this host's maximum");
  }, 30_000);
});

describe("the private exchange directory", () => {
  it("is gone after a pass, a fail, a timeout and a cancellation", async () => {
    const ws = workspace();

    await runBash(ws, "pass", `printf '{"ok":true}' > "$ARGENT_OUTPUT"`);
    await runBash(ws, "fail", `exit 1`);
    await runBash(ws, "slow", `while true; do sleep 1; done`, { timeoutMs: 1_000 });

    const controller = new AbortController();
    const script = ws.write("abort.sh", `while true; do sleep 1; done`);
    const pending = executor().execute({
      scriptPath: script,
      interpreter: "bash",
      projectRoot: ws.dir,
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    await delay(400);
    controller.abort();
    await pending;

    expect(exchangeDirs()).toEqual([]);
  }, 60_000);

  it("works from an exchange root whose path holds a space", async () => {
    const ws = workspace();
    const spaced = path.join(ws.dir, "dir with space");
    fs.mkdirSync(spaced, { recursive: true });
    const result = await runBash(
      ws,
      "spaced",
      `set -euo pipefail
       test -f "$ARGENT_OUTPUT"
       printf '{"where":"%s"}' "$(dirname "$ARGENT_OUTPUT")" > "$ARGENT_OUTPUT.t"
       mv "$ARGENT_OUTPUT.t" "$ARGENT_OUTPUT"`,
      {},
      { exchangeRoot: spaced }
    );

    expect(result.ok).toBe(true);
    expect(String((result.output as { where?: string }).where)).toContain("dir with space");
    expect(fs.readdirSync(spaced)).toEqual([]);
  }, 30_000);

  it("holds the document and nothing else", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "listing",
      `set -euo pipefail
       held="$(ls -A "$(dirname "$ARGENT_OUTPUT")" | tr '\\n' ' ')"
       printf '{"held":"%s"}' "$held" > "$ARGENT_OUTPUT.t"
       mv "$ARGENT_OUTPUT.t" "$ARGENT_OUTPUT"`
    );

    expect(result.output).toEqual({ held: "output.json " });
  }, 30_000);

  onPosix(
    "gives the exchange file the owner's account and nothing else",
    async () => {
      const ws = workspace();
      const result = await runBash(
        ws,
        "modes",
        // GNU first: GNU `stat -f` is `--file-system`, which prints the file
        // system `$1` sits on to stdout before the fallback runs, while BSD
        // `stat` refuses `-c` with nothing on stdout.
        `mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }
       printf '{"output":"%s","dir":"%s"}' \
         "$(mode "$ARGENT_OUTPUT")" \
         "$(mode "$(dirname "$ARGENT_OUTPUT")")" > "$ARGENT_OUTPUT.t"
       mv "$ARGENT_OUTPUT.t" "$ARGENT_OUTPUT"`
      );

      expect(result.output).toEqual({ output: "600", dir: "700" });
    },
    30_000
  );
});

describe("what a step reports before anything is forked", () => {
  it("runs nothing when the cancellation lands while bash is being resolved", async () => {
    const ws = workspace();
    const markers = path.join(ws.dir, "markers");
    fs.mkdirSync(markers, { recursive: true });
    const script = ws.write("side-effect.sh", `touch "${markers}/$$"\n       sleep 5`);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const controller = new AbortController();
      const pending = executor().execute({
        scriptPath: script,
        interpreter: "bash",
        projectRoot: ws.dir,
        timeoutMs: 20_000,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 0);
      const result = await pending;

      expect(result.failure?.kind).toBe("cancelled");
      expect(result.failure?.beforeFork).toBe(true);
    }

    expect(fs.readdirSync(markers)).toEqual([]);
  }, 60_000);

  it("marks an unusable scripts.bash as a failure from before the fork", async () => {
    const ws = workspace();
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "argent-nobash-"));
    const script = ws.write("never-runs.sh", `printf '{"ok":true}' > "$ARGENT_OUTPUT"`);

    try {
      const result = await withGlobalBash(path.join(project, "no-such-bash"), () =>
        executor().execute({
          scriptPath: script,
          interpreter: "bash",
          projectRoot: project,
        })
      );

      expect(result.failure?.kind).toBe("spawn");
      expect(result.failure?.beforeFork).toBe(true);
      expect(result.failure?.message).toContain("does not exist");
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  }, 30_000);

  it("reports an exchange directory it could not create, and forks nothing", async () => {
    const ws = workspace();
    const script = ws.write("never-runs-either.sh", `printf '{"ok":true}' > "$ARGENT_OUTPUT"`);

    const result = await executor({
      exchangeRoot: path.join(ws.dir, "no", "such", "root"),
    }).execute({ scriptPath: script, interpreter: "bash", projectRoot: ws.dir });

    expect(result.failure?.kind).toBe("spawn");
    expect(result.failure?.beforeFork).toBe(true);
    expect(result.failure?.message).toContain("private exchange directory could not be created");
  }, 30_000);
});

describe("the published layout", () => {
  // The runner gains a mode, not a file: bash mode has to work from a directory
  // holding only the three `.mjs` the bundle copies, forked as the entry module
  // rather than pulled in as a preload.
  it("runs bash mode from a dist holding only the three runner files", async () => {
    const ws = workspace();
    const dist = ws.resolve("fake-dist");
    fs.mkdirSync(dist, { recursive: true });
    for (const name of [
      "flow-script-runner.mjs",
      "flow-script-watchdog-lifeline.mjs",
      "flow-script-watchdog-deadline.mjs",
    ]) {
      fs.copyFileSync(path.join(SOURCE_RUNNER_DIR, name), path.join(dist, name));
    }
    const script = ws.write("published.sh", `printf '{"ok":true}' > "$ARGENT_OUTPUT"`);

    const result = await executor().execute({
      scriptPath: script,
      interpreter: "bash",
      projectRoot: ws.dir,
      runnerDir: dist,
    });

    expect(result.failure).toBeUndefined();
    expect(result.output).toEqual({ ok: true });
  }, 30_000);
});

describe("a tool server that dies mid-step", () => {
  // The other way a runner learns its parent is gone: the IPC channel closes
  // while the process that held it stays alive. The lifeline never fires there,
  // so nothing else in this file reaches the bash branch of
  // `exitOnParentDisconnect` — the orphan case below fires the lifeline too,
  // and the lifeline kills the group on its own.
  //
  // The runner is forked here rather than driven through the executor, because
  // the executor disconnects only once the step is already over.
  onPosix(
    "takes bash and its descendants when only the channel closes",
    async () => {
      const ws = workspace();
      const exchange = fs.mkdtempSync(path.join(exchangeRoot, "disconnect-"));
      const outputFile = path.join(exchange, "output.json");
      fs.writeFileSync(outputFile, "{}");
      const bashFile = ws.resolve("bash.pid");
      const childFile = ws.resolve("bash-child.pid");
      const script = ws.write(
        "disconnect.sh",
        `sleep 300 &
       echo $! > ${JSON.stringify(childFile)}
       echo $$ > ${JSON.stringify(bashFile)}
       while true; do sleep 1; done`
      );

      const runner = fork(path.join(SOURCE_RUNNER_DIR, "flow-script-runner.mjs"), [], {
        cwd: ws.dir,
        env: { ...process.env, ARGENT_FLOW_SCRIPT_RUNNER: "1" },
        execArgv: [],
        stdio: ["ignore", "pipe", "pipe", "ignore", "pipe", "ipc"],
        detached: true,
      });
      runner.stdout?.resume();
      runner.stderr?.resume();
      const runnerExited = new Promise<void>((resolve) => runner.once("exit", () => resolve()));
      try {
        runner.send({
          type: "execute",
          interpreter: "bash",
          interpreterPath: hostBash,
          scriptPath: script,
          outputFile,
          outputJson: "{}",
          deadlineMs: 120_000,
          maxOutputBytes: SCRIPT_MAX_OUTPUT_BYTES,
        });

        const bashPid = await readPidFile(bashFile, 40_000);
        const grandchild = await readPidFile(childFile, 40_000);
        strays.push(bashPid, grandchild);
        expect(isAlive(bashPid)).toBe(true);

        runner.disconnect();

        expect(await waitForExit(bashPid, 20_000)).toBe(true);
        expect(await waitForExit(grandchild, 20_000)).toBe(true);
        await runnerExited;
      } finally {
        runner.kill("SIGKILL");
        fs.rmSync(exchange, { recursive: true, force: true });
      }
    },
    90_000
  );

  it("reaps bash and its descendants when only the lifeline descriptor closes", async () => {
    const ws = workspace();
    const exchange = fs.mkdtempSync(path.join(exchangeRoot, "lifeline-"));
    const outputFile = path.join(exchange, "output.json");
    fs.writeFileSync(outputFile, "{}");
    const descendantFile = ws.resolve("lifeline-descendant.pid");
    const node = JSON.stringify(process.execPath.replace(/\\/g, "/"));
    const script = ws.write(
      "lifeline.sh",
      `${node} -e 'require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);' ${JSON.stringify(
        descendantFile.replace(/\\/g, "/")
      )} &
       while true; do sleep 1; done`
    );

    const runner = fork(path.join(SOURCE_RUNNER_DIR, "flow-script-runner.mjs"), [], {
      cwd: ws.dir,
      env: { ...process.env, ARGENT_FLOW_SCRIPT_RUNNER: "1" },
      execArgv: [],
      stdio: ["ignore", "pipe", "pipe", "ignore", "pipe", "ipc"],
      detached: true,
    });
    runner.stdout?.resume();
    runner.stderr?.resume();
    const runnerExited = new Promise<void>((resolve) => runner.once("exit", () => resolve()));
    try {
      runner.send({
        type: "execute",
        interpreter: "bash",
        interpreterPath: hostBash,
        scriptPath: script,
        outputFile,
        outputJson: "{}",
        deadlineMs: 120_000,
        maxOutputBytes: SCRIPT_MAX_OUTPUT_BYTES,
      });

      const descendant = await readPidFile(descendantFile, 40_000);
      strays.push(descendant);
      expect(isAlive(descendant)).toBe(true);

      const lifeline = runner.stdio[4] as NodeJS.WritableStream & { destroy?: () => void };
      lifeline.destroy?.();

      expect(await waitForExit(descendant, 20_000)).toBe(true);
      await runnerExited;
    } finally {
      runner.kill("SIGKILL");
      fs.rmSync(exchange, { recursive: true, force: true });
    }
  }, 90_000);

  onPosix(
    "takes bash and its descendants with the runner",
    async () => {
      const ws = workspace();
      const bashFile = ws.resolve("bash.pid");
      const childFile = ws.resolve("bash-child.pid");
      const runnerFile = ws.resolve("runner.pid");
      const script = ws.write(
        "orphan.sh",
        `sleep 300 &
       echo $! > ${JSON.stringify(childFile)}
       echo $PPID > ${JSON.stringify(runnerFile)}
       echo $$ > ${JSON.stringify(bashFile)}
       while true; do sleep 1; done`
      );
      const driver = path.resolve(__dirname, "../../fixtures/flow-script-orphan-driver.ts");
      const parent = spawn(
        process.execPath,
        [
          require.resolve("ts-node/dist/bin.js"),
          "-T",
          "-P",
          path.resolve(__dirname, "../../../tsconfig.json"),
          driver,
          script,
          ws.dir,
          "bash",
          ws.dir,
        ],
        { cwd: path.resolve(__dirname, "../../.."), stdio: ["ignore", "ignore", "pipe"] }
      );
      let driverStderr = "";
      parent.stderr?.setEncoding("utf8");
      parent.stderr?.on("data", (chunk: string) => {
        driverStderr += chunk;
      });
      try {
        const bashPid = await readPidFile(bashFile, 40_000, () => driverStderr);
        const grandchild = await readPidFile(childFile, 40_000, () => driverStderr);
        const runnerPid = await readPidFile(runnerFile, 40_000, () => driverStderr);
        strays.push(bashPid, grandchild, runnerPid);
        expect(isAlive(bashPid)).toBe(true);
        expect(isAlive(grandchild)).toBe(true);

        parent.kill("SIGKILL");
        expect(await waitForExit(bashPid, 20_000)).toBe(true);
        expect(await waitForExit(grandchild, 20_000)).toBe(true);
        expect(await waitForExit(runnerPid, 20_000)).toBe(true);
      } finally {
        parent.kill("SIGKILL");
        for (const file of [bashFile, childFile, runnerFile]) {
          try {
            const written = Number(fs.readFileSync(file, "utf8").trim());
            if (Number.isInteger(written)) strays.push(written);
          } catch {}
        }
      }
    },
    90_000
  );
});
