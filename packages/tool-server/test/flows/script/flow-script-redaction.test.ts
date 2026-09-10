import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  FlowScriptExecutor,
  type FlowScriptExecutorOptions,
  type FlowScriptSecret,
} from "../../../src/tools/flows/script/flow-script-executor";
import { SCRIPT_MAX_FAILURE_MESSAGE_CHARS } from "../../../src/tools/flows/script/flow-script-protocol";
import { resolveHostBash } from "../../helpers/host-bash";
import { createScriptWorkspace, type ScriptWorkspace } from "../../helpers/flow-script-workspace";

const workspaces: ScriptWorkspace[] = [];

function workspace(): ScriptWorkspace {
  const ws = createScriptWorkspace("redact");
  workspaces.push(ws);
  return ws;
}

const longRoots: string[] = [];

afterEach(() => {
  while (workspaces.length) workspaces.pop()!.cleanup();
  while (longRoots.length) fs.rmSync(longRoots.pop()!, { recursive: true, force: true });
});

/**
 * A second name for the host's bash, of a chosen length. The resolver reports
 * `scripts.bash` verbatim, so the length of the configured value is the length
 * of what rides in the exit line of every failure message. Nested directories
 * rather than one long name, because a single path component is capped at 255
 * bytes.
 */
function bashAtPathOfLength(bash: string, chars: number): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "argent-long-bash-"));
  longRoots.push(root);
  let dir = root;
  while (chars - dir.length - 1 > 255) dir = path.join(dir, "d".repeat(200));
  const link = path.join(dir, "b".repeat(chars - dir.length - 1));
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(bash, link);
  return link;
}

/**
 * `scripts.bash` for the duration of `body`, in a home directory of the test's
 * own.
 *
 * The GLOBAL document, because that is the only scope the key takes: a helper
 * that wrote `<ws>/.argent/config.json` pinned nothing — `readScopeValue`
 * returns before a project file is read — so the case below ran under the
 * host's ordinary short bash path and never reached the branch it exists for.
 */
async function withPinnedBash<T>(bash: string, body: () => Promise<T>): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "argent-redaction-home-"));
  const real = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  fs.mkdirSync(path.join(home, ".argent"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".argent", "config.json"),
    JSON.stringify({ scripts: { bash } }),
    "utf8"
  );
  process.env.HOME = home;
  process.env.USERPROFILE = home;
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

function executor(options: FlowScriptExecutorOptions = {}) {
  return new FlowScriptExecutor({ concurrency: 4, maxTimeoutMs: 60_000, ...options });
}

/**
 * A bash step reaches redaction through a different channel from a `.mjs` one:
 * its failure text ends with the last line the script wrote to stderr, which
 * the parent reads off the pipe and appends to the runner's exit line, and its
 * document is a file rather than a value the runner encoded.
 */
describe("flow script executor — redaction of a bash step", () => {
  const SECRET: FlowScriptSecret = { name: "API_KEY", value: "s3cr3t-token-value" };
  /**
   * How much of that stderr line the reason keeps, in step with
   * `STDERR_REASON_LINE_CHARS` in `flow-script-executor.ts`, which does not
   * export it.
   */
  const STDERR_LINE_CHARS = 1_000;

  let noBash: string | undefined;
  let hostBash = "";

  beforeAll(async () => {
    const found = await resolveHostBash();
    if ("path" in found) hostBash = found.path;
    else noBash = found.problem;
  });

  beforeEach((ctx) => {
    if (noBash) ctx.skip(`this host has no bash to run a .sh step with: ${noBash}`);
  });

  it("replaces a secret the script wrote to stderr, in the reason and in the log", async () => {
    const ws = workspace();
    const script = ws.write(
      "reason.sh",
      `printf 'the call to %s failed\\n' "$API_KEY" >&2
       exit 4`
    );
    const result = await executor().execute({
      scriptPath: script,
      interpreter: "bash",
      projectRoot: ws.dir,
      env: { API_KEY: SECRET.value },
      secrets: [SECRET],
    });

    expect(result.failure?.kind).toBe("exit");
    expect(result.failure?.message).not.toContain(SECRET.value);
    expect(result.failure?.message).toContain("the call to {{secret:API_KEY}} failed");
    expect(result.log).not.toContain(SECRET.value);
    expect(result.log).toContain("the call to {{secret:API_KEY}} failed");
  }, 30_000);

  // A PEM key or a service-account blob spans lines, and `echo "…$KEY" >&2` is
  // the idiomatic way to report one. The reason keeps only the LAST line the
  // script wrote to stderr — here the value's own closing line, with its
  // trailing newline left behind as a blank line — so no whole-value spelling
  // is in it to find. The log keeps every line.
  it("replaces every line of a multi-line secret, in the reason and in the log", async () => {
    const multiline: FlowScriptSecret = {
      name: "PEM",
      value: "-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkqhkiG9w0\n-----END PRIVATE KEY-----\n",
    };
    const ws = workspace();
    const script = ws.write(
      "edge-reason.sh",
      `echo "signing failed with key: $PEM" >&2
       exit 1`
    );
    const result = await executor().execute({
      scriptPath: script,
      interpreter: "bash",
      projectRoot: ws.dir,
      env: { PEM: multiline.value },
      secrets: [multiline],
    });

    const message = result.failure?.message ?? "";
    expect(result.failure?.kind).toBe("exit");
    expect(message).toMatch(/ \{\{secret:PEM}}$/);
    expect(result.log).toContain("signing failed with key: {{secret:PEM}}");
    for (const line of multiline.value.split("\n").filter(Boolean)) {
      expect(message).not.toContain(line);
      expect(result.log).not.toContain(line);
    }
  }, 30_000);

  // The document is the script's ANSWER, read by later steps for the id or the
  // derived value the flow needs. Replacing a resolved secret inside it would
  // hand those steps `{{secret:NAME}}` — a string nothing downstream can use —
  // so it comes back exactly as the script wrote it. The reference and the
  // flow-authoring skill say not to put a credential there.
  it("leaves the output document as the script wrote it", async () => {
    const ws = workspace();
    const script = ws.write(
      "document.sh",
      `printf '{"auth":"Bearer %s"}' "$API_KEY" > "$ARGENT_OUTPUT.t"
       mv "$ARGENT_OUTPUT.t" "$ARGENT_OUTPUT"`
    );
    const result = await executor().execute({
      scriptPath: script,
      interpreter: "bash",
      projectRoot: ws.dir,
      env: { API_KEY: SECRET.value },
      secrets: [SECRET],
    });

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ auth: `Bearer ${SECRET.value}` });
  }, 30_000);

  // The document is not redacted, and the parse VERDICT on it must not quote it
  // either. One of V8's parse messages — and only one, the rest name a position
  // — hands back a window of the text: `Unexpected token 's', "s3cr3t-tok"… is
  // not valid JSON`. A window is a cut, so what it holds of a value is a
  // fragment, and a fragment matches no spelling a whole-value scrub looks for.
  it("quotes no window of the output document back", async () => {
    const ws = workspace();
    const script = ws.write("bad-output.sh", `printf '%s' "$API_KEY" > "$ARGENT_OUTPUT"`);
    const result = await executor().execute({
      scriptPath: script,
      interpreter: "bash",
      projectRoot: ws.dir,
      env: { API_KEY: SECRET.value },
      secrets: [SECRET],
    });

    const message = result.failure?.message ?? "";
    expect(message).toContain("did not parse");
    expect(message).toContain("is not valid JSON");
    // The reason V8 gave and the character it stopped on both stay; the window
    // is the only thing that goes.
    expect(message).toContain("Unexpected token 's'");
    expect(message).not.toContain(SECRET.value.slice(0, 6));
  }, 30_000);

  // A secret cut in half by a truncation is not a secret any scrub can find:
  // what is left is a PREFIX of one, which matches nothing. The parent drops
  // that tail wherever an omission marker ends the text, and the cut that keeps
  // only the head of a long stderr line ends the reason with one. This runs a
  // real script through the cut, the join and the redaction together, so a
  // marker the redaction stopped recognising fails here rather than leaking
  // there.
  it("drops the half of a secret the stderr line's cut left behind", async () => {
    const ws = workspace();
    // The padding stops ten characters short of the line cap, so the cut lands
    // INSIDE the secret and what survives is a prefix of one. One line, written
    // in three pieces, so it reaches the parent in more than one read.
    const pad = STDERR_LINE_CHARS - 10;
    const tail = 2_000;
    const script = ws.write(
      "long-line.sh",
      `printf '%${pad}s' '' | tr ' ' 'x' >&2
       printf '%s' "$API_KEY" >&2
       printf '%${tail}s' '' | tr ' ' 'y' >&2
       echo >&2
       exit 5`
    );
    const result = await executor().execute({
      scriptPath: script,
      interpreter: "bash",
      projectRoot: ws.dir,
      env: { API_KEY: SECRET.value },
      secrets: [SECRET],
    });

    const message = result.failure?.message ?? "";
    expect(result.failure?.kind).toBe("exit");
    // Every prefix of the value, down to the shortest that is still the
    // secret's own: none of them may survive the cut.
    for (let n = SECRET.value.length; n > 3; n -= 1) {
      expect(message).not.toContain(SECRET.value.slice(0, n));
    }
    // The half is counted with what the cut dropped, so the marker counts
    // everything from the secret on.
    const marker = `x… [${SECRET.value.length + tail} more characters omitted]`;
    expect(message.slice(-marker.length)).toBe(marker);
    // The log keeps the whole line, and so the whole value to replace.
    expect(result.log).not.toContain(SECRET.value);
    expect(result.log).toContain("x{{secret:API_KEY}}y");
  }, 30_000);

  /**
   * The interpreter path rides in the exit line in front of the stderr line,
   * and it is the one term in the message nothing bounds. A ceiling it can push
   * the message past cuts the line's own marker off the end — the marker the
   * parent reads to find where the line was cut, and so where half a secret
   * may be left. This is the same straddling secret as above, under a bash
   * whose path is as long as the whole line the reason keeps: the marker at
   * the end must still be the line's own, counting the half it dropped.
   *
   * POSIX only. The path is a symlink of 1,000 characters, and Windows refuses
   * both without a per-machine opt-in.
   */
  it.skipIf(process.platform === "win32")(
    "keeps the stderr line's own marker when the interpreter path is long",
    async () => {
      const ws = workspace();
      // Inside PATH_MAX, which is 1024 on macOS.
      const pinned = bashAtPathOfLength(hostBash, STDERR_LINE_CHARS);

      const pad = STDERR_LINE_CHARS - 10;
      const tail = 2_000;
      const script = ws.write(
        "long-line-long-bash.sh",
        `printf '%${pad}s' '' | tr ' ' 'x' >&2
         printf '%s' "$API_KEY" >&2
         printf '%${tail}s' '' | tr ' ' 'y' >&2
         echo >&2
         exit 5`
      );
      const result = await withPinnedBash(pinned, () =>
        executor().execute({
          scriptPath: script,
          interpreter: "bash",
          projectRoot: ws.dir,
          env: { API_KEY: SECRET.value },
          secrets: [SECRET],
        })
      );

      const message = result.failure?.message ?? "";
      expect(result.failure?.kind).toBe("exit");
      // The pin is what makes the exit line long, so a pin that did not apply
      // leaves this case asserting nothing the one above does not.
      expect(message).toContain(pinned);
      expect(message.length).toBeLessThanOrEqual(SCRIPT_MAX_FAILURE_MESSAGE_CHARS);
      const marker = `x… [${SECRET.value.length + tail} more characters omitted]`;
      expect(message.slice(-marker.length)).toBe(marker);
      for (let n = SECRET.value.length; n > 3; n -= 1) {
        expect(message).not.toContain(SECRET.value.slice(0, n));
      }
    },
    30_000
  );

  // `printf %q` is bash's own quoter and the idiomatic way for a `.sh` step to
  // report the argument it sent. It backslashes a SPACE, and no spelling in the
  // list rewrites one: the JSON, single-quoted and backtick bodies all leave a
  // space alone, and the URI encoders write `%20` or `+`. So `sk live …`
  // arrived as `sk\ live\ …` and the whole-value scrub matched nothing.
  // `repairBackslashEscapes` is the only pass that answers it, and the `.mjs`
  // case that names an escaper holds quotes and a backslash — which the
  // backtick spelling already covers, so it passes with that repair removed.
  it("replaces a value bash's own printf %q backslashed", async () => {
    const spaced: FlowScriptSecret = { name: "SPACED", value: "sk live 9d3f0a1bcdef" };
    const ws = workspace();
    const script = ws.write(
      "quoted-reason.sh",
      `printf %q "$SPACED" >&2
       exit 1`
    );
    const result = await executor().execute({
      scriptPath: script,
      interpreter: "bash",
      projectRoot: ws.dir,
      env: { SPACED: spaced.value },
      secrets: [spaced],
    });

    const message = result.failure?.message ?? "";
    expect(result.failure?.kind).toBe("exit");
    expect(message).toContain("{{secret:SPACED}}");
    // The log holds the same line, and no spelling matches it there either: it
    // is the repair pass over the finished log that takes it.
    expect(result.log).toContain("{{secret:SPACED}}");
    // Raw and in the spelling the quoter wrote: the escaping is one `sed` away
    // from reversed, so leaving it is disclosure rather than obfuscation.
    for (let n = spaced.value.length; n >= 6; n -= 1) {
      for (let at = 0; at + n <= spaced.value.length; at += 1) {
        const part = spaced.value.slice(at, at + n);
        for (const text of [message, result.log]) {
          expect(text).not.toContain(part);
          expect(text).not.toContain(part.replace(/ /g, "\\ "));
        }
      }
    }
  }, 30_000);

  // The parent TRIMS the stderr line it keeps, so a secret that ends the line
  // arrives without its own trailing whitespace: one character short of the
  // value, and a whole-value replacement finds nothing. The multi-line case
  // above is answered by the LINE spellings `encodedSpellings` adds for a value
  // holding a newline. A one-line value stored with the padding a `.env` line
  // carries every day has no line spelling to fall back on, and nothing else in
  // the list is the value minus its own edge whitespace. The log keeps the line
  // untrimmed, so the whole value is there to replace.
  it("replaces a one-line secret whose own trailing space the reason trim ate", async () => {
    const padded: FlowScriptSecret = { name: "PADDED", value: "sk-live-9d3f0a1bcdef " };
    const ws = workspace();
    const script = ws.write(
      "padded-reason.sh",
      `echo "rejected key: $PADDED" >&2
       exit 1`
    );
    const result = await executor().execute({
      scriptPath: script,
      interpreter: "bash",
      projectRoot: ws.dir,
      env: { PADDED: padded.value },
      secrets: [padded],
    });

    const message = result.failure?.message ?? "";
    expect(result.failure?.kind).toBe("exit");
    expect(message).toContain("rejected key: {{secret:PADDED}}");
    expect(message).not.toContain(padded.value.trimEnd());
    expect(result.log).toContain("rejected key: {{secret:PADDED}}");
    expect(result.log).not.toContain(padded.value.trimEnd());
  }, 30_000);
});

describe("flow script executor — the heap verdict", () => {
  it("recognises a heap banner split across two pipe chunks", async () => {
    const ws = workspace();
    const script = ws.write(
      "split-heap.mjs",
      `const wait = (ms) => new Promise((r) => setTimeout(r, ms));
       process.stderr.write("\\n<--- Last few GCs --->\\n\\nFATAL ERROR: Reached ");
       await wait(60);
       process.stderr.write("heap limit Allocation failed - JavaScript heap out of memory\\n");
       await wait(60);
       process.abort();`
    );
    const result = await executor({ heapLimitMb: 64 }).execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 20_000,
    });

    expect(result.failure?.kind).toBe("heap");
    expect(result.failure?.message).toContain("64 MiB");
  }, 30_000);
});

describe("flow script executor — redaction", () => {
  const SECRET: FlowScriptSecret = { name: "API_KEY", value: "s3cr3t-token-value" };

  it("replaces a secret written in one piece", async () => {
    const ws = workspace();
    const script = ws.write("plain.mjs", `throw new Error("auth: " + process.env.API_KEY);`);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { API_KEY: SECRET.value },
      secrets: [SECRET],
    });

    expect(result.failure?.message).toBe("auth: {{secret:API_KEY}}");
  });

  it("replaces a secret in the failure message and its stack", async () => {
    const ws = workspace();
    const script = ws.write(
      "assert.mjs",
      `import assert from "node:assert/strict";
       assert.equal("sk-live-WRONG", process.env.API_KEY);`
    );
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { API_KEY: SECRET.value },
      secrets: [SECRET],
    });

    expect(result.failure?.kind).toBe("runtime");
    expect(result.failure?.message).not.toContain(SECRET.value);
    expect(result.failure?.message).toContain("{{secret:API_KEY}}");
    expect(result.failure?.stack).not.toContain(SECRET.value);
  });

  // The list is per REQUEST, and two runs of one executor share a queue, a
  // process pool and this module. Nothing drove two at once with different
  // lists, so a scrub that reached for anything module-scoped — a compiled set,
  // a memo — would have passed CI while replacing one run's marker in the
  // other's failure.
  it("keeps two concurrent runs' secret lists apart", async () => {
    const ws = workspace();
    const first: FlowScriptSecret = { name: "FIRST", value: "value-of-the-first-run" };
    const second: FlowScriptSecret = { name: "SECOND", value: "value-of-the-second-run" };
    const script = ws.write(
      "both.mjs",
      `await new Promise((r) => setTimeout(r, 300));
       throw new Error("saw " + process.env.MINE);`
    );
    const run = (secret: FlowScriptSecret) =>
      executor().execute({
        scriptPath: script,
        projectRoot: ws.dir,
        env: { MINE: secret.value },
        secrets: [secret],
      });

    const [a, b] = await Promise.all([run(first), run(second)]);

    expect(a.failure?.message).toBe("saw {{secret:FIRST}}");
    expect(b.failure?.message).toBe("saw {{secret:SECOND}}");
  }, 30_000);

  // A replacement is not a shortening. The child applies the ceiling — it is
  // the only side that can bound what crosses the channel — and it has no
  // secret list, so the scrub runs after the bound. A value SHORTER than its
  // own placeholder therefore grows the text: a one-character PIN turned a
  // message already clamped to 8 KB into a 114 KB step reason, which is what
  // the JSON report holds and what an agent reads.
  it("keeps a message the scrub grew inside the ceiling the child applied", async () => {
    const pin: FlowScriptSecret = { name: "PIN", value: "7" };
    const ws = workspace();
    const script = ws.write("blowup.mjs", `throw new Error("7".repeat(20000) + " tail");`);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { PIN: pin.value },
      secrets: [pin],
    });

    const message = result.failure?.message ?? "";
    expect(message).toContain("{{secret:PIN}}");
    expect(message.length).toBeLessThanOrEqual(SCRIPT_MAX_FAILURE_MESSAGE_CHARS);
  }, 30_000);

  // The failure text is the only place a resolved value is replaced. A passing
  // step's document is the script's answer, and a later step reads it for the
  // value it holds — `{{secret:NAME}}` in its place is a dead string. The docs
  // say not to put a credential there instead.
  it("leaves the output document as the script wrote it, at any depth and in a key", async () => {
    const ws = workspace();
    const script = ws.write(
      "echo.mjs",
      `const key = process.env.API_KEY;
       output.session = { token: key, scopes: ["read", key] };
       output[key] = "keyed";`
    );
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { API_KEY: SECRET.value },
      secrets: [SECRET],
    });

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({
      [SECRET.value]: "keyed",
      session: { token: SECRET.value, scopes: ["read", SECRET.value] },
    });
  });

  it("leaves a marker well formed when a value occurs inside another secret's name", async () => {
    const ws = workspace();
    const script = ws.write("marker.mjs", `throw new Error("value=Q");`);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      secrets: [{ name: "Q0", value: "Q" }],
    });

    expect(result.failure?.message).toBe("value={{secret:Q0}}");
  });

  it("leaves a marker well formed when two secrets swap name and value", async () => {
    const ws = workspace();
    const script = ws.write("swapped.mjs", `throw new Error("id=TOKEN_ABC and OKEN");`);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      secrets: [
        { name: "TOKEN_ABC", value: "OKEN" },
        { name: "OKEN", value: "TOKEN_ABC" },
      ],
    });

    expect(result.failure?.message).toBe("id={{secret:OKEN}} and {{secret:TOKEN_ABC}}");
  });

  it("replaces a value that starts inside marker-shaped text the script wrote", async () => {
    const ws = workspace();
    const script = ws.write("echoed.mjs", `throw new Error("head {{secret:TOK}}TAIL tail");`);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      secrets: [
        { name: "TOK", value: "tok" },
        { name: "V", value: "TOK}}TAIL" },
      ],
    });

    const message = result.failure?.message ?? "";
    expect(message).not.toContain("TOK}}TAIL");
    expect(message).toContain("{{secret:V}}");
  });

  it("replaces a nested secret as part of the value around it, and alone elsewhere", async () => {
    const ws = workspace();
    const host: FlowScriptSecret = { name: "HOST", value: "api.internal.example.com" };
    const url: FlowScriptSecret = {
      name: "URL",
      value: `https://${host.value}/tenant/9f3a0b1c2d3e4f50`,
    };
    const script = ws.write(
      "nested.mjs",
      `throw new Error(
         "calling " + ${JSON.stringify(url.value)} + " on " + ${JSON.stringify(host.value)});`
    );
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      secrets: [host, url],
    });

    expect(result.failure?.message).toBe("calling {{secret:URL}} on {{secret:HOST}}");
  });

  it("replaces the longer of two secrets when the shorter one is its prefix", async () => {
    const ws = workspace();
    const prefix: FlowScriptSecret = { name: "PFX", value: "sk-" };
    const full: FlowScriptSecret = { name: "FULL", value: "sk-live-9d3f0a1b" };
    const script = ws.write("prefix.mjs", `throw new Error("tok sk-live-9d3f0a1b end");`);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      secrets: [prefix, full],
    });

    expect(result.failure?.message).toBe("tok {{secret:FULL}} end");
  });

  it("replaces every occurrence of a value that starts with its own tail", async () => {
    const ws = workspace();
    const value = "0123456789".repeat(4);
    const script = ws.write(
      "periodic.mjs",
      `throw new Error(${JSON.stringify(value)}.repeat(128));`
    );
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      secrets: [{ name: "P", value }],
    });

    const message = result.failure?.message ?? "";
    expect(message).not.toMatch(/[0-9]/);
    expect(message).toContain("{{secret:P}}");
  }, 30_000);

  it("keeps a secret that straddles the failure-message ceiling out of the report", async () => {
    const ws = workspace();
    // The clamp is the child's, and the child has no secret list to clamp
    // around. The trailing run is what forces a clamp at all; the padding puts
    // the cut about nine characters into the value, leaving a prefix no
    // whole-value replacement can match.
    const script = ws.write(
      "long-throw.mjs",
      `throw new Error(
         "p".repeat(${SCRIPT_MAX_FAILURE_MESSAGE_CHARS} - 41) + process.env.API_KEY + "t".repeat(1000)
       );`
    );
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { API_KEY: SECRET.value },
      secrets: [SECRET],
    });

    expect(result.failure?.kind).toBe("runtime");
    expect(result.failure?.message).not.toContain(SECRET.value.slice(0, 8));
    expect(result.failure?.message).toMatch(/… \[\d+ more characters omitted]$/);
    expect(result.failure?.stack).not.toContain(SECRET.value.slice(0, 8));
  });

  it("repairs the straddling cut even when another secret's value is in the marker", async () => {
    const ws = workspace();
    // The repair reads the marker to know the text was cut. Read off the
    // SCRUBBED text, any secret whose value occurs inside the marker defeats it
    // — and the marker is argent's own sentence around a character COUNT, so a
    // value of `0` is enough. `PIN` is stored with the padding a secrets file
    // carries every day, and the trimmed spelling the scrub adds for it is that
    // bare digit. The marker was rewritten, neither pattern matched it, the
    // repair was skipped, and the half of API_KEY the cut left stayed in the
    // step reason, the --json report and the MCP call log.
    const PIN: FlowScriptSecret = { name: "PIN", value: " 0 " };
    const script = ws.write(
      "long-throw-pin.mjs",
      `throw new Error(
         "p".repeat(${SCRIPT_MAX_FAILURE_MESSAGE_CHARS} - 41) + process.env.API_KEY + "t".repeat(1000)
       );`
    );
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { API_KEY: SECRET.value, PIN: PIN.value },
      secrets: [SECRET, PIN],
    });
    const control = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { API_KEY: SECRET.value },
      secrets: [SECRET],
    });

    const message = result.failure?.message ?? "";
    // Every prefix of the value that is still the secret's own.
    for (let n = SECRET.value.length; n > 3; n -= 1) {
      expect(message).not.toContain(SECRET.value.slice(0, n));
    }
    // The marker is argent's own text, so it is left out of the scrub whole:
    // intact, and counting exactly what the run with no PIN counts.
    expect(message).toMatch(/… \[\d+ more characters omitted]$/);
    expect(message.slice(message.lastIndexOf("… ["))).toBe(
      (control.failure?.message ?? "").slice((control.failure?.message ?? "").lastIndexOf("… ["))
    );
  });

  it("reads the secret set live, so a value added mid-run still redacts", async () => {
    const ws = workspace();
    const script = ws.write(
      "later.mjs",
      `await new Promise((r) => setTimeout(r, 150));
       throw new Error(process.env.EARLY + " then " + process.env.LATE);`
    );
    const secrets: FlowScriptSecret[] = [{ name: "EARLY", value: "early-value-aaaa" }];
    const pending = executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { EARLY: "early-value-aaaa", LATE: "late-value-bbbb" },
      secrets,
    });
    // Pushed from a later turn of the loop, after the step has read the set
    // once: pushing in the same turn as the call lands before `runOne` ever
    // looks, so an implementation that snapshotted the array once would pass.
    setTimeout(() => secrets.push({ name: "LATE", value: "late-value-bbbb" }), 60);
    const result = await pending;

    expect(result.failure?.message).toBe("{{secret:EARLY}} then {{secret:LATE}}");
  });
});

/**
 * The scrub searches for a value's RAW bytes, so every re-encoding between the
 * child and the report defeated it — and the encoders are the ones a
 * verification script reaches for in one line. The values below are the shapes
 * the feature is documented for: a PEM key, a value holding a quote and a
 * backslash, and one holding nothing but a SPACE, which is the brief's own
 * worked run-time value (`--env "AUTH=Bearer abc"`).
 *
 * Each case runs beside `FLAT`, whose value no encoder touches: that control
 * redacted correctly before the fix and is what isolates the encoding as the
 * cause rather than the scrub being off altogether.
 */
describe("flow script executor — redaction through an encoder", () => {
  const FLAT: FlowScriptSecret = { name: "FLAT", value: "sk-live-9d3f-topvalue" };
  const PEM: FlowScriptSecret = {
    name: "PEM",
    value:
      "-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBgkqhkiG9w0BAQEFAASCAUAwggE8AgEAAkEA1234\n-----END PRIVATE KEY-----",
  };
  const QUOTED: FlowScriptSecret = { name: "QUOTED", value: 'pa"ss\\word' };
  const SPACED: FlowScriptSecret = { name: "SPACED", value: "Bearer sk-live-9d3f" };
  const ALL = [FLAT, PEM, QUOTED, SPACED];

  /** The characters that identify the credential, apart from a PEM's public armour. */
  const material: Record<string, string> = {
    FLAT: FLAT.value,
    PEM: "MIIBVgIBADANBgkqhkiG9w0BAQEFAASCAUAwggE8AgEAAkEA1234",
    QUOTED: QUOTED.value,
    SPACED: "sk-live-9d3f",
  };

  function expectNoValue(text: string, secret: FlowScriptSecret): void {
    expect(text).toContain(`{{secret:${secret.name}}}`);
    // Every fragment of the credential down to six characters, because the
    // escaping an encoder applies is trivially reversible: leaving it is
    // disclosure, not obfuscation.
    const part = material[secret.name]!;
    for (let n = part.length; n >= 6; n -= 1) {
      for (let i = 0; i + n <= part.length; i += 1) {
        expect(text).not.toContain(part.slice(i, i + n));
      }
    }
  }

  async function failWith(source: string, secret: FlowScriptSecret): Promise<string> {
    const ws = workspace();
    const script = ws.write("encoded.mjs", source);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { K: secret.value },
      secrets: ALL,
    });
    expect(result.ok).toBe(false);
    return `${result.failure?.message ?? ""}\n${result.failure?.stack ?? ""}`;
  }

  it("replaces a value util.inspect quoted, escaped and split by line", async () => {
    // `assert.strictEqual(process.env.K, …)` is one line, and the most likely
    // line in a verification script. Node renders its diff with `util.inspect`,
    // which escapes — and writes a multi-line value as one quoted chunk PER
    // LINE, joined by `' +`, so no whole-value match survives the glue.
    for (const secret of ALL) {
      const text = await failWith(
        `import assert from "node:assert";
         assert.strictEqual(process.env.K, "expected-value");`,
        secret
      );
      expectNoValue(text, secret);
    }
  }, 60_000);

  it("replaces a value the runner's own JSON encoder wrote", async () => {
    // Anything thrown that is not an `Error` message goes through the runner's
    // `describeThrown`, so an object `cause` — the idiomatic way to carry a
    // failed request's detail — arrives JSON-escaped.
    for (const secret of ALL) {
      const text = await failWith(
        `throw new Error("request failed", { cause: { status: 401, key: process.env.K } });`,
        secret
      );
      expectNoValue(text, secret);
    }
  }, 60_000);

  it("replaces a value a URL percent-encoded, and one it wrote a space of as +", async () => {
    // A plain space is enough here, which is what puts this well past
    // "special characters": `URLSearchParams` writes one as `+`.
    for (const secret of ALL) {
      const text = await failWith(
        `const u = new URL("https://api.example.com/x");
         u.searchParams.set("t", process.env.K);
         throw new Error("call failed: " + u.toString());`,
        secret
      );
      expectNoValue(text, secret);
    }
  }, 60_000);
});

/**
 * The encoders above are all CHARACTER-LOCAL: each byte of the value lands in
 * the same place in the output whatever surrounds it, so a spelling of the
 * whole value still appears in the text. The three shapes here are not, and
 * each one left the credential whole and losslessly recoverable in a report
 * that held no spelling of it at all.
 */
describe("flow script executor — redaction of a re-framed, wrapped or cut value", () => {
  const KEY: FlowScriptSecret = { name: "KEY", value: "key-p2b-live-7f3c9a1e5b2d8046" };
  // No fragment of a value may spell part of the placeholder that replaces it,
  // or the sweep below flags argent's own `{{secret:…}}` as a leak.
  const CUT: FlowScriptSecret = { name: "CUT", value: "sk-live-9d3f-topvalue-abcdef123456" };
  const ODD: FlowScriptSecret = { name: "ODD", value: "pa'ss\"w\\ord-9d3f7a2b" };
  const ALL = [KEY, CUT, ODD];

  async function failWith(source: string, name: string): Promise<string> {
    const ws = workspace();
    const script = ws.write("reframed.mjs", source);
    const secret = ALL.find((entry) => entry.name === name)!;
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { K: secret.value },
      secrets: ALL,
    });
    expect(result.ok).toBe(false);
    return `${result.failure?.message ?? ""}\n${result.failure?.stack ?? ""}`;
  }

  /** No run of six or more characters of the value survives anywhere. */
  function expectNoValue(text: string, name: string): void {
    const value = ALL.find((entry) => entry.name === name)!.value;
    expect(text).toContain(`{{secret:${name}}}`);
    for (let n = value.length; n >= 6; n -= 1) {
      for (let at = 0; at + n <= value.length; at += 1) {
        expect(text).not.toContain(value.slice(at, at + n));
      }
    }
  }

  // base64 frames in THREE-byte groups, so a prefix whose length is not a
  // multiple of three moves every following byte into a different frame and no
  // spelling of the value appears. `Basic base64(user:secret)` is the standard
  // HTTP credential idiom, and the comment that justifies having base64 in the
  // spelling list cites Basic auth as the reason for it.
  it("replaces a value base64 re-framed behind a prefix", async () => {
    const text = await failWith(
      `throw new Error("Basic " + Buffer.from(\`api:\${process.env.K}\`).toString("base64"));`,
      "KEY"
    );
    expectNoValue(text, "KEY");
  }, 30_000);

  // Every frame offset a run can START on. A prefix glued straight onto the
  // encoded output — no separator to align it — puts the payload one, two or
  // three characters into its first frame.
  it("replaces a value in a run that starts mid-frame, at every offset", async () => {
    for (const prefix of ["", "x", "xy", "xyz"]) {
      const text = await failWith(
        `throw new Error(${JSON.stringify(prefix)} + Buffer.from("ab" + process.env.K).toString("base64"));`,
        "KEY"
      );
      expectNoValue(text, "KEY");
    }
  }, 60_000);

  // `=` is padding, so a decoder stops there: read as one run, `?token=<payload>`
  // decoded the word in front of the credential and nothing after it.
  it("replaces a value behind a query key the padding character would have merged", async () => {
    const text = await failWith(
      `throw new Error("https://api.example.com/?token=" + Buffer.from("ab" + process.env.K).toString("base64"));`,
      "KEY"
    );
    expectNoValue(text, "KEY");
  }, 30_000);

  // The shell's own tools wrap at a fixed column, so a value merely long enough
  // to wrap has a newline through the middle of its encoding. No prefix is
  // needed for this one.
  it("replaces a value whose encoding a wrap split over lines", async () => {
    for (const encoding of ["hex", "base64"]) {
      const text = await failWith(
        `const e = Buffer.from(process.env.K).toString(${JSON.stringify(encoding)});
         throw new Error(e.replace(/(.{7})/g, "$1\\n"));`,
        "KEY"
      );
      expectNoValue(text, "KEY");
    }
  }, 60_000);

  // `encodedSpellings` writes lower-case hex; a signature printed upper-case is
  // the same bytes in the same order.
  it("replaces a value printed as upper-case hex", async () => {
    const text = await failWith(
      `throw new Error("sig " + Buffer.from(process.env.K).toString("hex").toUpperCase());`,
      "KEY"
    );
    expectNoValue(text, "KEY");
  }, 30_000);

  // Node embeds a fixed-length PREFIX of a string argument in the error it
  // raises — 10 characters for `JSON.parse`, 25 for ERR_INVALID_ARG_TYPE. The
  // repair for that required the value to begin one character after the opening
  // quote, so a credential built into a larger string first disabled it.
  it("replaces a cut prefix that starts inside the quoted fragment", async () => {
    const parsed = await failWith('JSON.parse(`{"token":${process.env.K}}`);', "CUT");
    expectNoValue(parsed, "CUT");

    const timed = await failWith(
      `setTimeout("Bearer " + process.env.K, 1);
       await new Promise((r) => setTimeout(r, 50));`,
      "CUT"
    );
    expectNoValue(timed, "CUT");
  }, 60_000);

  // `util.inspect` picks a BACKTICK body for a value holding both quotes and
  // escapes neither of them, and `RegExp.source` writes `/` as `\/`. Read as
  // one rule: a backslash takes the character after it.
  it("replaces a value an escaper backslashed", async () => {
    const inspected = await failWith(
      `import assert from "node:assert";
       assert.strictEqual(process.env.K, "expected-value");`,
      "ODD"
    );
    expectNoValue(inspected, "ODD");
  }, 30_000);

  // The floor and the alphabets must not rewrite argent's own text: hex- and
  // base64-shaped words decode to bytes as well, and nothing about them says
  // they were ever an encoding.
  it("leaves hex- and base64-shaped prose that holds no value alone", async () => {
    const text = await failWith(
      `throw new Error("deadbeefcafe0123 aGVsbG8gd29ybGQ= ordinary words");`,
      "KEY"
    );
    expect(text).toContain("deadbeefcafe0123 aGVsbG8gd29ybGQ= ordinary words");
    expect(text).not.toContain("{{secret:");
  }, 30_000);
});

/**
 * `util.inspect` prints a `Buffer` or a `TypedArray` as its NUMBERS, so no
 * spelling of the value is in the text at all and only the byte-space pass can
 * answer. Every other case in this file reaches that pass through an ENCODER —
 * `.toString("base64")` or `.toString("hex")` — which is `repairEncodedRuns`,
 * a different function; nothing here produced the numeric rendering
 * `repairByteRenderings` exists for, so both of the shapes below printed the
 * credential in full while the suite stayed green.
 */
describe("flow script executor — redaction of a value rendered as bytes", () => {
  const KEY: FlowScriptSecret = { name: "KEY", value: "sec-9d3f-topvalue-abcdef" };

  async function failWith(source: string, secret: FlowScriptSecret): Promise<string> {
    const ws = workspace();
    const script = ws.write("bytes.mjs", source);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { K: secret.value },
      secrets: [secret],
    });
    expect(result.ok).toBe(false);
    return `${result.failure?.message ?? ""}\n${result.failure?.stack ?? ""}`;
  }

  /** No run of six or more characters of the value survives, in any spelling. */
  function expectNoValue(text: string, secret: FlowScriptSecret): void {
    expect(text).toContain(`{{secret:${secret.name}}}`);
    for (let n = secret.value.length; n >= 6; n -= 1) {
      for (let at = 0; at + n <= secret.value.length; at += 1) {
        const part = secret.value.slice(at, at + n);
        expect(text).not.toContain(part);
        // And not as the bytes the rendering wrote it in either.
        const bytes = Buffer.from(part, "utf8");
        expect(text).not.toContain(bytes.toString("hex").replace(/../g, "$& ").trim());
        expect(text).not.toContain([...bytes].join(", "));
      }
    }
  }

  // `<Buffer 73 65 …>` is followed by ordinary prose, and the first word of it
  // opens with hex characters of its own: `did`, `expected`, `and` and `from`
  // all contribute an odd-length prefix that is no byte at radix 16. Only a
  // LETTER ended a run, and the `>` between them is none — so that prefix
  // joined the run, the run stopped decoding, and every byte of the credential
  // printed.
  it("replaces a Buffer rendering the next word's hex prefix runs into", async () => {
    for (const word of ["did", "expected", "and", "from"]) {
      const text = await failWith(
        `import util from "node:util";
         throw new Error(util.inspect(Buffer.from(process.env.K)) + " ${word} not match the digest");`,
        KEY
      );
      expect(text).toContain(`${word} not match the digest`);
      expectNoValue(text, KEY);
    }
  }, 60_000);

  // Node's OWN cut, which every rendering of a real credential meets before
  // argent's: `util.inspect` writes the first 50 bytes of a `Buffer` and a
  // `... N more bytes` trailer, and the first 100 elements of a `TypedArray`
  // with `... N more items`. That trailer's COUNT is the token after the
  // ellipsis, and it is no byte whenever it has the wrong number of digits —
  // three at radix 16, or over 255 at radix 10 — so the rule that drops a
  // non-byte token has to read the GAP first, or it throws away the ellipsis
  // that had just marked the run as cut and the visible prefix stands.
  //
  // The two cases above pass `maxArrayLength: Infinity`, which removes the
  // trailer, so neither exercises the shape an ordinary `util.inspect` writes.
  it("replaces the visible prefix of a value Node's own renderer cut", async () => {
    const long: FlowScriptSecret = { name: "K", value: `sk-live-${"a9f3b1c7d5e2".repeat(20)}xy` };
    for (const render of [
      "util.inspect(Buffer.from(process.env.K))",
      "util.inspect(new Uint8Array(Buffer.from(process.env.K)))",
    ]) {
      const text = await failWith(
        `import util from "node:util";
         throw new Error(${render});`,
        long
      );
      // The trailer is Node's own wording and stays, so the reader still knows
      // how much was dropped.
      expect(text).toMatch(/\.\.\. \d+ more (bytes|items)/);
      expectNoValue(text, long);
    }
  }, 60_000);

  // `assert.deepStrictEqual(Buffer.from(k), expected)` renders the two buffers
  // INTERLEAVED, one byte per line, with the diff's own `+` and `-` down the
  // left and a line both sides agree on carrying neither. Read whole, the run
  // holds the script's bytes with the expected side's mixed through it, so no
  // contiguous stretch spells the value and every byte printed — while the
  // neighbouring shapes all redacted correctly, which is what made the gap easy
  // to miss. Keeping the lines the expected side does not own recovers the
  // credential exactly, so that is the reading the repair has to make too.
  it("replaces a value an assert diff interleaved with the other side's bytes", async () => {
    const text = await failWith(
      `import assert from "node:assert";
       assert.deepStrictEqual(Buffer.from(process.env.K, "utf8"), Buffer.from("expected", "utf8"));`,
      KEY
    );
    expect(text).toContain("Expected values to be strictly deep-equal");
    expectNoValue(text, KEY);
    // The bytes of the value, read off the lines the expected side does not own
    // — the recovery the reviewer's own repro performed.
    const kept = text
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("-"))
      .join("\n");
    const numbers = [...kept.matchAll(/\d+/g)].map((match) => Number(match[0]));
    expect(Buffer.from(numbers.filter((code) => code <= 255)).toString("utf8")).not.toContain(
      KEY.value
    );
  }, 30_000);

  // Over 255 elements a rendering prints its own COUNT immediately in front of
  // the bytes — `Uint8Array(298) [` — and `(`, `)` and `[` are not letters
  // either. The count joined the run, no byte is written as 298, and the whole
  // run was rejected at decimal radix. A PEM block, a service-account JSON and
  // a long JWT are all past that length, and all are shapes `env` is documented
  // to carry.
  it("replaces a rendering whose element count precedes the bytes", async () => {
    const long: FlowScriptSecret = { name: "PEM", value: `sk-live-${"a9f3b1c7d5e2".repeat(24)}` };
    expect(long.value.length).toBeGreaterThan(255);
    const text = await failWith(
      `import util from "node:util";
       throw new Error("digest mismatch " + util.inspect(new Uint8Array(Buffer.from(process.env.K)), { maxArrayLength: Infinity }));`,
      long
    );
    expect(text).toContain("digest mismatch");
    expectNoValue(text, long);
  }, 30_000);
});

/**
 * The cut argent itself makes, which no repair could see.
 *
 * A repair that answers a cut reads the ellipsis the cutter left. Argent's own
 * clamp leaves a marker instead, and `redactTruncated` takes that marker off
 * before the scrub — so the head handed to the repairs held no ellipsis and
 * every one of them read an uncut text. The same value in the same rendering
 * came back repaired when NODE cut it and in the clear when argent did.
 */
describe("flow script executor — redaction of a value argent's own clamp cut", () => {
  const KEY: FlowScriptSecret = { name: "LIVEKEY", value: "sk-live-9d3f2a7c41b8e05f6a2d" };

  /**
   * A failure whose last `room` characters are `tail`, so argent's own ceiling
   * cuts inside it. The runner's marker eats about thirty of those, which is
   * why each case names its own room rather than sharing one.
   */
  async function clampedAt(tail: string, room: number): Promise<string> {
    const ws = workspace();
    const script = ws.write(
      "clamped.mjs",
      `throw new Error("x".repeat(${SCRIPT_MAX_FAILURE_MESSAGE_CHARS} - ${room}) + " " + ${tail});`
    );
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { K: KEY.value },
      secrets: [KEY],
    });
    expect(result.ok).toBe(false);
    const message = result.failure?.message ?? "";
    expect(message).toMatch(/more characters omitted]$/);
    return message;
  }

  /** No run of six or more characters of the value survives, decoded or raw. */
  function expectNoFragment(text: string, decode: (fragment: string) => string): void {
    for (let n = KEY.value.length; n >= 6; n -= 1) {
      for (let at = 0; at + n <= KEY.value.length; at += 1) {
        expect(decode(text)).not.toContain(KEY.value.slice(at, at + n));
      }
    }
  }

  // The rendering the clamp cuts through, so its visible head is a PREFIX of
  // the credential in byte space. `byteRunSpans` has the branch that answers
  // one; it was gated on an ellipsis argent's own marker never leaves.
  it("replaces the front of a value left standing in a cut byte rendering", async () => {
    const message = await clampedAt(
      `(await import("node:util")).inspect(new Uint8Array(Buffer.from(process.env.K)), { maxArrayLength: Infinity })`,
      142
    );

    expect(message).toContain("{{secret:LIVEKEY}}");
    // Read the numbers back as bytes, which is how the disclosure reads.
    expectNoFragment(message, (text) =>
      Buffer.from(
        [...text.matchAll(/\b\d{1,3}\b/g)].map((match) => Number(match[0])).filter((n) => n <= 255)
      ).toString("utf8")
    );
  }, 30_000);

  // `repairEncodedRuns` had no cut branch at all — the only cut guard on its
  // path is `partialSecretTail`, which searches for a prefix of a SPELLING, and
  // that works only while the encoding is character-local. Base64 is the
  // encoding that is not, which is the reason the pass exists.
  it("replaces the front of a value left standing in a cut base64 payload", async () => {
    const message = await clampedAt(
      `"Basic " + Buffer.from("api:" + process.env.K).toString("base64") + " and more text"`,
      62
    );

    expect(message).toContain("{{secret:LIVEKEY}}");
    // Every base64 run in the report, decoded at each frame offset it can
    // start on — the reading that recovers a credential from a cut payload.
    expectNoFragment(message, (text) =>
      [...text.matchAll(/[A-Za-z0-9+/]{8,}/g)]
        .flatMap((match) => [0, 1, 2, 3].map((offset) => match[0].slice(offset)))
        .map((run) => Buffer.from(run, "base64").toString("utf8"))
        .join("\n")
    );
  }, 30_000);
});

/**
 * Two defects the frame widening and the loosened cut anchor introduced, each
 * the mirror of the other: one replaced too little and disclosed a credential,
 * one replaced too much and corrupted argent's own text.
 */
describe("flow script executor — what the byte-space repairs must not do", () => {
  const USER: FlowScriptSecret = { name: "USER", value: "apiuser" };
  const KEY: FlowScriptSecret = { name: "KEY", value: "sk-live-9d3f4a1b2c8e" };
  const BOTH = [USER, KEY];

  async function failWith(source: string): Promise<string> {
    const ws = workspace();
    const script = ws.write("pair.mjs", source);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { U: USER.value, K: KEY.value },
      secrets: BOTH,
    });
    expect(result.ok).toBe(false);
    return `${result.failure?.message ?? ""}\n${result.failure?.stack ?? ""}`;
  }

  // `encodedRunSpans` widens a byte match out to the base64 frames it lies in,
  // so two values in one payload share a frame whenever the first leaves the
  // second starting mid-frame. `spliceSpans` dropped the second span whole and
  // copied out everything from the end of the first — 19 of the 20 characters
  // of the key, one base64 hop away. `Basic base64(user:key)` is the idiom the
  // whole pass exists for, and `len(user) % 3 == 1` is a third of all users.
  it("replaces BOTH values when two share a base64 frame", async () => {
    const text = await failWith(
      `throw new Error("POST /v1/session -> 401  Basic " +
         Buffer.from(process.env.U + ":" + process.env.K).toString("base64"));`
    );
    expect(text).toContain("{{secret:USER}}");
    expect(text).toContain("{{secret:KEY}}");
    for (let n = KEY.value.length; n >= 6; n -= 1) {
      for (let at = 0; at + n <= KEY.value.length; at += 1) {
        const part = KEY.value.slice(at, at + n);
        expect(text).not.toContain(part);
        // And not in the alphabet the payload was written in either.
        expect(text).not.toContain(Buffer.from(part, "utf8").toString("base64").replace(/=+$/, ""));
      }
    }
  }, 30_000);

  // The mirror: with the prefix free to start anywhere inside the fragment,
  // one character before an ellipsis matched the first character of SOME
  // spelling nearly always, and argent's own diagnostic lost a letter to a
  // placeholder that named a credential nothing had disclosed.
  it("leaves argent's own quoted, elided wording alone", async () => {
    for (const wording of [
      "Command failed: '/bin/sh -c npm run seeds...'",
      "The runner reported 'ERR_STREAM_PREMATURE_CLOSE' after 3s...",
      "timed out waiting for 'settle'...",
    ]) {
      const text = await failWith(`throw new Error(${JSON.stringify(wording)});`);
      expect(text).toContain(wording);
      expect(text).not.toContain("{{secret:");
    }
  }, 60_000);
});
