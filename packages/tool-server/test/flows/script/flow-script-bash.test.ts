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
 * Every case below runs a real bash, resolved in `beforeAll` because the
 * resolver is async and `describe.skipIf` is decided at collection.
 */
let noBash: string | undefined;

let hostBash: string;

/** This file's own exchange root: `os.tmpdir()` is shared with other installs. */
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

/**
 * Runs `body` with `process.env` overridden and a home directory of its own
 * holding `config` as the global document, which is the only scope
 * `scripts.bash` is read from.
 */
async function withHome<T>(
  config: string,
  body: () => Promise<T>,
  env: Record<string, string> = {}
): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "argent-bash-home-"));
  const overrides = { HOME: home, USERPROFILE: home, ...env };
  const real = Object.fromEntries(Object.keys(overrides).map((name) => [name, process.env[name]]));
  fs.mkdirSync(path.join(home, ".argent"), { recursive: true });
  fs.writeFileSync(path.join(home, ".argent", "config.json"), config);
  Object.assign(process.env, overrides);
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

function withGlobalBash<T>(value: string, body: () => Promise<T>): Promise<T> {
  return withHome(JSON.stringify({ scripts: { bash: value } }), body);
}

/**
 * `dir` first on the tool server's own PATH, under an empty global document so
 * a developer's own pin does not skip the search.
 */
function withSearchPath<T>(dir: string, body: () => Promise<T>, document = "{}"): Promise<T> {
  return withHome(document, body, { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` });
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
 * Windows has no signals and no process group, so cases whose semantics are
 * POSIX skip there; the rest is what the Windows job runs.
 */
const posix = process.platform !== "win32";
const onPosix = it.skipIf(!posix);

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
 * A background job that writes its own pid. Under Git Bash `$!` is an MSYS
 * number rather than one `process.kill` can ask Windows about.
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
    } catch {
      // Not written yet.
    }
    await delay(50);
  }
  const said = driverStderr?.() ?? "";
  throw new Error(`No pid appeared in ${file}${said ? `; the driver said: ${said}` : ""}`);
}

async function untilExists(file: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(file) && Date.now() < deadline) await delay(10);
}

function exchangeDirs(): string[] {
  return fs.readdirSync(exchangeRoot).filter((entry) => entry.startsWith(exchangeDirPrefix()));
}

/** A failure message that ends with `line` as its stderr reason. */
function reason(line: string): RegExp {
  return new RegExp(`\\)\\. ${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

/** Writes `json` as the document, through a temporary file and a rename. */
function writeDocument(json: string): string {
  return `printf '%s' '${json}' > "$ARGENT_OUTPUT.t"
   mv "$ARGENT_OUTPUT.t" "$ARGENT_OUTPUT"`;
}

/** `${BASH_SOURCE[0]}` written so the TypeScript template does not eat it. */
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
       printf '{"order":{"id":"ord_1","total":42}}' > "$ARGENT_OUTPUT"`,
      { timeoutMs: 5_000 }
    );

    expect(result.failure).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ order: { id: "ord_1", total: 42 } });
    expect(result.durationMs).toBeGreaterThan(0);
    // Not their order: two pipes can deliver close writes either way round.
    expect(result.log).toContain("seeding order\n");
    expect(result.log).toContain("a warning\n");
    expect(result.logTruncated).toBe(false);
    // A bash that answers at once leaves nothing to say about the lookup.
    expect(result.notes).toEqual([]);
  }, 30_000);

  it.each([
    ["never touches the file", `echo hello`],
    [
      "reads it and writes it back",
      `cp "$ARGENT_OUTPUT" "$ARGENT_OUTPUT.new"\nmv "$ARGENT_OUTPUT.new" "$ARGENT_OUTPUT"`,
    ],
  ])(
    "returns the flow's own document when the script %s",
    async (_label, source) => {
      const result = await runBash(workspace(), "given", source, { output: { given: 41 } });
      expect(result.ok).toBe(true);
      expect(result.output).toEqual({ given: 41 });
    },
    30_000
  );

  // Each script records its own window: two fast scripts read after both
  // resolved say nothing an executor ignoring `concurrency` would not also say.
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
  it.each([
    ["removed", `rm "$ARGENT_OUTPUT"`, ["$ARGENT_OUTPUT is gone"]],
    // `jq … "$ARGENT_OUTPUT" > "$ARGENT_OUTPUT"` empties the file before jq reads it.
    ["emptied, naming the idiom that avoids it", `> "$ARGENT_OUTPUT"`, ["empty", "mv"]],
    ["an array", writeDocument("[1,2]"), ["was not an object"]],
    ["a string", writeDocument('"done"'), ["was not an object"]],
    ["an object with an own __proto__ key", writeDocument('{"__proto__":{"x":1}}'), ["__proto__"]],
    // A `.sh` document never meets the runner's `walk`, which refuses this from a `.mjs`.
    [
      "a number JavaScript cannot hold",
      writeDocument('{"n":1e999,"neg":-1e999}'),
      ["output.n is Infinity", "must be finite"],
    ],
    // A decode with replacement would rewrite the bytes and pass the step.
    [
      "not valid UTF-8",
      `printf '{"token":"\\xc3\\x28abc"}' > "$ARGENT_OUTPUT.t"\nmv "$ARGENT_OUTPUT.t" "$ARGENT_OUTPUT"`,
      ["not valid UTF-8"],
    ],
    ...(posix
      ? [
          [
            "one the runner may not read, naming why",
            `printf '{"real":true}' > "$ARGENT_OUTPUT"\nchmod 000 "$ARGENT_OUTPUT"`,
            ["$ARGENT_OUTPUT could not be read", "EACCES"],
          ],
        ]
      : []),
  ] as [string, string, string[]][])(
    "refuses a document that is %s",
    async (_label, source, says) => {
      const result = await runBash(workspace(), "refused", source);
      expect(result.ok).toBe(false);
      expect(result.failure?.kind).toBe("output");
      for (const fragment of says) expect(result.failure?.message).toContain(fragment);
    },
    30_000
  );

  // V8's `SyntaxError` quotes part of the document mid-sentence, where no
  // redaction of a whole secret value can find it.
  it("says a document did not parse without quoting the document", async () => {
    const ws = workspace();
    const result = await runBash(ws, "unquoted", writeDocument('{"auth":s3cr3t-token-value}'));

    expect(result.failure?.kind).toBe("output");
    expect(result.failure?.message).toContain("did not parse");
    expect(result.failure?.message).toContain("Unexpected token");
    expect(result.failure?.message).not.toContain("s3cr3t");
    expect(result.failure?.message).not.toContain('"');
  }, 30_000);

  // Size does not bound depth, and a later step's `JSON.stringify` of the
  // document is recursive on Node 24 and older.
  it("refuses a document nested past the depth a later step can encode, and no shallower", async () => {
    const ws = workspace();
    const nested = (depth: number) => `${'{"a":'.repeat(depth)}1${"}".repeat(depth)}`;
    const copy = (file: string) =>
      `cp ${JSON.stringify(file)} "$ARGENT_OUTPUT.n"\nmv "$ARGENT_OUTPUT.n" "$ARGENT_OUTPUT"`;
    const deep = await runBash(ws, "deep", copy(ws.write("deep.json", nested(257))));
    const ok = await runBash(ws, "deep-ok", copy(ws.write("ok.json", nested(256))));

    expect(deep.failure?.kind).toBe("output");
    expect(deep.failure?.message).toContain("nests deeper than");
    // Not the 257-segment path.
    expect(deep.failure!.message.length).toBeLessThan(200);
    expect(ok.failure).toBeUndefined();
  }, 30_000);

  // The runner reads `maxOutputBytes + 1` FILE bytes and the parent measures
  // the decoded text it was sent, so the two must agree on the exact byte, and
  // a replacement character (three bytes for one) must not put a file at the
  // limit over it.
  it("takes a document of exactly the limit, and refuses one byte more or one not UTF-8", async () => {
    const ws = workspace();
    const padding = (bytes: number, fill: string) =>
      `set -euo pipefail
       printf '{"big":"' > "$ARGENT_OUTPUT.t"
       head -c ${bytes} /dev/zero | LC_ALL=C tr '\\0' '${fill}' >> "$ARGENT_OUTPUT.t"
       printf '"}' >> "$ARGENT_OUTPUT.t"
       mv "$ARGENT_OUTPUT.t" "$ARGENT_OUTPUT"`;
    // `{"big":"` and `"}` are the 10 bytes around the padding.
    const exact = await runBash(ws, "at-limit", padding(SCRIPT_MAX_OUTPUT_BYTES - 10, "z"));
    const over = await runBash(ws, "over-limit", padding(SCRIPT_MAX_OUTPUT_BYTES - 9, "z"));
    const invalid = await runBash(ws, "invalid", padding(SCRIPT_MAX_OUTPUT_BYTES - 10, "\\377"));

    expect(exact.failure).toBeUndefined();
    expect((exact.output?.big as string).length).toBe(SCRIPT_MAX_OUTPUT_BYTES - 10);
    expect(over.failure?.kind).toBe("output");
    expect(over.failure?.message).toContain("limit");
    expect(invalid.failure?.kind).toBe("output");
    expect(invalid.failure?.message).toContain("not valid UTF-8");
    expect(invalid.failure?.message).not.toContain("limit");
  }, 60_000);

  // An `open` of a FIFO with no writer would block the runner's exit handler,
  // where it holds SIGTERM, until the step's time limit. Git Bash's `mkfifo`
  // makes a file Node cannot see, so the pipe is POSIX only.
  it.each([
    ...(posix ? [["a named pipe", `mkfifo "$ARGENT_OUTPUT"`]] : []),
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
  // A carriage return is whitespace too, and the last line has no newline.
  it.each([
    ["wrote nothing to stderr", `exit 7`],
    ["wrote only whitespace to stderr", `printf '\\n   \\n\\t\\r\\n \\r' >&2\nexit 7`],
  ])(
    "names only the code and the interpreter when the script %s",
    async (_label, source) => {
      const result = await runBash(workspace(), "silent", source);
      expect(result.failure?.kind).toBe("exit");
      expect(result.failure?.message).toMatch(/^The script exited with code 7 \(bash: \S.*\)\.$/);
    },
    30_000
  );

  it.each([
    ["the last line the script wrote to stderr", `echo "the orders API answered 503" >&2\nexit 1`],
    [
      "the last line that is not blank, trimmed",
      `echo "connecting to the orders API" >&2
       echo "  the orders API answered 503  " >&2
       printf '\\n   \\n\\t\\r\\n' >&2
       exit 5`,
    ],
    // Skipped like a short blank line, not cut to a marker counting spaces.
    [
      "the line before a whitespace-only one longer than the head it keeps",
      `echo "the orders API answered 503" >&2
       head -c 100000 /dev/zero | LC_ALL=C tr '\\0' ' ' >&2
       exit 9`,
    ],
    // The pause splits the line across two pipe reads for certain.
    [
      "a line that arrived in two pieces",
      `printf 'the orders API ' >&2
       sleep 0.3
       printf 'answered 503\\n' >&2
       exit 1`,
    ],
    // What a script prints on its way out is not why it failed.
    [
      "stderr's line, even when stdout spoke last",
      `echo "the orders API answered 503" >&2
       sleep 0.2
       echo "cleaning up"
       exit 1`,
    ],
  ])(
    "ends the reason with %s",
    async (_label, source) => {
      const result = await runBash(workspace(), "reason", source);
      expect(result.failure?.kind).toBe("exit");
      expect(result.failure?.message).toMatch(reason("the orders API answered 503"));
    },
    30_000
  );

  // The case the line is for: no reason of its own, and `set -e` stopped on a
  // command that said why.
  it("takes the error of the command set -e stopped on as the reason", async () => {
    const result = await runBash(
      workspace(),
      "set-e",
      `set -euo pipefail
       echo "reading the fixture"
       cat ./no-such-fixture.json
       echo "never reached" >&2`
    );
    expect(result.failure?.message).toContain("code 1");
    expect(result.failure?.message).toMatch(
      reason("cat: ./no-such-fixture.json: No such file or directory")
    );
  }, 30_000);

  it("takes the error a tool printed, not the trailer it ends on", async () => {
    const ws = workspace();
    const node = JSON.stringify(process.execPath.replace(/\\/g, "/"));
    // No shell between Node and the failing command: cmd.exe does not split on `;`.
    const cli = ws.write(
      "seed-cli.cjs",
      `require("child_process").execFileSync(process.execPath, ["-e", "console.error('seed-cli: 401'); process.exit(3)"], { stdio: ["ignore", "pipe", "pipe"] });`
    );
    const shapes: [string, string, string][] = [
      [
        "node-throws",
        `set -euo pipefail\n${node} -e 'throw new Error("seed API returned 401")'`,
        "Error: seed API returned 401",
      ],
      [
        "node-cause",
        `${node} -e 'throw new Error("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:1") })'`,
        "[cause]: Error: connect ECONNREFUSED 127.0.0.1:1",
      ],
      ["node-value", `${node} -e 'throw "seed failed"'`, "seed failed"],
      ["node-exec", `${node} ${JSON.stringify(cli.replace(/\\/g, "/"))}`, "seed-cli: 401"],
      ["node-assert", `${node} -e 'require("assert").strictEqual(1, 2)'`, "1 !== 2"],
      [
        "node-deep",
        `${node} -e 'require("assert").deepStrictEqual({ a: 1, b: [1, 2] }, { a: 2, b: [1, 2] })'`,
        "AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:",
      ],
      [
        "node-dump",
        `${node} -e 'const e = new Error("[\\n  { \\"path\\": [\\"PORT\\"] }\\n]"); e.name = "ZodError"; throw e'`,
        "ZodError: [",
      ],
      [
        "node-event",
        `${node} -e 'require("child_process").spawn("no-such-cmd-xyz")'`,
        "Error: spawn no-such-cmd-xyz ENOENT",
      ],
      [
        "node-pointer",
        `${node} -e 'throw new Error("bad indent at line 4:\\n\\n d: 3\\n^")'`,
        "Error: bad indent at line 4:",
      ],
      [
        "node-props",
        `${node} -e 'const e = new Error("seed API returned 401"); for (let i = 0; i < 200; i++) e["p" + i] = i; throw e'`,
        "Error: seed API returned 401",
      ],
      [
        "node-color",
        `FORCE_COLOR=1 ${node} -e 'throw new Error("seed API returned 401")'`,
        "Error: seed API returned 401",
      ],
      [
        "bun-framed",
        `printf '1 | throw new Error("x")\\n    ^\\nerror: seed API returned 401\\n      at /p/seed.mjs:1:7\\n\\nBun v1.3.14 (macOS arm64)\\n' >&2\nexit 1`,
        "error: seed API returned 401",
      ],
      [
        "bun-bare",
        `printf 'seeding\\nerror: Unable to connect\\n  code: "ConnectionRefused"\\n\\n\\nBun v1.3.14 (Linux x64 baseline)\\n' >&2\nexit 1`,
        "error: Unable to connect",
      ],
      [
        "npm-usage",
        `for i in $(seq 1 40); do echo "progress $i" >&2; done
         printf 'npm error code EUSAGE\\nnpm error\\nnpm error The npm ci command needs a package-lock.json\\n' >&2
         for i in $(seq 1 95); do echo "npm error   --option-$i" >&2; done
         echo "npm error A complete log of this run can be found in: /h/1-debug-0.log" >&2
         exit 1`,
        "npm error The npm ci command needs a package-lock.json",
      ],
      [
        "npm-404",
        `printf 'npm ERR! code E404\\nnpm ERR! 404 Not Found - GET https://registry.npmjs.org/nope\\nnpm ERR! 404\\n\\nnpm ERR! A complete log of this run can be found in: /h/.npm/_logs/1-debug-0.log\\n' >&2\nexit 1`,
        "npm ERR! 404 Not Found - GET https://registry.npmjs.org/nope",
      ],
      [
        "npm-enoent",
        `printf 'npm ERR! code ENOENT\\nnpm ERR! syscall open\\nnpm ERR! path /p/package.json\\nnpm ERR! enoent Could not read package.json\\nnpm ERR! A complete log of this run can be found in:\\nnpm ERR!     /h/.npm/_logs/1-debug.log\\n' >&2\nexit 1`,
        "npm ERR! enoent Could not read package.json",
      ],
    ];
    for (const [name, source, line] of shapes) {
      const result = await runBash(ws, name, source);
      expect(result.failure?.message, name).toMatch(reason(line));
      // The trailer really was there to be skipped.
      if (name === "node-throws") expect(result.log).toMatch(/Node\.js v\d+/);
    }
  }, 120_000);

  // The log stops at its limit and the reason does not. The short line in
  // front moves the cut off the edge of a pipe chunk.
  it("takes the last line after a stderr flood past the log's limit", async () => {
    const result = await runBash(
      workspace(),
      "flood-then-reason",
      `echo "starting the flood" >&2
       head -c ${SCRIPT_STEP_LOG_LIMIT_BYTES * 2} /dev/zero | tr '\\0' 'e' >&2
       printf '\\nthe orders API answered 503\\n' >&2
       exit 1`
    );
    expect(result.failure?.message).toMatch(reason("the orders API answered 503"));
    expect(result.logTruncated).toBe(true);
    expect(Buffer.byteLength(result.log)).toBeLessThanOrEqual(SCRIPT_STEP_LOG_LIMIT_BYTES);
    expect(result.log).not.toContain("503");
  }, 30_000);

  // The line is for a script that chose to exit non-zero; on any other verdict
  // what it last said is what it was doing, not why it stopped.
  it.each([
    [
      "a time limit",
      "timeout",
      `echo "still waiting on the orders API" >&2\nwhile true; do sleep 1; done`,
      { timeoutMs: 1_000 },
    ],
    ...(posix
      ? [
          [
            "a signal death",
            "signal",
            `echo "still waiting on the orders API" >&2\nkill -KILL $$`,
            {},
          ],
        ]
      : []),
    [
      "a document it could not use",
      "output",
      `echo "still waiting on the orders API" >&2\nprintf 'not json' > "$ARGENT_OUTPUT"`,
      {},
    ],
  ] as [string, string, string, Partial<FlowScriptRequest>][])(
    "adds no stderr line to %s",
    async (_label, kind, source, extras) => {
      const result = await runBash(workspace(), "no-line", source, extras);
      expect(result.failure?.kind).toBe(kind);
      expect(result.failure?.message).not.toContain("still waiting");
    },
    30_000
  );

  // The head of the line and a count of the rest, measured on the whole line
  // however many chunks it came in, and never splitting a character.
  it.each([
    [
      "a long line",
      `head -c 40000 /dev/zero | tr '\\0' 'x' >&2\nexit 1`,
      `${"x".repeat(1_000)}… [39000 more characters omitted]`,
    ],
    // Counted before the leading whitespace is trimmed: 400 spaces leave 600.
    [
      "a long line behind leading whitespace",
      `set -euo pipefail
       {
         head -c 400 /dev/zero | LC_ALL=C tr '\\0' ' '
         head -c 5000 /dev/zero | LC_ALL=C tr '\\0' 'Z'
       } >&2
       exit 9`,
      `${"Z".repeat(600)}… [4400 more characters omitted]`,
    ],
    // A euro sign split across two reads by the pause; octal escapes because
    // bash 3.2 has no `\u`.
    [
      "a long multi-byte line",
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
       exit 2`,
      `${"\u20ACab".repeat(400).slice(0, 1_000)}… [200 more characters omitted]`,
    ],
    // One unit ahead of the emoji puts the cut between the halves of the 500th.
    [
      "a line whose cut falls inside an astral character",
      `printf 'a' >&2
       i=0
       while [ $i -lt 9000 ]; do printf '\\360\\237\\230\\200' >&2; i=$((i + 1)); done
       exit 1`,
      `a${"\u{1F600}".repeat(499)}… [17002 more characters omitted]`,
    ],
  ])(
    "keeps the head of %s and counts the rest",
    async (_label, source, tail) => {
      const result = await runBash(workspace(), "long-reason", source);
      const message = result.failure?.message ?? "";
      expect(result.failure?.kind).toBe("exit");
      expect(message.isWellFormed()).toBe(true);
      expect(message).not.toContain("\uFFFD");
      expect(message.slice(-(tail.length + 3))).toBe(`). ${tail}`);
    },
    30_000
  );

  it("hints at the two exit codes that are bash's own, not the script's", async () => {
    const ws = workspace();
    const missing = await runBash(ws, "missing-tool", `argent-no-such-command-here`);
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
    // An unreadable script exits 126 too, and `chmod +x` is not its remedy.
    expect(notExecutable.failure?.message).toContain("may not READ");
    expect(notExecutable.failure?.message).toContain("not executable");
  }, 60_000);
});

describe("a bash step and the jobs it leaves running", () => {
  // A job still holds stderr when bash exits; what it writes then is in the log
  // and is not why the script failed.
  onPosix.each([
    [
      "its answer to Argent's own stop",
      `( trap 'echo "helper: stopping" >&2; exit 0' TERM
         while true; do sleep 0.05; done ) &`,
      "helper: stopping",
    ],
    [
      "a line soon after bash exits",
      `( sleep 0.3; echo "mock-server: listening on :8080" >&2; sleep 30 ) &`,
      "mock-server: listening on :8080",
    ],
    // stdout chatter must not stretch the wait into the job's later stderr line.
    [
      "a line after stderr went quiet, while chattering on stdout",
      `( for i in $(seq 1 10); do echo "[mock] GET /health 200"; sleep 0.1; done
         echo "mock-server: listening on :8080" >&2
         while true; do echo "[mock] GET /health 200"; sleep 0.1; done ) &`,
      "mock-server: listening on :8080",
    ],
  ])(
    "keeps out of the reason %s",
    async (_label, job, jobLine) => {
      const result = await runBash(
        workspace(),
        "job",
        `${job}
         echo "seed failed: orders API answered 503" >&2
         exit 1`
      );
      expect(result.failure?.kind).toBe("exit");
      expect(result.failure?.message).toMatch(reason("seed failed: orders API answered 503"));
      expect(result.log).toContain(`${jobLine}\n`);
    },
    30_000
  );

  // A consumer in front of stderr (the timestamp idiom) delivers the script's
  // own error after bash exits, and closes stderr once it has.
  onPosix(
    "keeps what a stderr consumer writes after bash exits",
    async () => {
      const result = await runBash(
        workspace(),
        "slow-consumer",
        `exec 2> >(while IFS= read -r l; do sleep 0.02; printf '%s\\n' "$l"; done >&2)
         for i in $(seq 1 40); do echo "progress line $i" >&2; done
         echo "FATAL: the real error" >&2
         exit 1`
      );
      expect(result.failure?.message).toMatch(reason("FATAL: the real error"));
      expect(result.log).toContain("progress line 40\n");
      expect(result.logTruncated).toBe(false);
    },
    30_000
  );

  // A job that never stops writing: Argent stops reading at the limit and says
  // so. The job starts a moment after bash exits, so a stall here cannot put
  // its line in the reason.
  onPosix(
    "marks the log cut when a job is still writing at the limit",
    async () => {
      const result = await runBash(
        workspace(),
        "chatty-job",
        `( sleep 0.3; while true; do echo "[logcat] heartbeat" >&2; sleep 0.05; done ) &
         echo "the orders API answered 503" >&2
         exit 1`
      );
      expect(result.failure?.message).toMatch(reason("the orders API answered 503"));
      expect(result.logTruncated).toBe(true);
      expect(result.notes.join(" ")).toContain("was still writing to the log");
      expect(result.durationMs).toBeLessThan(15_000);
    },
    30_000
  );

  /** A consumer that delivers the error a tenth of a second per line late. */
  function lateConsumer(ws: ScriptWorkspace, name: string): { script: string; exited: string } {
    const exited = ws.resolve(`${name}.exited`);
    const script = ws.write(
      `${name}.sh`,
      `exec 2> >(while IFS= read -r l; do sleep 0.1; printf '%s\\n' "$l"; done >&2)
       echo "step 1: seeding" >&2
       echo "FATAL: the real error" >&2
       touch ${JSON.stringify(exited)}
       exit 1`
    );
    return { script, exited };
  }

  // A stall that runs from before the error arrives until past the quiet mark,
  // inside an I/O callback where a synchronous request handler runs: the quiet
  // timer then fires before the poll that reads the consumer's line.
  onPosix(
    "keeps the late line when the loop stalls across the quiet mark",
    async () => {
      const ws = workspace();
      const { script, exited } = lateConsumer(ws, "stall");
      const pending = executor().execute({
        scriptPath: script,
        interpreter: "bash",
        projectRoot: ws.dir,
      });
      await untilExists(exited);
      await delay(150);
      await new Promise<void>((resolve) =>
        fs.stat(exited, () => {
          const until = Date.now() + 700;
          while (Date.now() < until) {
            /* the stall */
          }
          resolve();
        })
      );

      expect((await pending).failure?.message).toMatch(reason("FATAL: the real error"));
    },
    30_000
  );

  // A cancel before the consumer wrote the error still waits the first settle.
  onPosix(
    "keeps a consumer's late line when a cancel lands before it is written",
    async () => {
      const ws = workspace();
      const { script, exited } = lateConsumer(ws, "cancel-early");
      const cancel = new AbortController();
      const pending = executor().execute({
        scriptPath: script,
        interpreter: "bash",
        projectRoot: ws.dir,
        signal: cancel.signal,
      });
      await untilExists(exited);
      await delay(150);
      cancel.abort();
      const result = await pending;

      expect(result.failure?.kind).toBe("exit");
      expect(result.failure?.message).toMatch(reason("FATAL: the real error"));
    },
    30_000
  );

  // Past the script's exit a cancelled run has no use for the wait.
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
      await untilExists(exited);
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

  // A writer that left the group and lost its parent outlives the stop.
  onPosix(
    "still marks the log cut when a run cancelled mid-script leaves a writer",
    async () => {
      const ws = workspace();
      const pidFile = ws.resolve("writer.pid");
      const script = ws.write(
        "cancel-midscript.sh",
        `set -m
         ( ( while true; do echo tick >&2; sleep 0.05; done ) &
           echo $! > ${JSON.stringify(pidFile)} )
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
});

describe("a bash step checked out with CRLF", () => {
  // The carriage return lands in the redirection's last word, so the document
  // is written one name away and exit 0 returns the parent's own seed. msys2
  // (Git Bash) names that stray U+F00D, as it cannot put a control character
  // in a file name; it also drops a CR from each line it reads, so the CRLF
  // file itself is POSIX only.
  it.each([
    ...(posix
      ? [["a carriage return", `printf '%s' '{"seeded":true}' > "$ARGENT_OUTPUT"\r\n`]]
      : []),
    ["U+F00D", `printf '%s' '{"seeded":true}' > "$ARGENT_OUTPUT"$'\uf00d'`],
  ])(
    "refuses an exit 0 whose redirection landed %s away",
    async (_label, source) => {
      const result = await runBash(workspace(), "crlf", source);
      expect(result.ok).toBe(false);
      expect(result.failure?.kind).toBe("output");
      expect(result.failure?.message).toContain("CRLF");
      expect(result.failure?.message).toContain("$ARGENT_OUTPUT");
    },
    30_000
  );

  // GNU bash 5.x spells the name `$'\r'`; Apple's 3.2 writes the CR itself.
  onPosix(
    "hands a CRLF script's own bash error to the reason and to the log",
    async () => {
      const result = await runBash(workspace(), "crlf-blank", "echo start\r\n\r\n");

      const said = /crlf-blank\.sh: line 2: (\$'\\r'|\r): command not found/;
      expect(result.failure?.message).toContain("code 127");
      expect(result.failure?.message).toMatch(new RegExp(`${said.source}$`));
      expect(result.log).toMatch(said);
    },
    30_000
  );

  it("keeps the document of a script that also left a stray sibling", async () => {
    // Git Bash names a stray carriage return with U+F00D (see the table above).
    const stray = posix ? "\r" : "\uF00D";
    const result = await runBash(
      workspace(),
      "stray-sibling",
      `printf '{"real":true}' > "$ARGENT_OUTPUT.t"
       mv "$ARGENT_OUTPUT.t" "$ARGENT_OUTPUT"
       : > "$ARGENT_OUTPUT"$'${stray}'`
    );

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ real: true });
  }, 30_000);
});

describe("a bash step and signals", () => {
  // 128+N is bash reporting a foreground command killed by signal N, a status
  // the script could have handled.
  onPosix(
    "reads a 128+N exit as the script's own status, not as a signal",
    async () => {
      const result = await runBash(
        workspace(),
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

  // The runner holds a signalled bash's answer in case the same signal is on
  // its way to the group, and only calls it a signal from outside once it has
  // waited for its own copy. That hold must stay inside a sub-second limit.
  onPosix.each([
    ["no", undefined],
    ["a 100ms", 100],
    ["a 900ms", 900],
  ] as [string, number | undefined][])(
    "reports bash killed by a signal as an error naming it, under %s time limit",
    async (_label, timeoutMs) => {
      const startedAt = Date.now();
      const result = await runBash(
        workspace(),
        "self-signalled",
        `kill -TERM $$; sleep 30`,
        timeoutMs === undefined ? {} : { timeoutMs }
      );

      expect(result.failure?.kind).toBe("signal");
      expect(result.failure?.message).toContain("SIGTERM");
      if (timeoutMs === undefined) expect(Date.now() - startedAt).toBeGreaterThanOrEqual(500);
    },
    30_000
  );

  // `trap 'kill 0' EXIT` reaps jobs and reaches the runner that leads the group
  // too. Which verdict follows is the bash's own (GNU 5.x dies with the group
  // and gets the `kill 0` guidance, Apple's 3.2 passes; for SIGQUIT, which 5.x
  // ignores and Node does not, the other way round). Never a signal from the
  // host.
  onPosix.each([
    ["SIGTERM", "kill 0", "exit", ["process group was sent SIGTERM", "kill 0"]],
    ["SIGQUIT", "kill -QUIT 0", undefined, ["kill 0"]],
  ] as [string, string, string | undefined, string[]][])(
    "reads a %s the script sent its own group as the script's own answer",
    async (_signal, kill, kind, says) => {
      const result = await runBash(
        workspace(),
        "kill-group",
        `trap '${kill}' EXIT
       sleep 30 &
       ${writeDocument('{"seeded":true}')}`
      );
      expect(result.failure?.message ?? "").not.toContain("did not stop itself");
      if (result.ok) {
        expect(result.output).toEqual({ seeded: true });
      } else {
        if (kind) expect(result.failure?.kind).toBe(kind);
        for (const fragment of says) expect(result.failure?.message).toContain(fragment);
      }
    },
    30_000
  );

  // The signal and bash's exit reach the runner with no order between them,
  // so a decision taken too early lands on `signal` about one run in thirty.
  onPosix(
    "reads a group-wide kill the same way on every run",
    async () => {
      const ws = workspace();
      const script = ws.write(
        "kill-group-repeat.sh",
        `trap 'kill 0' EXIT
       sleep 30 &
       ${writeDocument('{"seeded":true}')}`
      );
      const width = 8;
      const runs = executor({ concurrency: width });
      const kinds = new Set<string | undefined>();
      // In waves of the executor's width, so what is counted is the verdict
      // and not the queue.
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

  // A `kill 0` in the body kills bash; whether it also reaches the runner is
  // the platform's call. Either way the message names `kill 0` and the remedy.
  onPosix(
    "names a self-sent group kill in the message, whichever process it reached",
    async () => {
      const result = await runBash(workspace(), "kill-group-body", `kill -TERM 0\nsleep 30`);
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

  // The runner leads the group, so `-$$` names a group that does not exist
  // and the guidance must not offer it.
  onPosix(
    "lets `kill -- -$$` reach nothing, so the step passes",
    async () => {
      const result = await runBash(
        workspace(),
        "kill-dash-dollar",
        `trap 'kill -- -$$' EXIT
       ${writeDocument('{"ran":true}')}`
      );

      expect(result.failure).toBeUndefined();
      expect(result.output).toEqual({ ran: true });
    },
    30_000
  );

  // A script whose first line ends the runner can beat a `started` sent late,
  // and must never read as one that did not start.
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
});

describe("the runner's own channels in bash mode", () => {
  // 3 is the parent's sink, 4 the lifeline and 5 the protocol channel. Each
  // write has to SUCCEED and reach nothing: a closed descriptor gives the same
  // document under `set +e`.
  onPosix(
    "gives bash writable null devices where its own channels are, so no write can forge a verdict",
    async () => {
      const forged = '{"type":"result","outputJson":"{\\"forged\\":true}"}';
      const result = await runBash(
        workspace(),
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
    const result = await runBash(
      workspace(),
      "stdin",
      `set +e
       if read -r line; then status=read; else status=eof; fi
       printf '{"stdin":"%s"}' "$status" > "$ARGENT_OUTPUT"
       exit 0`
    );
    expect(result.output).toEqual({ stdin: "eof" });
  }, 30_000);

  // Past the log's limit the pipe is still drained: a paused one would block
  // the script on its next write until the time limit.
  it("survives a flood on stdout, keeping only the head of it in the log", async () => {
    const result = await runBash(
      workspace(),
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

  // The runner's terminal message is classified ahead of the stderr scan.
  it("reads a child's V8 heap banner as the script's exit code, not as a heap limit", async () => {
    const result = await runBash(
      workspace(),
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
  // The lookup runs before the step's timer is armed, so its time is outside
  // `timeout`, and only this note tells the author where it went.
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

  // The request's abort reaches the lookup itself, not only the check after it.
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
      // The probe's own timeout plus its grace is six seconds.
      expect(Date.now() - startedAt).toBeLessThan(4_000);
    },
    30_000
  );

  // An unparseable global document reads as an empty one, so the step runs
  // the PATH bash and has to say why `scripts.bash` did not apply.
  onPosix(
    "says the global configuration was not read when it could not be parsed",
    async () => {
      const ws = workspace();
      const script = ws.write("lost.sh", `printf '{"ok":true}' > "$ARGENT_OUTPUT"`);

      const result = await withSearchPath(
        path.dirname(hostBash),
        () => executor().execute({ scriptPath: script, interpreter: "bash", projectRoot: ws.dir }),
        '{"scripts":{"bash":"/bin/ba'
      );

      expect(result.ok).toBe(true);
      expect(result.notes.join(" ")).toContain("global configuration was not read");
    },
    30_000
  );

  // A version-manager shim picks its bash from the directory it starts in.
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

  // The resolver's check runs the candidate, so it can still be gone by the
  // time the runner spawns it. This one answers the check and removes itself.
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
          executor().execute({ scriptPath: script, interpreter: "bash", projectRoot: project })
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

describe("environment and working directory", () => {
  it("gives the script the same allowlist a .mjs gets, plus the exchange name", async () => {
    const result = await runBash(
      workspace(),
      "printenv",
      `set -euo pipefail
       printf '{"names":"%s"}' "$(printenv | sed 's/=.*//' | sort | tr '\\n' ' ')" > "$ARGENT_OUTPUT"`
    );
    const names = String((result.output as { names: string }).names).split(" ");
    expect(names).toContain("PATH");
    expect(names).toContain("ARGENT_OUTPUT");
    expect(names).not.toContain("ARGENT_FLOW_SCRIPT_RUNNER");
    expect(names).not.toContain("NODE_CHANNEL_FD");
    // Each of these steers bash, and none is in the allowlist.
    for (const name of ["BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "CDPATH", "GLOBIGNORE"]) {
      expect(names, name).not.toContain(name);
    }
  }, 30_000);

  it("refuses the exchange name in a caller's override map", async () => {
    const result = await runBash(workspace(), "env-output", `exit 0`, {
      env: { ARGENT_OUTPUT: "/tmp/x" },
    });
    expect(result.failure?.kind).toBe("invalid");
    expect(result.failure?.message).toContain("ARGENT_OUTPUT");
  }, 30_000);

  // Two marker files rather than path strings: under Git Bash `$PWD` is a
  // `/c/…` path no Node call can stat.
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
  // The runner leads the group bash and its jobs join. A job that left the
  // group (GNU `timeout`, `set -m`) is found by its parentage; a daemon in a
  // session of its own is left alone. On a stall the parent's timer cannot
  // run, so the child's deadline watchdog stops the tree, after its margin.
  it.each([
    ["its time limit", "timeout"],
    ["a cancel", "cancelled"],
    ["the deadline while the tool server stalls", "timeout"],
  ])(
    "stops the whole tree at %s",
    async (on, kind) => {
      const ws = workspace();
      const inGroupFile = ws.resolve("in-group.pid");
      const ownGroupFile = ws.resolve("own-group.pid");
      const daemonFile = ws.resolve("daemon.pid");
      const node = JSON.stringify(process.execPath);
      const launcher = `const d = require("child_process").spawn("sleep", ["300"], { detached: true, stdio: "ignore" }); require("fs").writeFileSync(${JSON.stringify(daemonFile)}, String(d.pid)); setInterval(() => {}, 1000);`;
      const posixJobs = posix
        ? `${node} -e '${launcher}' &
           set -m
           sleep 300 &
           echo $! > ${JSON.stringify(ownGroupFile)}
           set +m`
        : "";
      const script = ws.write(
        "tree.sh",
        `${backgroundJob(inGroupFile)}
         ${posixJobs}
         while true; do sleep 1; done`
      );
      const timeoutMs = kind === "cancelled" ? 30_000 : 2_000;
      const cancel = new AbortController();
      const startedAt = Date.now();
      const pending = executor().execute({
        scriptPath: script,
        interpreter: "bash",
        projectRoot: ws.dir,
        timeoutMs,
        signal: cancel.signal,
      });
      const tree = [await readPidFile(inGroupFile)];
      if (posix) tree.push(await readPidFile(ownGroupFile));
      const daemon = posix ? await readPidFile(daemonFile) : undefined;
      strays.push(...tree, ...(daemon === undefined ? [] : [daemon]));
      expect(tree.every(isAlive)).toBe(true);

      if (kind === "cancelled") cancel.abort();
      if (on.includes("stalls")) {
        const blockUntil = (afterDeadlineMs: number) => {
          while (Date.now() - startedAt < timeoutMs + afterDeadlineMs) {
            /* block */
          }
        };
        blockUntil(1_200);
        expect(tree.every(isAlive)).toBe(true);
        blockUntil(3_500);
        expect(tree.some(isAlive)).toBe(false);
      }
      const result = await pending;

      expect(result.failure).toMatchObject({ kind });
      // A cancel after the fork leaves state to clean up.
      if (kind === "cancelled") expect(result.failure?.beforeFork).toBeUndefined();
      for (const pid of tree) expect(await waitForExit(pid, 10_000)).toBe(true);
      if (daemon !== undefined) expect(isAlive(daemon)).toBe(true);
    },
    60_000
  );

  // The runner holds the group SIGTERM in bash mode and a trapping script runs
  // on, so the escalation to SIGKILL is what empties the group.
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

  onPosix(
    "returns the document of a script that exits 0 with a job still running, and stops the job",
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

  // Read from inside the step, because the directory is gone once it returns.
  // The root holds a space, as Windows' `%TEMP%` under `C:\Users\First Last`
  // does, and the document may hold values derived from a secret, where a bare
  // write would leave its mode to the umask.
  it("holds the document and nothing else, for its owner alone, under any root", async () => {
    const ws = workspace();
    const spaced = path.join(ws.dir, "dir with space");
    fs.mkdirSync(spaced, { recursive: true });
    const result = await runBash(
      ws,
      "listing",
      `set -euo pipefail
       dir="$(dirname "$ARGENT_OUTPUT")"
       held="$(ls -A "$dir" | tr '\\n' ' ')"
       # GNU first: GNU \`stat -f\` prints to stdout before the fallback runs.
       mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }
       printf '{"where":"%s","held":"%s","output":"%s","dir":"%s"}' \\
         "$dir" "$held" "$(mode "$ARGENT_OUTPUT")" "$(mode "$dir")" > "$ARGENT_OUTPUT.t"
       mv "$ARGENT_OUTPUT.t" "$ARGENT_OUTPUT"`,
      {},
      { exchangeRoot: spaced }
    );

    expect(result.ok).toBe(true);
    expect(String(result.output?.where)).toContain("dir with space");
    expect(result.output?.held).toBe("output.json ");
    if (posix) expect(result.output).toMatchObject({ output: "600", dir: "700" });
    expect(fs.readdirSync(spaced)).toEqual([]);
  }, 30_000);
});

describe("what a step reports before anything is forked", () => {
  // Resolving bash suspends, and a cancel raised across it must be seen
  // before the fork, not after the script's first lines ran.
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
      // After `execute` started, so the abort lands inside the lookup.
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
        executor().execute({ scriptPath: script, interpreter: "bash", projectRoot: project })
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
  // Bash mode forks the runner as the entry module, from a directory holding
  // only the three `.mjs` the bundle copies.
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
  /**
   * A runner forked directly and sent one bash request, because the executor
   * closes the channel and the lifeline only once the step is over.
   */
  function forkBashRunner(ws: ScriptWorkspace, script: string) {
    const exchange = fs.mkdtempSync(path.join(exchangeRoot, "direct-"));
    const outputFile = path.join(exchange, "output.json");
    fs.writeFileSync(outputFile, "{}");
    const runner = fork(path.join(SOURCE_RUNNER_DIR, "flow-script-runner.mjs"), [], {
      cwd: ws.dir,
      env: { ...process.env, ARGENT_FLOW_SCRIPT_RUNNER: "1" },
      execArgv: [],
      stdio: ["ignore", "pipe", "pipe", "ignore", "pipe", "ipc"],
      detached: true,
    });
    runner.stdout?.resume();
    runner.stderr?.resume();
    const exited = new Promise<void>((resolve) => runner.once("exit", () => resolve()));
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
    return {
      runner,
      exited,
      cleanup() {
        runner.kill("SIGKILL");
        fs.rmSync(exchange, { recursive: true, force: true });
      },
    };
  }

  /** Writes bash's pid, a job's, and a `set -m` job's, then waits. */
  function treeScript(ws: ScriptWorkspace, files: { bash: string; job: string; ownGroup: string }) {
    return `sleep 300 &
       echo $! > ${JSON.stringify(files.job)}
       set -m
       sleep 300 &
       echo $! > ${JSON.stringify(files.ownGroup)}
       set +m
       echo $PPID > ${JSON.stringify(ws.resolve("runner.pid"))}
       echo $$ > ${JSON.stringify(files.bash)}
       while true; do sleep 1; done`;
  }

  // The IPC channel closes while the lifeline stays open, so the runner's own
  // `disconnect` handler is what reaps the tree.
  onPosix(
    "takes bash and its descendants when only the channel closes",
    async () => {
      const ws = workspace();
      const files = {
        bash: ws.resolve("bash.pid"),
        job: ws.resolve("job.pid"),
        ownGroup: ws.resolve("own-group.pid"),
      };
      const direct = forkBashRunner(ws, ws.write("disconnect.sh", treeScript(ws, files)));
      try {
        const pids = [
          await readPidFile(files.bash, 40_000),
          await readPidFile(files.job, 40_000),
          await readPidFile(files.ownGroup, 40_000),
        ];
        strays.push(...pids);
        expect(isAlive(pids[0]!)).toBe(true);

        direct.runner.disconnect();

        for (const pid of pids) expect(await waitForExit(pid, 20_000)).toBe(true);
        await direct.exited;
      } finally {
        direct.cleanup();
      }
    },
    90_000
  );

  // The channel stays open, so only the lifeline answers. Runs on Windows too,
  // where the watchdog takes the tree with `taskkill /t`; the descendant's pid
  // comes from Node because `$!` in Git Bash is an MSYS number.
  it("reaps bash and its descendants when only the lifeline descriptor closes", async () => {
    const ws = workspace();
    const descendantFile = ws.resolve("lifeline-descendant.pid");
    const direct = forkBashRunner(
      ws,
      ws.write("lifeline.sh", `${backgroundJob(descendantFile)}\nwhile true; do sleep 1; done`)
    );
    try {
      const descendant = await readPidFile(descendantFile, 40_000);
      strays.push(descendant);
      expect(isAlive(descendant)).toBe(true);

      (direct.runner.stdio[4] as NodeJS.WritableStream & { destroy?: () => void }).destroy?.();

      expect(await waitForExit(descendant, 20_000)).toBe(true);
      await direct.exited;
    } finally {
      direct.cleanup();
    }
  }, 90_000);

  onPosix(
    "takes bash, its descendants and the runner when the tool server is killed",
    async () => {
      const ws = workspace();
      const files = {
        bash: ws.resolve("bash.pid"),
        job: ws.resolve("job.pid"),
        ownGroup: ws.resolve("own-group.pid"),
      };
      const runnerFile = ws.resolve("runner.pid");
      const script = ws.write("orphan.sh", treeScript(ws, files));
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
      // Drained, so the driver cannot block on it and its crash reads as itself.
      let driverStderr = "";
      parent.stderr?.setEncoding("utf8");
      parent.stderr?.on("data", (chunk: string) => {
        driverStderr += chunk;
      });
      const written = [files.bash, files.job, runnerFile, files.ownGroup];
      try {
        const pids: number[] = [];
        for (const file of written) pids.push(await readPidFile(file, 40_000, () => driverStderr));
        strays.push(...pids);
        expect(pids.every(isAlive)).toBe(true);

        parent.kill("SIGKILL");
        for (const pid of pids) expect(await waitForExit(pid, 20_000)).toBe(true);
      } finally {
        parent.kill("SIGKILL");
        for (const file of written) {
          try {
            const pid = Number(fs.readFileSync(file, "utf8").trim());
            if (Number.isInteger(pid)) strays.push(pid);
          } catch {
            // Never written, so there is nothing to reap.
          }
        }
      }
    },
    90_000
  );
});
