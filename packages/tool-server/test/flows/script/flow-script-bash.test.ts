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

/**
 * Where this file's steps make their exchange directories. `os.tmpdir()` holds
 * every other argent install's too — a second checkout on the machine creates
 * and removes them while these tests run — so what is counted there is not a
 * fact about this file.
 */
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

const strays: number[] = [];

afterEach(() => {
  while (strays.length) {
    try {
      process.kill(strays.pop()!, "SIGKILL");
    } catch {
      // Already gone.
    }
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

/**
 * The extension never reaches the executor — `flow-script-step.ts` reads it and
 * passes `interpreter` — so these fixtures carry `.sh` because an author would,
 * not because anything here looks at it.
 */
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

/**
 * Windows has no signals and no process group: `kill -TERM` inside Git Bash
 * does not reach the runner as a signal, a `TERM` trap has nothing to catch,
 * and the lifeline reads a descriptor the parent cannot hand it. The cases
 * whose SEMANTICS are POSIX skip there; everything else — the document, the
 * exchange files, the exit codes, the null devices, the tree stop and the
 * deadline watchdog — is what the Windows job runs.
 */
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
    } catch {
      // Not written yet.
    }
    await delay(50);
  }
  // What the driver said, where there is a driver: a crash of it reads as
  // "no pid appeared" otherwise, which names the symptom and not the cause.
  const said = driverStderr?.() ?? "";
  throw new Error(`No pid appeared in ${file}${said ? `; the driver said: ${said}` : ""}`);
}

function exchangeDirs(): string[] {
  return fs.readdirSync(exchangeRoot).filter((entry) => entry.startsWith(exchangeDirPrefix()));
}

/** `${BASH_SOURCE[0]}` written so the TypeScript template does not eat it. */
const BASH_SOURCE = "${BASH_SOURCE[0]}";

describe("a bash step that passes", () => {
  it("returns the document the script wrote, and nothing it printed", async () => {
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
    expect(JSON.stringify(result)).not.toContain("seeding order");
    expect(JSON.stringify(result)).not.toContain("a warning");
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

  // The claim is that the ONE slot is shared across the two languages, so each
  // script has to say when it ran: two trivially fast scripts read after both
  // resolved say nothing an executor ignoring `concurrency` would not also say.
  // Each records its own window, and the windows must not overlap.
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

  // `jq … "$ARGENT_OUTPUT" > "$ARGENT_OUTPUT"` truncates the file before jq
  // reads it, and this refusal is what the author then sees.
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

  // The read is bounded rather than `stat`-ed first: a `stat` would describe a
  // file a descendant is still growing, and leave the read itself unbounded.
  // Both sides of the boundary, at the exact byte: the runner reads
  // `maxOutputBytes + 1` and the parent measures the text it was sent, so a
  // document 200 KB over proves neither of them agrees on where the edge is.
  it("takes a document of exactly the limit and refuses one byte more", async () => {
    const ws = workspace();
    const padding = (bytes: number) =>
      `set -euo pipefail
       printf '{"big":"' > "$ARGENT_OUTPUT.t"
       head -c ${bytes} /dev/zero | tr '\\0' 'z' >> "$ARGENT_OUTPUT.t"
       printf '"}' >> "$ARGENT_OUTPUT.t"
       mv "$ARGENT_OUTPUT.t" "$ARGENT_OUTPUT"`;
    // `{"big":"` and `"}` are the 10 bytes around the padding.
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
  it.each([
    ["a named pipe", `mkfifo "$ARGENT_OUTPUT"`],
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

  it("reports the exit code when $ARGENT_REASON is a named pipe, at once", async () => {
    const ws = workspace();
    const startedAt = Date.now();
    const result = await runBash(
      ws,
      "reason-pipe",
      `rm -f "$ARGENT_REASON"
       mkfifo "$ARGENT_REASON"
       exit 3`,
      { timeoutMs: 3_000 }
    );

    expect(result.failure?.kind).toBe("exit");
    expect(result.failure?.message).toContain("code 3");
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  }, 30_000);

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

  it("appends what the script wrote to $ARGENT_REASON", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "with-reason",
      `echo "the orders API answered 503" > "$ARGENT_REASON"
       exit 1`
    );
    expect(result.failure?.kind).toBe("exit");
    expect(result.failure?.message).toContain("the orders API answered 503");
  }, 30_000);

  it("says only the code when the script wrote no reason", async () => {
    const ws = workspace();
    const result = await runBash(ws, "silent", `exit 7`);
    expect(result.failure?.message).toMatch(/^The script exited with code 7 \(bash: .+\)\.$/);
  }, 30_000);

  it("ignores the reason file on exit 0", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "reason-on-pass",
      `echo "not a failure" > "$ARGENT_REASON"
       printf '{"ok":true}' > "$ARGENT_OUTPUT"`
    );
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("not a failure");
  }, 30_000);

  // The marker states the size of the FILE. A bounded read cannot count what it
  // did not read, and the count of the string that was read is wrong by orders
  // of magnitude — 40000 characters were once reported as 24671 omitted.
  it("clamps a reason at the ceiling and says how much the file holds", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "loud-reason",
      `head -c 40000 /dev/zero | tr '\\0' 'x' > "$ARGENT_REASON"
       exit 1`
    );
    expect(result.failure?.kind).toBe("exit");
    expect(result.failure!.message.length).toBeLessThanOrEqual(8 * 1024);
    expect(result.failure?.message).toContain("$ARGENT_REASON holds 40000 bytes");
    expect(result.failure?.message).toMatch(/keeps the first \d+ characters]$/);
  }, 30_000);

  // Octal escapes rather than `\u`, which bash 3.2 does not know: the point is
  // that the bytes really are multi-byte. The read is bounded in BYTES and the
  // ceiling counts CHARACTERS, so a cut that ignored continuation bytes would
  // put a replacement character where a euro sign was.
  it("clamps a multi-byte reason without breaking a character", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "wide-reason",
      `set -euo pipefail
       i=0
       while [ $i -lt 4000 ]; do
         printf '\\342\\202\\254ab\\342\\202\\254ab\\342\\202\\254ab\\342\\202\\254ab'
         i=$((i + 1))
       done >> "$ARGENT_REASON"
       exit 2`
    );

    expect(result.failure?.kind).toBe("exit");
    expect(result.failure?.message).toContain("\u20AC");
    expect(result.failure?.message).not.toContain("\uFFFD");
    expect(result.failure?.message).toContain("$ARGENT_REASON holds 80000 bytes");
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
    // Both causes: an unreadable script file exits 126 too, and `chmod +x` is
    // the wrong remedy for that one.
    expect(notExecutable.failure?.message).toContain("could not be run");
    expect(notExecutable.failure?.message).toContain("may not READ");
    expect(notExecutable.failure?.message).toContain("not executable");
  }, 60_000);

  // A `.sh` checked out with CRLF carries the carriage return into the last
  // word of every line, so `> "$ARGENT_OUTPUT"` writes a file one carriage
  // return past the one the parent reads — and the parent's own seeded document
  // is what an exit code of 0 then returns. The one CRLF symptom that is green.
  it("refuses an exit 0 whose redirection landed one carriage return away", async () => {
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
  }, 30_000);

  // Windows is the one platform a CRLF checkout happens on, and there bash is
  // msys2 — a Cygwin fork, which cannot put an ASCII control character in a
  // file name and transposes it into the private-use block. So the stray file
  // is named with U+F00D there and U+000D everywhere else, and a check for one
  // of them alone misses on the very platform it exists for.
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

  it("keeps the document of a script that also left a stray sibling", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "stray-sibling",
      `printf '{"real":true}' > "$ARGENT_OUTPUT.t"
       mv "$ARGENT_OUTPUT.t" "$ARGENT_OUTPUT"
       : > "$ARGENT_OUTPUT"$'\r'`
    );

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ real: true });
  }, 30_000);

  // 128+N is bash reporting a FOREGROUND command killed by signal N. The script
  // chose to run that command and could have handled its status, so the step
  // reads it as an exit code — a `fail`, not the `signal` error that a death of
  // bash itself is.
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
      expect(result.failure?.kind).toBe("exit");
      expect(result.failure?.message).toContain("process group was sent SIGTERM");
      expect(result.failure?.message).toContain("kill 0");
      expect(result.failure?.message).not.toContain("did not stop itself");
    },
    30_000
  );

  // The OTHER spelling of the same mistake, and the one the split above cannot
  // see. A `kill 0` in the body of the script — with bash still to run the rest
  // of it — kills bash and reaches nothing else: measured on macOS, neither the
  // runner nor a plain `sleep` in the same process group receives the signal,
  // while the same kill under a `trap "" TERM` that lets bash survive reaches
  // both. So this arrives exactly as a host's SIGTERM on bash alone would, and
  // the report says so rather than leaving the author with a bare signal.
  onPosix(
    "names a self-sent group kill in the message when it cannot be told from the host's",
    async () => {
      const ws = workspace();
      const result = await runBash(
        ws,
        "kill-group-body",
        `kill -TERM 0
       sleep 30`
      );
      expect(result.failure?.kind).toBe("signal");
      expect(result.failure?.message).toContain("killed by SIGTERM");
      expect(result.failure?.message).toContain("`kill 0` in the body of the script");
      expect(result.failure?.message).toContain("signal each job's own pid instead");
    },
    30_000
  );

  // The guidance names one spelling because only one of them does anything
  // here. The runner leads the process group, so `-$$` — bash's own pid — names
  // a group that does not exist: the kill fails and the script runs on.
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

      expect(kinds).toEqual(new Set(["exit"]));
    },
    180_000
  );

  // `started` used to be sent from the child's `spawn` EVENT, a turn of the
  // loop after libuv had already forked and exec'd bash — so a script whose
  // first line ends the runner could beat it, and the parent then reported a
  // script that had already run as one that never started. About one run in a
  // hundred, and the body ran on every one of them.
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

  // The other side of the same decision, and the one that is deterministic:
  // `kill -TERM $$` names bash alone, so this signal never reaches the runner
  // and never can. The runner may only call it a signal from outside the group
  // once it has WAITED for its own copy — which is what the elapsed time here
  // pins. Deciding in one turn of the loop, as this once did, costs no time and
  // is what makes the case above flaky.
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

  // The resolver checks its candidate by running it, so what it accepted can
  // still be gone by the time the runner spawns it. That lands on the runner's
  // own `error` handler, and `spawn` is the one kind that tells the author
  // nothing ran. The interpreter here answers the resolver's version question
  // and then removes itself, which is that race made deterministic.
  onPosix(
    "reports an interpreter that disappeared after the check as a spawn error",
    async () => {
      const ws = workspace();
      const project = fs.mkdtempSync(path.join(os.tmpdir(), "argent-bad-bash-"));
      fs.mkdirSync(path.join(project, ".argent"), { recursive: true });
      const vanishing = path.join(project, "bash");
      fs.writeFileSync(
        vanishing,
        "#!/bin/sh\nprintf '\\nargent-bash-version:5.2.0-stub\\n'\nrm -f \"$0\"\n"
      );
      fs.chmodSync(vanishing, 0o755);
      fs.writeFileSync(
        path.join(project, ".argent", "config.json"),
        JSON.stringify({ scripts: { bash: vanishing } })
      );
      const script = ws.write("never-runs.sh", `printf '{"ok":true}' > "$ARGENT_OUTPUT"`);

      try {
        const result = await executor().execute({
          scriptPath: script,
          interpreter: "bash",
          projectRoot: project,
        });

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
  // Descriptor 5 is the protocol channel. A `result` line reaching it would be
  // parsed by Node inside its own read callback in the parent, and a forged
  // verdict is exactly what the three null devices exist to prevent. 3 is the
  // parent's sink and 4 is the lifeline.
  // Each write has to SUCCEED and reach nothing. A closed descriptor gives the
  // same `ok` and the same document under `set +e`, so asserting only those
  // does not tell three null devices apart from Node's close-on-exec having
  // closed them — which is the very distinction the runner refuses to rest on.
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

  it("survives a flood on stdout, which nothing reports and nothing may block on", async () => {
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
    expect(JSON.stringify(result)).not.toContain("zzz");
  }, 60_000);

  // The terminal message a runner in bash mode always sends is classified ahead
  // of the stderr scan, which is what keeps a banner printed by something the
  // script ran from becoming the step's verdict.
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

describe("environment and working directory", () => {
  it("gives the script the same allowlist a .mjs gets, plus the two exchange names", async () => {
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
    expect(names).toContain("ARGENT_REASON");
    expect(names).not.toContain("ARGENT_FLOW_SCRIPT_RUNNER");
    expect(names).not.toContain("NODE_CHANNEL_FD");
    // Nothing bash-specific is admitted: each of these steers bash rather than
    // the runner, and none is in the allowlist.
    for (const name of ["BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "CDPATH", "GLOBIGNORE"]) {
      expect(names, name).not.toContain(name);
    }
  }, 30_000);

  it("refuses either exchange name in a caller's override map", async () => {
    const ws = workspace();
    for (const name of ["ARGENT_OUTPUT", "ARGENT_REASON"]) {
      const result = await runBash(ws, `env-${name}`, `exit 0`, { env: { [name]: "/tmp/x" } });
      expect(result.failure?.kind, name).toBe("invalid");
      expect(result.failure?.message, name).toContain(name);
    }
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
      `sleep 120 &
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
    // The runner leads the group, bash joined it and the `sleep` joined bash:
    // the parent's group stop reaches all three with no bash-specific code.
    expect(await waitForExit(grandchild, 10_000)).toBe(true);
  }, 60_000);

  // The group SIGTERM reaches bash and the runner at once, and Node's default
  // handling exits the runner without running its `exit` listener — so a script
  // that traps TERM is left the last member of a leaderless group. The
  // escalation to SIGKILL is what still empties it.
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
      `sleep 120 &
       echo $! > ${JSON.stringify(pidFile)}
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
    // It reached the system it talks to, so there IS state to clean up.
    expect(result.failure?.beforeFork).toBeUndefined();
    expect(await waitForExit(grandchild, 10_000)).toBe(true);
  }, 60_000);

  // The parent's own timer and stop cannot run while its loop is blocked, so
  // what reaches this descendant reaches it from inside the child — through the
  // group the deadline watchdog kills. Bash mode installs the same watchdog.
  it("has the deadline watchdog take the whole group when the tool server stalls", async () => {
    const ws = workspace();
    const pidFile = ws.resolve("stalled.pid");
    const script = ws.write(
      "stalled.sh",
      `sleep 300 &
       echo $! > ${JSON.stringify(pidFile)}
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
      while (Date.now() - startedAt < timeoutMs + afterDeadlineMs) {
        /* block */
      }
      return isAlive(descendant);
    };
    const withinMargin = probe(1_200);
    const pastMargin = probe(3_500);
    const result = await pending;

    expect(withinMargin).toBe(true);
    expect(pastMargin).toBe(false);
    expect(result.failure?.kind).toBe("timeout");
  }, 60_000);

  // The `.mjs` side has this at flow-script-lifecycle.test.ts; every bash
  // background fixture loops forever, so only the timeout and cancel paths were
  // covered. A job still running when the script exits 0 must not hold the
  // document back, and must not outlive the step.
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

  // Windows hands every step a `%TEMP%` under `C:\\Users\\First Last\\…`, so a
  // quoting mistake anywhere in the exchange path is a Windows-only failure
  // that POSIX CI would never see. The whole contract holds here instead.
  it("works from an exchange root whose path holds a space", async () => {
    const ws = workspace();
    const spaced = path.join(ws.dir, "dir with space");
    fs.mkdirSync(spaced, { recursive: true });
    const result = await runBash(
      ws,
      "spaced",
      `test -f "$ARGENT_OUTPUT"
       test -f "$ARGENT_REASON"
       printf '{"where":"%s"}' "$(dirname "$ARGENT_OUTPUT")" > "$ARGENT_OUTPUT.t"
       mv "$ARGENT_OUTPUT.t" "$ARGENT_OUTPUT"`,
      {},
      { exchangeRoot: spaced }
    );

    expect(result.ok).toBe(true);
    expect(String((result.output as { where?: string }).where)).toContain("dir with space");
    expect(fs.readdirSync(spaced)).toEqual([]);
  }, 30_000);

  // Both files carry the document, and the document may hold values derived
  // from a secret. The 0700 directory `mkdtemp` makes already holds on its own;
  // these modes are the second barrier, and a bare write leaves them to the
  // umask, which on an ordinary host is 0644. Read from inside the step,
  // because the directory is gone by the time it returns.
  onPosix(
    "gives both exchange files the owner's account and nothing else",
    async () => {
      const ws = workspace();
      const result = await runBash(
        ws,
        "modes",
        `mode() { stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"; }
       printf '{"output":"%s","reason":"%s","dir":"%s"}' \
         "$(mode "$ARGENT_OUTPUT")" "$(mode "$ARGENT_REASON")" \
         "$(mode "$(dirname "$ARGENT_OUTPUT")")" > "$ARGENT_OUTPUT.t"
       mv "$ARGENT_OUTPUT.t" "$ARGENT_OUTPUT"`
      );

      expect(result.output).toEqual({ output: "600", reason: "600", dir: "700" });
    },
    30_000
  );
});

describe("what a step reports before anything is forked", () => {
  // A `.sh` step suspends where a `.mjs` step does not: resolving bash is two
  // spawns of its own, and a cancellation raised across them used to find the
  // next check only AFTER the fork — so the script's first lines had already
  // run, for a run the caller had already given up on.
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
      // After `execute` has started, so the abort lands inside the lookup
      // rather than at the gate in front of it.
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
    fs.mkdirSync(path.join(project, ".argent"), { recursive: true });
    fs.writeFileSync(
      path.join(project, ".argent", "config.json"),
      JSON.stringify({ scripts: { bash: path.join(project, "no-such-bash") } })
    );
    const script = ws.write("never-runs.sh", `printf '{"ok":true}' > "$ARGENT_OUTPUT"`);

    try {
      const result = await executor().execute({
        scriptPath: script,
        interpreter: "bash",
        projectRoot: project,
      });

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
      const reasonFile = path.join(exchange, "reason.txt");
      fs.writeFileSync(outputFile, "{}");
      fs.writeFileSync(reasonFile, "");
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
          reasonFile,
          deadlineMs: 120_000,
          maxOutputBytes: SCRIPT_MAX_OUTPUT_BYTES,
        });

        const bashPid = await readPidFile(bashFile, 40_000);
        const grandchild = await readPidFile(childFile, 40_000);
        strays.push(bashPid, grandchild);
        expect(isAlive(bashPid)).toBe(true);

        // The channel alone: the lifeline the parent holds stays open, so what
        // reaps the tree here is the runner's own `disconnect` handler.
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

  // The lifeline itself, on every platform. The two cases either side of this
  // one are `onPosix`: a signal the runner holds, and a driver that reads pids
  // bash reports. This one closes the parent's end of the lifeline descriptor
  // and reads the descendant's pid from NODE rather than from bash — `$!` in
  // Git Bash is an MSYS number and not a Windows one — so what it asserts is
  // the same fact on both, and the arm the watchdog takes on Windows
  // (`taskkill /t`, because there is no process group to name) is finally run
  // by a job that runs there.
  it("reaps bash and its descendants when only the lifeline descriptor closes", async () => {
    const ws = workspace();
    const exchange = fs.mkdtempSync(path.join(exchangeRoot, "lifeline-"));
    const outputFile = path.join(exchange, "output.json");
    const reasonFile = path.join(exchange, "reason.txt");
    fs.writeFileSync(outputFile, "{}");
    fs.writeFileSync(reasonFile, "");
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
        reasonFile,
        deadlineMs: 120_000,
        maxOutputBytes: SCRIPT_MAX_OUTPUT_BYTES,
      });

      const descendant = await readPidFile(descendantFile, 40_000);
      strays.push(descendant);
      expect(isAlive(descendant)).toBe(true);

      // The IPC channel stays open, so the runner's own `disconnect` handler
      // is not what answers: only the lifeline is.
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
      // Drained, so a driver that writes past the pipe buffer cannot block on
      // it — and so a crash of the driver reads as itself rather than as "no
      // pid appeared".
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
        // The runner itself, which the `.mjs` analog also asserts: a fix that
        // reaped the subtree and left the runner behind would pass without it.
        expect(await waitForExit(runnerPid, 20_000)).toBe(true);
      } finally {
        parent.kill("SIGKILL");
        for (const file of [bashFile, childFile, runnerFile]) {
          try {
            const written = Number(fs.readFileSync(file, "utf8").trim());
            if (Number.isInteger(written)) strays.push(written);
          } catch {
            // Never written, so there is nothing to reap.
          }
        }
      }
    },
    90_000
  );
});
