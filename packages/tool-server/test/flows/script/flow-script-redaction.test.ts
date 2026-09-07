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

  // The runner TRIMS the reason it read, so a secret whose own value ends in
  // whitespace — a PEM key, a service-account blob — arrives one character
  // short of itself when it sits at the edge of the file, and a whole-value
  // replacement finds nothing. `echo "…$KEY" > "$ARGENT_REASON"` is the
  // idiomatic way to write that file, so this is the shape the promise exists
  // for. The other reason case here pads AFTER the secret, which is the control
  // that always passed.
  it("replaces a secret whose own trailing newline the reason trim ate", async () => {
    const multiline: FlowScriptSecret = {
      name: "PEM",
      value: "-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkqhkiG9w0\n-----END PRIVATE KEY-----\n",
    };
    const ws = workspace();
    const script = ws.write(
      "edge-reason.sh",
      `echo "signing failed with key: $PEM" > "$ARGENT_REASON"
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
    expect(message).not.toContain("MIIBVQIBADANBgkqhkiG9w0");
    expect(message).toContain("{{secret:PEM}}");
  }, 30_000);

  // The runner's marker counts what it KEPT of the reason; `partialSecretTail`
  // measures a suffix of the WHOLE message. A value long enough to be a prefix
  // of the reason and of argent's own exit line in front of it therefore takes
  // off more than the reason ever held, and the subtraction went below zero:
  // `… [$ARGENT_REASON holds 20000 bytes; this report keeps the first -2
  // characters]` is a count no reader can use.
  it("never reports a negative kept-count for the reason it cut", async () => {
    const reasonCeiling = SCRIPT_MAX_FAILURE_MESSAGE_CHARS - 1024;
    const ws = workspace();
    // A secret that opens with the exit line the runner composes, so the whole
    // message head is a prefix of it.
    const spanning: FlowScriptSecret = {
      name: "SPAN",
      value: `The script exited with code 1 (bash: ${hostBash}). ${"z".repeat(reasonCeiling + 64)}`,
    };
    const script = ws.write(
      "spanning.sh",
      `printf '%${reasonCeiling * 2}s' '' | tr ' ' 'z' > "$ARGENT_REASON"
       exit 1`
    );
    const result = await executor().execute({
      scriptPath: script,
      interpreter: "bash",
      projectRoot: ws.dir,
      secrets: [spanning],
    });

    const message = result.failure?.message ?? "";
    expect(message).toMatch(/this report keeps the first \d+ characters]$/);
    expect(message).not.toMatch(/keeps the first -/);
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
