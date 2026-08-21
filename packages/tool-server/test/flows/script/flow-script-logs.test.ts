import { afterEach, describe, expect, it } from "vitest";
import {
  createScriptLogBudget,
  FlowScriptExecutor,
  SCRIPT_STEP_LOG_LIMIT_BYTES,
  type FlowScriptExecutorOptions,
  type FlowScriptLogBudget,
  type FlowScriptSecret,
} from "../../../src/tools/flows/script/flow-script-executor";
import { SCRIPT_MAX_FAILURE_MESSAGE_CHARS } from "../../../src/tools/flows/script/flow-script-protocol";
import { createScriptWorkspace, type ScriptWorkspace } from "../../helpers/flow-script-workspace";

const workspaces: ScriptWorkspace[] = [];

function workspace(): ScriptWorkspace {
  const ws = createScriptWorkspace("log");
  workspaces.push(ws);
  return ws;
}

afterEach(() => {
  while (workspaces.length) workspaces.pop()!.cleanup();
});

function executor(options: FlowScriptExecutorOptions = {}) {
  return new FlowScriptExecutor({ concurrency: 4, maxTimeoutMs: 60_000, ...options });
}

describe("flow script executor — log capture", () => {
  it("captures stdout and stderr, and a subprocess writing to the same streams", async () => {
    const ws = workspace();
    const script = ws.write(
      "logs.mjs",
      `import { execFileSync } from "node:child_process";
       console.log("from console.log");
       console.info("from console.info");
       console.warn("from console.warn");
       console.error("from console.error");
       execFileSync(process.execPath, ["-e", "console.log('from a subprocess')"], { stdio: "inherit" });
       output.done = true;`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.ok).toBe(true);
    for (const line of [
      "from console.log",
      "from console.info",
      "from console.warn",
      "from console.error",
      "from a subprocess",
    ]) {
      expect(result.log).toContain(line);
    }
  });

  it("keeps the logs of a script that throws", async () => {
    const ws = workspace();
    const script = ws.write(
      "throws.mjs",
      `console.log("before the throw"); throw new Error("nope");`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure?.kind).toBe("runtime");
    expect(result.log).toContain("before the throw");
  });

  it("truncates at the per-step limit without blocking the script", async () => {
    const ws = workspace();
    // Five megabytes, far past the 64 KiB step limit. A capture that paused the
    // stream would fill the pipe buffer and wedge the child, so the proof that
    // it never pauses is that the script still finishes and returns output.
    const script = ws.write(
      "loud.mjs",
      `const line = "y".repeat(1023) + "\\n";
       for (let i = 0; i < 5 * 1024; i++) process.stdout.write(line);
       output.finished = true;`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.output).toEqual({ finished: true });
    expect(result.logTruncated).toBe(true);
    expect(Buffer.byteLength(result.log)).toBeLessThanOrEqual(SCRIPT_STEP_LOG_LIMIT_BYTES);
    expect(Buffer.byteLength(result.log)).toBeGreaterThan(SCRIPT_STEP_LOG_LIMIT_BYTES - 2048);
  });

  it("spends one run budget across every step in the run", async () => {
    const ws = workspace();
    const script = ws.write(
      "chatty.mjs",
      `process.stdout.write("z".repeat(64 * 1024)); output.ok = true;`
    );
    const budget: FlowScriptLogBudget = createScriptLogBudget();
    const shared = executor();
    const sizes: number[] = [];
    // The run budget is 256 KiB and each step fills its own 64 KiB step limit,
    // so the fifth step has nothing left to spend.
    for (let step = 0; step < 5; step++) {
      const result = await shared.execute({
        scriptPath: script,
        projectRoot: ws.dir,
        logBudget: budget,
      });
      expect(result.ok).toBe(true);
      sizes.push(Buffer.byteLength(result.log));
    }
    expect(sizes.slice(0, 4).every((size) => size > 0)).toBe(true);
    expect(sizes[4]).toBe(0);
    expect(budget.remainingBytes).toBeLessThanOrEqual(0);
  });
});

describe("flow script executor — cutting the log", () => {
  it("never cuts a multi-byte character in half", async () => {
    const ws = workspace();
    // Every other log fixture is ASCII, where a naive byte cut is
    // indistinguishable from a correct one.
    const script = ws.write(
      "wide.mjs",
      `console.log("日本語テキスト".repeat(20000));
       output.ok = true;`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.logTruncated).toBe(true);
    expect(result.log).not.toContain("\uFFFD");
    // A cut inside a 3-byte character would decode to a replacement character
    // and change the length; the kept text is whole characters only.
    expect(Buffer.byteLength(result.log, "utf8")).toBeLessThanOrEqual(SCRIPT_STEP_LOG_LIMIT_BYTES);
  }, 30_000);
});

describe("flow script executor — the heap verdict", () => {
  it("recognises a heap banner split across two pipe chunks", async () => {
    const ws = workspace();
    // The banner is matched on the live stream, and a pipe hands over whatever
    // the kernel had rather than whatever the script wrote — so the phrase can
    // arrive in halves. Without the rolling window the abort below degrades
    // from the heap verdict, which names the limit and the value, to the
    // signal one, which says only that something killed the process.
    //
    // The banner is written by the script rather than provoked, because the
    // point under test is the window and not V8: a real exhaustion prints its
    // banner in one write.
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

describe("flow script executor — the V8 frame collapser", () => {
  it("marks the log truncated when it drops frames", async () => {
    const ws = workspace();
    const script = ws.write(
      "hungry.mjs",
      `console.log("allocating"); const held = []; for (;;) held.push("x".repeat(1024 * 1024));`
    );
    const result = await executor({ heapLimitMb: 64 }).execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 30_000,
    });

    expect(result.log).toMatch(/\[\d+ V8 stack frames omitted]/);
    // Collapsed frames are output the report does not carry, which is what
    // this flag means; it stayed false and nothing told the caller.
    expect(result.logTruncated).toBe(true);
  }, 60_000);

  it("keeps a short run of frame lines verbatim, even after a fatal error", async () => {
    const ws = workspace();
    // Fewer than the collapse threshold: the documented guarantee is that an
    // ordinary log line that happens to look like a frame survives as written.
    const script = ws.write(
      "short-run.mjs",
      `console.error("FATAL ERROR: something the script printed itself");
       console.error(" 1: 0x104941aec first");
       console.error(" 2: 0x104b94314 second");
       output.ok = true;`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.log).toContain("1: 0x104941aec first");
    expect(result.log).toContain("2: 0x104b94314 second");
    expect(result.log).not.toContain("frames omitted");
  });

  it("arms on a banner split across two pipe chunks", async () => {
    const ws = workspace();
    // A pipe hands over whatever the kernel had, not whatever the script
    // wrote, so the phrase that arms the collapser can arrive in halves. The
    // await between the two writes is what guarantees two `data` events.
    // Without the window the collapser never arms and roughly sixty frame lines
    // flood a step budget that is 64 KiB for the whole log.
    const script = ws.write(
      "split-banner.mjs",
      `const wait = (ms) => new Promise((r) => setTimeout(r, ms));
       process.stderr.write("FATAL ");
       await wait(60);
       process.stderr.write("ERROR: build step failed\\n");
       for (let i = 1; i <= 6; i++) process.stderr.write(\` \${i}: 0x1049\${i}1aec some symbol\\n\`);
       output.ok = true;`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.log).toContain("FATAL ERROR: build step failed");
    expect(result.log).toMatch(/\[6 V8 stack frames omitted]/);
    expect(result.log).not.toContain("0x104931aec");
  }, 30_000);

  it("flushes a partial line the collapser cannot classify rather than holding it", async () => {
    const ws = workspace();
    // Once armed the collapser buffers by line, so an unterminated write has to
    // be let go at some length or it parks until the step ends — and text the
    // script wrote *afterwards*, on the other stream, goes into the log first.
    const script = ws.write(
      "long-partial.mjs",
      `const wait = (ms) => new Promise((r) => setTimeout(r, ms));
       process.stderr.write("FATAL ERROR: build step failed\\n");
       await wait(60);
       process.stderr.write("p".repeat(10 * 1024));
       await wait(60);
       process.stdout.write("[upload finished]\\n");
       output.ok = true;`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.log.indexOf("ppp")).toBeLessThan(result.log.indexOf("[upload finished]"));
  }, 30_000);

  it("leaves frame-shaped lines from the script alone", async () => {
    const ws = workspace();
    // No fatal error printed, so nothing is a frame dump — a memory map, a
    // disassembly, any `${i}: 0x…` loop is the script's own output.
    const script = ws.write(
      "hexdump.mjs",
      `for (let i = 1; i <= 6; i++) console.error(\` \${i}: 0x1049\${i}1aec some symbol\`);
       output.ok = true;`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.log).toContain("1: 0x104911aec some symbol");
    expect(result.log).toContain("6: 0x104961aec some symbol");
    expect(result.logTruncated).toBe(false);
  });
});

describe("flow script executor — order", () => {
  const WRITES = `const wait = (ms) => new Promise((r) => setTimeout(r, ms));
     process.stderr.write("Downloading... ");
     await wait(60);
     process.stdout.write("[stdout line 1]\\n");
     await wait(60);
     process.stderr.write("done\\n");
     output.ok = true;`;

  it("keeps what the script wrote in the order it wrote it", async () => {
    const ws = workspace();
    // An unterminated stderr write — a progress indicator — must not park
    // until its newline arrives while stdout written afterwards goes first.
    const result = await executor().execute({
      scriptPath: ws.write("order.mjs", WRITES),
      projectRoot: ws.dir,
    });

    expect(result.ok).toBe(true);
    expect(result.log).toBe("Downloading... [stdout line 1]\ndone\n");
  });

  it("keeps that order when a secret is configured", async () => {
    const ws = workspace();
    // The hold-back that protects a value split across two chunks must not
    // delay text that could never be part of one: adding a secret to a flow
    // cannot reorder its log.
    const result = await executor().execute({
      scriptPath: ws.write("order.mjs", WRITES),
      projectRoot: ws.dir,
      secrets: [{ name: "TOK", value: "0123456789abcdef0123456789abcdef" }],
    });

    expect(result.log).toBe("Downloading... [stdout line 1]\ndone\n");
  });

  it("keeps that order when the held tail is a prefix of the secret", async () => {
    const ws = workspace();
    // The trigger the fixture above cannot reach: the unterminated write ends
    // in a character that *starts* a configured value, so the tail really is
    // held. The hold-back is per stream and the buffer is shared, so the held
    // text was re-emitted after everything the other stream wrote in between —
    // one coincidental character was enough to move it to the end of the log.
    const source = `const wait = (ms) => new Promise((r) => setTimeout(r, ms));
       process.stderr.write("Resolving packages: 42% h");
       await wait(60);
       process.stdout.write("installed 128 packages\\n");
       await wait(60);
       process.stderr.write("\\n");`;
    const result = await executor().execute({
      scriptPath: ws.write("prefix-order.mjs", source),
      projectRoot: ws.dir,
      secrets: [{ name: "TOK", value: "hunter2-abcdef0123456789" }],
    });

    expect(result.log).toBe("Resolving packages: 42% hinstalled 128 packages\n\n");
  });

  it("redacts a value the two streams wrote half of each, in place", async () => {
    const ws = workspace();
    // The same hold-back, doing its job across streams. Ten characters of the
    // value were released to the end of the log while its tail sat in the
    // middle, so neither the streaming pass nor the final one could match it
    // and both halves reached the report.
    const source = `const wait = (ms) => new Promise((r) => setTimeout(r, ms));
       process.stdout.write("token=sk-live-9d");
       await wait(60);
       process.stderr.write("3f0a1b2c3d4e5f\\n");`;
    const result = await executor().execute({
      scriptPath: ws.write("split-order.mjs", source),
      projectRoot: ws.dir,
      secrets: [{ name: "TOKEN", value: "sk-live-9d3f0a1b2c3d4e5f" }],
    });

    expect(result.log).toBe("token={{secret:TOKEN}}\n");
  });
});

describe("flow script executor — redaction", () => {
  const SECRET: FlowScriptSecret = { name: "API_KEY", value: "s3cr3t-token-value" };

  it("replaces a secret written in one piece", async () => {
    const ws = workspace();
    const script = ws.write("plain.mjs", `console.log("auth: " + process.env.API_KEY);`);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { API_KEY: SECRET.value },
      secrets: [SECRET],
    });

    expect(result.log).not.toContain(SECRET.value);
    expect(result.log).toContain("auth: {{secret:API_KEY}}");
  });

  it("replaces a secret in the failure message and stack, not only in the log", async () => {
    const ws = workspace();
    // The author never writes the value into a string: `assert` quotes both
    // sides for them, and the error is what carries it out of the process.
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
    // The shape that carries a credential furthest: an API echoes back what it
    // was given, the script stores the response, and the document outlives the
    // report because later steps read it.
    const script = ws.write(
      "echo.mjs",
      `const key = process.env.API_KEY;
       console.log("using " + key);
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

  it("replaces a secret split across two pipe chunks", async () => {
    const ws = workspace();
    // Two writes with a gap between them arrive as two chunks, so a per-chunk
    // replacement would see neither half of the value.
    const script = ws.write(
      "split.mjs",
      `const value = process.env.API_KEY;
       process.stdout.write("auth: " + value.slice(0, 6));
       await new Promise((r) => setTimeout(r, 120));
       process.stdout.write(value.slice(6) + "\\n");
       output.ok = true;`
    );
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { API_KEY: SECRET.value },
      secrets: [SECRET],
    });

    expect(result.ok).toBe(true);
    expect(result.log).not.toContain(SECRET.value);
    expect(result.log).toContain("auth: {{secret:API_KEY}}");
  });

  it("replaces the longer of two nested secrets when the chunk splits between them", async () => {
    const ws = workspace();
    // The case the longest-first replacement exists for, one layer up: the
    // host is a secret and so is the URL containing it. Scrubbing the chunk
    // before measuring the hold-back rewrote the host to its placeholder, so
    // the chunk no longer ended in anything that could grow into the URL — the
    // whole chunk went out and the URL's high-entropy tail reached the report.
    const host: FlowScriptSecret = { name: "HOST", value: "api.internal.example.com" };
    const url: FlowScriptSecret = {
      name: "URL",
      value: `https://${host.value}/tenant/9f3a0b1c2d3e4f50`,
    };
    const script = ws.write(
      "nested.mjs",
      `process.stdout.write("calling https://" + ${JSON.stringify(host.value)});
       await new Promise((r) => setTimeout(r, 120));
       process.stdout.write("/tenant/9f3a0b1c2d3e4f50\\n");
       output.ok = true;`
    );
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      secrets: [host, url],
    });

    expect(result.ok).toBe(true);
    expect(result.log).toBe("calling {{secret:URL}}\n");
  });

  it("keeps a secret that straddles the truncation cut out of the report", async () => {
    const ws = workspace();
    // The cap keeps the earliest bytes, so a value straddling the cut would
    // leave its prefix behind — and a whole-value replacement matches no prefix.
    // Redaction therefore has to run before the cap, not after it.
    const script = ws.write(
      "straddle.mjs",
      `process.stdout.write("f".repeat(${SCRIPT_STEP_LOG_LIMIT_BYTES} - 6));
       process.stdout.write(process.env.API_KEY + "\\n");
       output.ok = true;`
    );
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { API_KEY: SECRET.value },
      secrets: [SECRET],
    });

    expect(result.ok).toBe(true);
    expect(result.logTruncated).toBe(true);
    expect(result.log).not.toContain(SECRET.value);
    expect(result.log).not.toContain(SECRET.value.slice(0, 8));
  });

  it("keeps a secret that straddles the failure-message ceiling out of the report", async () => {
    const ws = workspace();
    // The same truncation boundary the log capture scrubs ahead of, arriving
    // from the other side: the child clamps the message — it is the only side
    // that can bound what crosses the channel — and the child has no secret
    // list, so a value cut in half leaves a prefix nothing matches.
    const script = ws.write(
      "long-throw.mjs",
      `throw new Error(
         "p".repeat(${SCRIPT_MAX_FAILURE_MESSAGE_CHARS} - 16) + process.env.API_KEY + " trailing"
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
    // Still says it was cut, and now says so for the dropped prefix too.
    expect(result.failure?.message).toMatch(/… \[\d+ more characters omitted]$/);
    expect(result.failure?.stack).not.toContain(SECRET.value.slice(0, 8));
  });

  it("redacts a value that straddled a chunk boundary before its secret was known", async () => {
    const ws = workspace();
    const value = "sk-live-9d3f0a1b2c3d4e5f6071";
    // The hold-back can only cover values it knows about at that chunk. Here
    // the head is released while the set is still empty and the tail arrives
    // after the run resolved the secret, so neither half matches on its own.
    const script = ws.write(
      "straddles.mjs",
      `const value = ${JSON.stringify(value)};
       process.stdout.write("Authorization: Bearer " + value.slice(0, 10));
       await new Promise((r) => setTimeout(r, 400));
       process.stdout.write(value.slice(10) + "\\n");
       output.ok = true;`
    );
    const secrets: FlowScriptSecret[] = [];
    const pending = executor().execute({ scriptPath: script, projectRoot: ws.dir, secrets });
    setTimeout(() => secrets.push({ name: "TOKEN", value }), 200);
    const result = await pending;

    expect(result.log).not.toContain(value);
    expect(result.log).toContain("Bearer {{secret:TOKEN}}");
  });

  it("reads the secret set live, so a value added mid-run still redacts", async () => {
    const ws = workspace();
    const script = ws.write(
      "later.mjs",
      `console.log("first: " + process.env.EARLY);
       await new Promise((r) => setTimeout(r, 150));
       console.log("second: " + process.env.LATE);
       output.ok = true;`
    );
    const secrets: FlowScriptSecret[] = [{ name: "EARLY", value: "early-value-aaaa" }];
    const pending = executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { EARLY: "early-value-aaaa", LATE: "late-value-bbbb" },
      secrets,
    });
    // The set is run-scoped and grows as the run resolves more placeholders.
    // Pushed from a later turn of the loop, after the step has read it once:
    // pushing in the same turn as the call lands before `runOne` ever looks, so
    // an implementation that snapshotted the array once would pass.
    setTimeout(() => secrets.push({ name: "LATE", value: "late-value-bbbb" }), 60);
    const result = await pending;

    expect(result.log).toContain("first: {{secret:EARLY}}");
    expect(result.log).toContain("second: {{secret:LATE}}");
  });
});
