import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  FlowScriptExecutor,
  type FlowScriptResult,
} from "../../../src/tools/flows/script/flow-script-executor";
import { SCRIPT_MAX_FAILURE_MESSAGE_CHARS } from "../../../src/tools/flows/script/flow-script-protocol";
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

/** Run `source` as a script and return the executor's result. */
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
    // Both spellings are legal, and `output = …` resolves to the global
    // property. Reading a reference captured before the import would silently
    // keep the pre-replacement value.
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

  it("encodes a sparse array the way JSON.stringify does", async () => {
    // `JSON.stringify` writes a hole as null; rejecting it named an index the
    // author never wrote.
    const result = await run(`const a = []; a[2] = "third"; output.a = a;`);
    expect(result.failure).toBeUndefined();
    expect(result.output).toEqual({ a: [null, null, "third"] });
  });

  it("validates what toJSON will actually encode", async () => {
    const withToJson = await run(`output.point = { x: 1, toJSON() { return { x: 1, y: 2 }; } };`);
    expect(withToJson.failure).toBeUndefined();
    expect(withToJson.output).toEqual({ point: { x: 1, y: 2 } });

    // And the other direction: a toJSON that hands back something unencodable
    // used to slip past a walk of the object itself.
    const smuggled = await run(`output.toJSON = () => ({ fn: () => {} });`);
    expect(smuggled.failure?.kind).toBe("output");
  });

  it("commits the value it validated, not the one a second read returns", async () => {
    // Every accessor on the document is free to answer differently the second
    // time. Validating the live object and then encoding it again read each of
    // these twice, so the value that shipped was never the value that passed —
    // the silent-`null` corruption the validator exists to prevent.
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
    // `JSON.parse` creates this as an own key, so `output.settings =
    // JSON.parse(untrustedBody)` carries it through — inert under a spread, a
    // prototype write under Object.assign.
    const result = await run(`output.settings = JSON.parse('{"__proto__": {"admin": true}}');`);
    expect(result.failure?.kind).toBe("output");
    expect(result.failure?.message).toContain("__proto__");
  });

  it("encodes with the JSON.stringify that existed before the script ran", async () => {
    // The realistic trigger is accidental: any instrumentation, polyfill or
    // serialization shim in the dependency tree that wraps `JSON.stringify`.
    // Reading it off the global at encode time committed a document the script
    // never wrote, and carried an own `__proto__` key past both validators.
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
    // A throwing getter or a Proxy trap: the walk itself is what fails, and the
    // step must still get a verdict rather than a crash.
    const result = await run(
      `output.account = { get id() { throw new Error("lazy field exploded"); } };`
    );
    expect(result.failure?.kind).toBe("output");
    expect(result.failure?.message).toContain("could not be read");
    expect(result.failure?.message).toContain("lazy field exploded");
  });

  it("bounds a failure message and stack, the last unbounded fields on the channel", async () => {
    // `throw new Error(\`Unexpected response: \${await res.text()}\`)` is how a
    // whole response body ends up in an error. An IPC message is deserialized
    // whole into the tool server's heap before anything can inspect it, so the
    // ceiling has to hold in the child.
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
    // The document the flow hands *in*, not the one the script hands back. It
    // is encoded before the fork and inside the setup guard, because doing it
    // after made `execute` reject with a raw TypeError — no result for the
    // caller at all — and left a child running until the time limit reaped it.
    // The marker is what proves nothing was started.
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
    // The number, not just the marker. The child clamps and marks honestly, and
    // the parent re-clamps the same field at the same ceiling as its second line
    // — so while the marker sat *outside* the ceiling, that second cut landed on
    // the same boundary, discarded the child's marker and reported the length of
    // the marker it had just dropped. A megabyte read as thirty-four characters.
    const body = "y".repeat(1_000_000);
    const thrown = `Unexpected response: ${body}`;
    const result = await run(`throw new Error("Unexpected response: " + "y".repeat(1000000));`);

    const message = result.failure?.message ?? "";
    const omitted = /… \[(\d+) more characters omitted]$/.exec(message);
    expect(result.failure?.kind).toBe("runtime");
    // The whole field fits the ceiling, marker included, so nothing re-clamps it.
    expect(message.length).toBe(SCRIPT_MAX_FAILURE_MESSAGE_CHARS);
    expect(Number(omitted?.[1])).toBe(thrown.length - (message.length - omitted![0].length));
  }, 30_000);
});
