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

afterEach(() => {
  while (workspaces.length) workspaces.pop()!.cleanup();
});

function executor(options: FlowScriptExecutorOptions = {}) {
  return new FlowScriptExecutor({ concurrency: 4, maxTimeoutMs: 60_000, ...options });
}

/**
 * A bash step reaches redaction through a different channel from a `.mjs` one:
 * its failure text is a file the script wrote, read by the runner and appended
 * to the exit line, and its document is a file rather than a value the runner
 * encoded. Neither had a case here.
 */
describe("flow script executor — redaction of a bash step", () => {
  const SECRET: FlowScriptSecret = { name: "API_KEY", value: "s3cr3t-token-value" };

  let noBash: string | undefined;

  beforeAll(async () => {
    const found = await resolveHostBash();
    if (!("path" in found)) noBash = found.problem;
  });

  beforeEach((ctx) => {
    if (noBash) ctx.skip(`this host has no bash to run a .sh step with: ${noBash}`);
  });

  it("replaces a secret the script wrote to $ARGENT_REASON", async () => {
    const ws = workspace();
    const script = ws.write(
      "reason.sh",
      `printf 'the call to %s failed' "$API_KEY" > "$ARGENT_REASON"
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
    expect(result.failure?.message).toContain("API_KEY");
  }, 30_000);

  it("replaces a secret the script wrote into its output document", async () => {
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
    expect(JSON.stringify(result.output)).not.toContain(SECRET.value);
    expect(JSON.stringify(result.output)).toContain("API_KEY");
  }, 30_000);

  // A secret cut in half by a truncation is not a secret any scrub can find:
  // what is left is a PREFIX of one, which matches nothing. The parent drops
  // that tail wherever a truncation marker ends the text, and the runner's
  // reason marker is a second shape of one — it counts what it kept rather than
  // what it dropped, because a bounded read cannot know the file's length. This
  // runs a real script through both sides, so a wording that drifted apart
  // fails here rather than leaking there.
  it("drops the half of a secret the $ARGENT_REASON cut left behind", async () => {
    const ws = workspace();
    // The reason ceiling, in step with `MAX_REASON_CHARS` in
    // `flow-script-runner.mjs`: the whole message ceiling less the room the exit
    // line, the exit-code hint and the marker ride in. The padding stops ten
    // characters short of it, so the cut lands INSIDE the secret and what
    // survives is a prefix of one — which no scrub can match.
    const reasonCeiling = SCRIPT_MAX_FAILURE_MESSAGE_CHARS - 1024;
    const pad = reasonCeiling - 10;
    const script = ws.write(
      "long-reason.sh",
      `printf '%${pad}s' '' | tr ' ' 'x' > "$ARGENT_REASON"
       printf '%s' "$API_KEY" >> "$ARGENT_REASON"
       printf '%${reasonCeiling}s' '' | tr ' ' 'y' >> "$ARGENT_REASON"
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
    expect(message).toMatch(/this report keeps the first \d+ characters]$/);
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
    const script = ws.write("plain.mjs", `output.auth = "auth: " + process.env.API_KEY;`);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { API_KEY: SECRET.value },
      secrets: [SECRET],
    });

    expect(result.output).toEqual({ auth: "auth: {{secret:API_KEY}}" });
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

  it("replaces a secret in the output document, at any depth and in a key", async () => {
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
    expect(JSON.stringify(result.output)).not.toContain(SECRET.value);
    expect(result.output).toEqual({
      "session": { token: "{{secret:API_KEY}}", scopes: ["read", "{{secret:API_KEY}}"] },
      "{{secret:API_KEY}}": "keyed",
    });
  });

  it("leaves a marker well formed when a value occurs inside another secret's name", async () => {
    const ws = workspace();
    const script = ws.write("marker.mjs", `output.line = "value=Q";`);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      secrets: [{ name: "Q0", value: "Q" }],
    });

    expect(result.output).toEqual({ line: "value={{secret:Q0}}" });
  });

  it("leaves a marker well formed when two secrets swap name and value", async () => {
    const ws = workspace();
    const script = ws.write("swapped.mjs", `output.line = "id=TOKEN_ABC and OKEN";`);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      secrets: [
        { name: "TOKEN_ABC", value: "OKEN" },
        { name: "OKEN", value: "TOKEN_ABC" },
      ],
    });

    expect(result.output).toEqual({ line: "id={{secret:OKEN}} and {{secret:TOKEN_ABC}}" });
  });

  it("refuses a document whose redacted key would replace a sibling", async () => {
    const ws = workspace();
    const script = ws.write("collide.mjs", `output.doc = { "ab": 1, "{{secret:s}}": 2 };`);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      secrets: [{ name: "s", value: "ab" }],
    });

    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe("output");
    expect(result.failure?.message).toContain("Two keys in the script's output become \"");
    expect(result.failure?.message).toContain("{{secret:s}}");
    expect(result.output).toBeUndefined();
  });

  it("replaces a value that starts inside marker-shaped text the script wrote", async () => {
    const ws = workspace();
    const script = ws.write("echoed.mjs", `output.line = "head {{secret:TOK}}TAIL tail";`);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      secrets: [
        { name: "TOK", value: "tok" },
        { name: "V", value: "TOK}}TAIL" },
      ],
    });

    const line = (result.output as { line: string }).line;
    expect(line).not.toContain("TOK}}TAIL");
    expect(line).toContain("{{secret:V}}");
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
      `output.line =
         "calling " + ${JSON.stringify(url.value)} + " on " + ${JSON.stringify(host.value)};`
    );
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      secrets: [host, url],
    });

    expect(result.output).toEqual({ line: "calling {{secret:URL}} on {{secret:HOST}}" });
  });

  it("replaces the longer of two secrets when the shorter one is its prefix", async () => {
    const ws = workspace();
    const prefix: FlowScriptSecret = { name: "PFX", value: "sk-" };
    const full: FlowScriptSecret = { name: "FULL", value: "sk-live-9d3f0a1b" };
    const script = ws.write("prefix.mjs", `output.line = "tok sk-live-9d3f0a1b end";`);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      secrets: [prefix, full],
    });

    expect(result.output).toEqual({ line: "tok {{secret:FULL}} end" });
  });

  it("replaces every occurrence of a value that starts with its own tail", async () => {
    const ws = workspace();
    const value = "0123456789".repeat(4);
    const script = ws.write("periodic.mjs", `output.blob = ${JSON.stringify(value)}.repeat(128);`);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      secrets: [{ name: "P", value }],
    });

    const blob = (result.output as { blob: string }).blob;
    expect(blob).not.toMatch(/[0-9]/);
    expect(blob).toContain("{{secret:P}}");
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

  it("reads the secret set live, so a value added mid-run still redacts", async () => {
    const ws = workspace();
    const script = ws.write(
      "later.mjs",
      `output.first = process.env.EARLY;
       await new Promise((r) => setTimeout(r, 150));
       output.second = process.env.LATE;`
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

    expect(result.output).toEqual({
      first: "{{secret:EARLY}}",
      second: "{{secret:LATE}}",
    });
  });
});
