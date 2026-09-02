import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  FlowScriptExecutor,
  type FlowScriptResult,
} from "../../../src/tools/flows/script/flow-script-executor";
import {
  SCRIPT_MAX_FAILURE_MESSAGE_CHARS,
  SCRIPT_MAX_OUTPUT_BYTES,
} from "../../../src/tools/flows/script/flow-script-protocol";
import { createScriptWorkspace, type ScriptWorkspace } from "../../helpers/flow-script-workspace";

const workspaces: ScriptWorkspace[] = [];

function workspace(): ScriptWorkspace {
  const ws = createScriptWorkspace("out");
  workspaces.push(ws);
  return ws;
}

afterEach(() => {
  while (workspaces.length) workspaces.pop()!.cleanup();
});

async function run(source: string): Promise<FlowScriptResult> {
  const ws = workspace();
  const script = ws.write("script.mjs", source);
  return new FlowScriptExecutor({ concurrency: 4, maxTimeoutMs: 60_000 }).execute({
    scriptPath: script,
    projectRoot: ws.dir,
  });
}

describe("flow script executor — output validation", () => {
  it("accepts objects, arrays, strings, finite numbers, booleans and null", async () => {
    const result = await run(
      `output.doc = { list: [1, "two", true, null, { nested: 1.5 }], empty: {} };`
    );
    expect(result.failure).toBeUndefined();
    expect(result.output).toEqual({
      doc: { list: [1, "two", true, null, { nested: 1.5 }], empty: {} },
    });
  });

  it("takes a replaced binding, not only a mutated one", async () => {
    const result = await run(`output.seeded = 1; output = { replaced: true };`);
    expect(result.output).toEqual({ replaced: true });
  });

  it.each([
    ["NaN", `output.user = { age: NaN };`, "output.user.age is NaN; output numbers must be finite"],
    [
      "Infinity",
      `output.ratio = Infinity;`,
      "output.ratio is Infinity; output numbers must be finite",
    ],
    [
      "a function",
      `output.items = [1, 2, { handler: () => {} }];`,
      "output.items[2].handler is a function; output must be JSON-compatible data",
    ],
    [
      "undefined",
      `output.missing = undefined;`,
      "output.missing is undefined; output must be JSON-compatible data",
    ],
    ["a BigInt", `output.big = 1n;`, "output.big is a BigInt; output must be JSON-compatible data"],
    [
      "a symbol",
      `output.tag = Symbol("x");`,
      "output.tag is a symbol; output must be JSON-compatible data",
    ],
    [
      "a Date",
      `output.createdAt = new Date();`,
      "output.createdAt is a Date; output must be JSON-compatible data (use an ISO string)",
    ],
    [
      "a Map",
      `output.index = new Map();`,
      "output.index is a Map; output must be JSON-compatible data",
    ],
    [
      "a Set",
      `output.seen = new Set();`,
      "output.seen is a Set; output must be JSON-compatible data",
    ],
    [
      "a class instance",
      `class Order {}; output.order = new Order();`,
      "output.order is a Order; output must be JSON-compatible data",
    ],
  ])("rejects %s, naming its exact path", async (_label, source, expected) => {
    const result = await run(source);
    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe("output");
    expect(result.failure?.message).toBe(expected);
  });

  it("rejects a cycle rather than crashing on it", async () => {
    const result = await run(`const node = { name: "a" }; node.parent = node; output.node = node;`);
    expect(result.failure?.kind).toBe("output");
    expect(result.failure?.message).toBe(
      "output.node.parent is a cyclic reference; output must be a tree"
    );
  });

  it("rejects a cycle reached through toJSON", async () => {
    const result = await run(`const a = { toJSON() { return a; } }; output.a = a;`);
    expect(result.failure?.kind).toBe("output");
    expect(result.failure?.message).toBe("output.a is a cyclic reference; output must be a tree");
  });

  it("accepts the same object twice in different branches", async () => {
    const result = await run(`const shared = { id: 1 }; output.a = shared; output.b = shared;`);
    expect(result.failure).toBeUndefined();
    expect(result.output).toEqual({ a: { id: 1 }, b: { id: 1 } });
  });

  it("quotes a key that is not an identifier", async () => {
    const result = await run(`output["a key"] = { "b.c": NaN };`);
    expect(result.failure?.message).toBe(
      'output["a key"]["b.c"] is NaN; output numbers must be finite'
    );
  });

  it("rejects an output replaced with something that is not a document", async () => {
    const result = await run(`output = "done";`);
    expect(result.failure?.kind).toBe("output");
    expect(result.failure?.message).toBe("output is a string; output must be a plain object");
  });

  it("rejects output above the 1 MiB encoded limit", async () => {
    const result = await run(`output.blob = "x".repeat(1024 * 1024 + 10);`);
    expect(result.failure?.kind).toBe("output");
    expect(result.failure?.message).toMatch(/^output is 1\.0 MiB encoded; the limit is 1\.0 MiB$/);
  });

  it("accepts output just under the limit", async () => {
    const result = await run(`output.blob = "x".repeat(1024 * 1000);`);
    expect(result.failure).toBeUndefined();
    expect((result.output?.blob as string).length).toBe(1024 * 1000);
  });

  it("accepts output of exactly the limit", async () => {
    // `{"blob":"…"}` is 11 characters around the payload, all single-byte, so
    // this document encodes to the limit itself — the one size at which the
    // bound and the document agree, and the one neither the runner's copy of
    // the check nor the executor's is exercised at.
    const payload = SCRIPT_MAX_OUTPUT_BYTES - `{"blob":""}`.length;
    const result = await run(`output.blob = "x".repeat(${payload});`);

    expect(result.failure).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(result.output), "utf8")).toBe(SCRIPT_MAX_OUTPUT_BYTES);
  });

  it("encodes a sparse array the way JSON.stringify does", async () => {
    const result = await run(`const a = []; a[2] = "third"; output.a = a;`);
    expect(result.failure).toBeUndefined();
    expect(result.output).toEqual({ a: [null, null, "third"] });
  });

  it("validates what toJSON will actually encode", async () => {
    const withToJson = await run(`output.point = { x: 1, toJSON() { return { x: 1, y: 2 }; } };`);
    expect(withToJson.failure).toBeUndefined();
    expect(withToJson.output).toEqual({ point: { x: 1, y: 2 } });

    const smuggled = await run(`output.toJSON = () => ({ fn: () => {} });`);
    expect(smuggled.failure?.kind).toBe("output");
  });

  it("commits the value it validated, not the one a second read returns", async () => {
    const getter = await run(
      `let n = 0;
       output.data = { get id() { n++; return n === 1 ? 1 : NaN; } };`
    );
    expect(getter.failure).toBeUndefined();
    expect(getter.output).toEqual({ data: { id: 1 } });

    const toJson = await run(
      `let n = 0;
       output.wrapped = { toJSON() { n++; return n === 1 ? { fine: true } : { swapped: true }; } };`
    );
    expect(toJson.failure).toBeUndefined();
    expect(toJson.output).toEqual({ wrapped: { fine: true } });
  });

  it("still rejects a Date, which has a toJSON of its own", async () => {
    const result = await run(`output.at = new Date();`);
    expect(result.failure?.kind).toBe("output");
    expect(result.failure?.message).toContain("use an ISO string");
  });

  it("rejects an own __proto__ key rather than passing it into flow state", async () => {
    const result = await run(`output.settings = JSON.parse('{"__proto__": {"admin": true}}');`);
    expect(result.failure?.kind).toBe("output");
    expect(result.failure?.message).toContain("__proto__");
  });

  it("encodes with the JSON.stringify that existed before the script ran", async () => {
    const swapped = await run(
      `JSON.stringify = () => '{"fake":true}';
       output.real = "what the script actually wrote";`
    );
    expect(swapped.failure).toBeUndefined();
    expect(swapped.output).toEqual({ real: "what the script actually wrote" });

    const smuggled = await run(
      `JSON.stringify = () => '{"__proto__":{"polluted":1},"ok":1}';
       output.real = true;`
    );
    expect(smuggled.failure).toBeUndefined();
    expect(Object.keys(smuggled.output ?? {})).toEqual(["real"]);
  });

  it("reports an output it could not even read", async () => {
    const result = await run(
      `output.account = { get id() { throw new Error("lazy field exploded"); } };`
    );
    expect(result.failure?.kind).toBe("output");
    expect(result.failure?.message).toContain("could not be read");
    expect(result.failure?.message).toContain("lazy field exploded");
  });

  it("bounds a failure message and stack, the last unbounded fields on the channel", async () => {
    const result = await run(
      `throw new Error("Unexpected response: " + "y".repeat(8 * 1024 * 1024));`
    );

    expect(result.failure?.kind).toBe("runtime");
    expect(result.failure?.message.length).toBeLessThan(9 * 1024);
    expect(result.failure?.message).toContain("more characters omitted");
    expect(result.failure?.stack?.length).toBeLessThan(17 * 1024);
  }, 30_000);

  it("refuses a caller output document that cannot be encoded, without spawning", async () => {
    const ws = workspace();
    const marker = ws.resolve("ran.txt");
    const script = ws.write(
      "noop.mjs",
      `import fs from "node:fs";
       fs.writeFileSync(${JSON.stringify(marker)}, "ran");`
    );
    const cyclic: Record<string, unknown> = { flow: "seed" };
    cyclic.itself = cyclic;

    const fromCyclic = await new FlowScriptExecutor({
      concurrency: 4,
      maxTimeoutMs: 60_000,
    }).execute({ scriptPath: script, projectRoot: ws.dir, output: cyclic });
    expect(fromCyclic.failure?.kind).toBe("invalid");
    expect(fromCyclic.failure?.message).toContain("could not be encoded for the script");

    const fromBigInt = await new FlowScriptExecutor({
      concurrency: 4,
      maxTimeoutMs: 60_000,
    }).execute({ scriptPath: script, projectRoot: ws.dir, output: { total: 42n } });
    expect(fromBigInt.failure?.kind).toBe("invalid");

    expect(fs.existsSync(marker)).toBe(false);
  });

  it("says how much of a clamped message was really dropped", async () => {
    const body = "y".repeat(1_000_000);
    const thrown = `Unexpected response: ${body}`;
    const result = await run(`throw new Error("Unexpected response: " + "y".repeat(1000000));`);

    const message = result.failure?.message ?? "";
    const omitted = /… \[(\d+) more characters omitted]$/.exec(message);
    expect(result.failure?.kind).toBe("runtime");
    expect(message.length).toBe(SCRIPT_MAX_FAILURE_MESSAGE_CHARS);
    expect(Number(omitted?.[1])).toBe(thrown.length - (message.length - omitted![0].length));
  }, 30_000);
});
