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
    const script = ws.write(
      "wide.mjs",
      `console.log("日本語テキスト".repeat(20000));
       output.ok = true;`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.logTruncated).toBe(true);
    expect(result.log).not.toContain("\uFFFD");
    expect(Buffer.byteLength(result.log, "utf8")).toBeLessThanOrEqual(SCRIPT_STEP_LOG_LIMIT_BYTES);
  }, 30_000);

  it("never cuts a redaction marker in half", async () => {
    const ws = workspace();
    const secret: FlowScriptSecret = { name: "VERY_LONG_SECRET_NAME", value: "s3cr3t-value" };
    // Padded so the budget runs out a few characters into the marker the scrub
    // writes for the value printed right after it.
    const script = ws.write(
      "cut-marker.mjs",
      `process.stdout.write("x".repeat(${SCRIPT_STEP_LOG_LIMIT_BYTES - 6}));
       process.stdout.write(process.env.SECRET);
       output.ok = true;`
    );
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { SECRET: secret.value },
      secrets: [secret],
    });

    expect(result.logTruncated).toBe(true);
    expect(result.log).not.toContain(secret.value);
    expect(result.log.endsWith("x")).toBe(true);
    const opened = result.log.lastIndexOf("{{secret:");
    expect(opened === -1 || result.log.includes("}}", opened)).toBe(true);
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
    expect(result.logTruncated).toBe(true);
  }, 60_000);

  it("keeps a short run of frame lines verbatim, even after a fatal error", async () => {
    const ws = workspace();
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
    const result = await executor().execute({
      scriptPath: ws.write("order.mjs", WRITES),
      projectRoot: ws.dir,
    });

    expect(result.ok).toBe(true);
    expect(result.log).toBe("Downloading... [stdout line 1]\ndone\n");
  });

  it("keeps that order when a secret is configured", async () => {
    const ws = workspace();
    const result = await executor().execute({
      scriptPath: ws.write("order.mjs", WRITES),
      projectRoot: ws.dir,
      secrets: [{ name: "TOK", value: "0123456789abcdef0123456789abcdef" }],
    });

    expect(result.log).toBe("Downloading... [stdout line 1]\ndone\n");
  });

  it("keeps that order when the held tail is a prefix of the secret", async () => {
    const ws = workspace();
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

  it("keeps that order for a value that overlaps itself", async () => {
    const ws = workspace();
    const source = `const wait = (ms) => new Promise((r) => setTimeout(r, ms));
       for (const piece of ["[", "abca", "b", "]"]) {
         process.stdout.write(piece);
         await wait(60);
       }`;
    const result = await executor().execute({
      scriptPath: ws.write("self-overlap.mjs", source),
      projectRoot: ws.dir,
      secrets: [{ name: "S", value: "abcab" }],
    });

    expect(result.log).toBe("[{{secret:S}}]");
  });

  it("keeps that order for a self-overlapping value with the other stream between", async () => {
    const ws = workspace();
    const source = `const wait = (ms) => new Promise((r) => setTimeout(r, ms));
       const writes = [
         [process.stdout, "["],
         [process.stdout, "abca"],
         [process.stderr, "MID"],
         [process.stdout, "b"],
         [process.stdout, "]"],
       ];
       for (const [stream, piece] of writes) {
         stream.write(piece);
         await wait(60);
       }`;
    const result = await executor().execute({
      scriptPath: ws.write("self-overlap-streams.mjs", source),
      projectRoot: ws.dir,
      secrets: [{ name: "S", value: "abcab" }],
    });

    expect(result.log).toBe("[MID{{secret:S}}]");
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

  it("leaves a marker well formed when a value occurs inside another secret's name", async () => {
    const ws = workspace();
    const script = ws.write("marker.mjs", `console.log("value=Q");`);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      secrets: [{ name: "Q0", value: "Q" }],
    });

    expect(result.log).toBe("value={{secret:Q0}}\n");
  });

  it("leaves a marker well formed when two secrets swap name and value", async () => {
    const ws = workspace();
    const script = ws.write("swapped.mjs", `console.log("id=TOKEN_ABC and OKEN");`);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      secrets: [
        { name: "TOKEN_ABC", value: "OKEN" },
        { name: "OKEN", value: "TOKEN_ABC" },
      ],
    });

    expect(result.log).toBe("id={{secret:OKEN}} and {{secret:TOKEN_ABC}}\n");
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

  it("replaces a value that starts inside marker-shaped text the script printed", async () => {
    const ws = workspace();
    // The shape a script echoing an unresolved placeholder writes: it looks
    // like a marker, so skipping it whole would carry the value out in plain
    // text — no pass ever visits a position inside a span that was jumped.
    const script = ws.write("echoed.mjs", `console.log("head {{secret:TOK}}TAIL tail");`);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      secrets: [
        { name: "TOK", value: "tok" },
        { name: "V", value: "TOK}}TAIL" },
      ],
    });

    expect(result.log).not.toContain("TOK}}TAIL");
    expect(result.log).toContain("{{secret:V}}");
  });

  it("replaces a secret split across two pipe chunks", async () => {
    const ws = workspace();
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

  it("replaces the longer of two secrets when the shorter one is its prefix", async () => {
    const ws = workspace();
    const prefix: FlowScriptSecret = { name: "PFX", value: "sk-" };
    const full: FlowScriptSecret = { name: "FULL", value: "sk-live-9d3f0a1b" };
    // The chunk ends where both values start, so taking the short one there
    // settles it and leaves the long one's remainder for the next chunk to
    // release in plaintext.
    const script = ws.write(
      "prefix.mjs",
      `process.stdout.write("tok sk-");
       await new Promise((r) => setTimeout(r, 120));
       process.stdout.write("live-9d3f0a1b end\\n");
       output.ok = true;`
    );
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      secrets: [prefix, full],
    });

    expect(result.ok).toBe(true);
    expect(result.log).toBe("tok {{secret:FULL}} end\n");
  });

  it("replaces every occurrence of a value that starts with its own tail", async () => {
    const ws = workspace();
    const value = "0123456789".repeat(4);
    const script = ws.write(
      "periodic.mjs",
      `const block = ${JSON.stringify(value)}.repeat(128);
       for (let i = 0; i < 40; i++) process.stdout.write(block);`
    );
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      secrets: [{ name: "P", value }],
    });

    // The value is all digits and its marker has none, so a surviving digit is
    // a surviving fragment of the value.
    expect(result.log).not.toMatch(/[0-9]/);
    expect(result.log).toContain("{{secret:P}}");
  }, 30_000);

  it("keeps a secret that straddles the truncation cut out of the report", async () => {
    const ws = workspace();
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
    expect(result.failure?.message).toMatch(/… \[\d+ more characters omitted]$/);
    expect(result.failure?.stack).not.toContain(SECRET.value.slice(0, 8));
  });

  it("redacts a value that straddled a chunk boundary before its secret was known", async () => {
    const ws = workspace();
    const value = "sk-live-9d3f0a1b2c3d4e5f6071";
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
    // Pushed from a later turn of the loop, after the step has read the set
    // once: pushing in the same turn as the call lands before `runOne` ever
    // looks, so an implementation that snapshotted the array once would pass.
    setTimeout(() => secrets.push({ name: "LATE", value: "late-value-bbbb" }), 60);
    const result = await pending;

    expect(result.log).toContain("first: {{secret:EARLY}}");
    expect(result.log).toContain("second: {{secret:LATE}}");
  });
});
