import { describe, it, expect } from "vitest";
import { TraceProcessorRpc, encodeRpcRequest } from "../src/trace-processor-rpc.js";

// --- A tiny proto writer, to build engine responses by hand ---

function varint(n: number | bigint): number[] {
  let v = BigInt.asUintN(64, BigInt(n));
  const out: number[] = [];
  while (v >= 0x80n) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return out;
}
const bytes = (...parts: ArrayLike<number>[]): Uint8Array =>
  Uint8Array.from(parts.flatMap((p) => Array.from(p)));
const vField = (field: number, n: number | bigint): number[] => [
  ...varint(field * 8),
  ...varint(n),
];
const lField = (field: number, payload: ArrayLike<number> | string): Uint8Array => {
  const p = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
  return bytes(varint(field * 8 + 2), varint(p.length), p);
};

type Cell = null | bigint | number | string | Uint8Array;

/** QueryResult.CellsBatch with the cells in row-major order. */
function cellsBatch(cells: Cell[], last: boolean): Uint8Array {
  const types: number[] = [];
  const ints: number[] = [];
  const floats: number[] = [];
  const blobs: Uint8Array[] = [];
  let strings = "";
  for (const c of cells) {
    if (c === null) {
      types.push(1);
    } else if (typeof c === "bigint") {
      types.push(2);
      ints.push(...varint(c));
    } else if (typeof c === "number") {
      types.push(3);
      floats.push(c);
    } else if (typeof c === "string") {
      types.push(4);
      strings += c + "\0";
    } else {
      types.push(5);
      blobs.push(c);
    }
  }
  const f64 = new Uint8Array(new Float64Array(floats).buffer);
  return bytes(
    lField(1, types),
    ints.length ? lField(2, ints) : [],
    floats.length ? lField(3, f64) : [],
    ...blobs.map((b) => lField(4, b)),
    strings ? lField(5, strings) : [],
    vField(6, last ? 1 : 0)
  );
}

function queryResult(opts: { columns?: string[]; error?: string; batches?: Uint8Array[] }) {
  return bytes(
    ...(opts.columns ?? []).map((c) => lField(1, c)),
    opts.error !== undefined ? lField(2, opts.error) : [],
    ...(opts.batches ?? []).map((b) => lField(3, b)),
    // elapsed_time_ms (7, double): a field the client does not use.
    [0x39, 0, 0, 0, 0, 0, 0, 0xf0, 0x3f]
  );
}

/** One TraceProcessorRpcStream frame carrying a response. */
function response(
  seq: number,
  method: number,
  argsField?: number,
  args?: Uint8Array,
  fatal?: string
) {
  const rpc = bytes(
    vField(1, seq),
    fatal ? lField(5, fatal) : [],
    vField(3, method),
    argsField ? lField(argsField, args ?? []) : []
  );
  return lField(1, rpc);
}

class FakeEngine extends TraceProcessorRpc {
  sent: Uint8Array[] = [];
  private rxSeq = 1;
  protected rpcSendRequestBytes(data: Uint8Array): void {
    this.sent.push(data);
  }
  reply(method: number, argsField?: number, args?: Uint8Array): Uint8Array {
    return response(this.rxSeq++, method, argsField, args);
  }
}

const QUERY = 3;

describe("encodeRpcRequest", () => {
  it("frames seq, method and args as TraceProcessorRpcStream.msg", () => {
    // msg(1, LEN) { seq(1)=5, request(2)=1, append_trace_data(101)=[0xab, 0xcd] }
    expect(Array.from(encodeRpcRequest(5, 1, 101, Uint8Array.of(0xab, 0xcd)))).toEqual([
      0x0a, 0x09, 0x08, 0x05, 0x10, 0x01, 0xaa, 0x06, 0x02, 0xab, 0xcd,
    ]);
    // seq 0 is still written; no args for finalize.
    expect(Array.from(encodeRpcRequest(0, 2))).toEqual([0x0a, 0x04, 0x08, 0x00, 0x10, 0x02]);
  });

  it("encodes a query as QueryArgs.sql_query with multi-byte lengths and UTF-8", () => {
    const e = new FakeEngine();
    const sql = "SELECT 'ż' " + "x".repeat(200);
    void e.query(sql);
    const frame = e.sent[0]!;
    const sqlBytes = new TextEncoder().encode(sql);
    const args = lField(1, sqlBytes);
    expect(frame).toEqual(lField(1, bytes(vField(1, 0), vField(2, QUERY), lField(103, args))));
  });

  it("increments the request sequence id", () => {
    const e = new FakeEngine();
    void e.parse(Uint8Array.of(1));
    void e.notifyEof();
    void e.query("SELECT 1");
    expect(e.sent.map((f) => f[3])).toEqual([0, 1, 2]);
  });
});

describe("TraceProcessorRpc responses", () => {
  it("resolves parse and notifyEof, and rejects with the engine's error text", async () => {
    const e = new FakeEngine();
    const ok = e.parse(Uint8Array.of(1));
    const bad = e.parse(Uint8Array.of(2));
    const eof = e.notifyEof();
    e.onRpcResponseBytes(e.reply(1, 201, bytes(vField(1, 1))));
    e.onRpcResponseBytes(e.reply(1, 201, lField(2, "bad trace")));
    e.onRpcResponseBytes(e.reply(2, 212, new Uint8Array(0)));
    await expect(ok).resolves.toBeUndefined();
    await expect(bad).rejects.toThrow("bad trace");
    await expect(eof).resolves.toBeUndefined();
  });

  it("decodes every cell type, NULL, int64 edges and unicode", async () => {
    const e = new FakeEngine();
    const q = e.query("SELECT ...");
    const blob = Uint8Array.of(0, 0xff, 0x10);
    const cells: Cell[] = [
      9223372036854775807n,
      -9223372036854775808n,
      -1n,
      0n,
      4294967296n,
      2.5,
      -0,
      "héllo ☃ 😀",
      "",
      blob,
      new Uint8Array(0),
      null,
    ];
    const columns = cells.map((_, i) => `c${i}`);
    e.onRpcResponseBytes(
      e.reply(QUERY, 203, queryResult({ columns, batches: [cellsBatch(cells, true)] }))
    );
    const res = await q;
    expect(res.columns).toEqual(columns);
    expect(res.rows).toHaveLength(1);
    const row = res.rows[0]!;
    expect(row.slice(0, 5)).toEqual([
      9223372036854775807n,
      -9223372036854775808n,
      -1n,
      0n,
      4294967296n,
    ]);
    expect(typeof row[0]).toBe("bigint");
    expect(row[5]).toBe(2.5);
    expect(Object.is(row[6], -0)).toBe(true);
    expect(row.slice(7, 9)).toEqual(["héllo ☃ 😀", ""]);
    expect(row[9]).toBeInstanceOf(Uint8Array);
    expect(Array.from(row[9] as Uint8Array)).toEqual([0, 0xff, 0x10]);
    expect((row[10] as Uint8Array).length).toBe(0);
    expect(row[11]).toBeNull();
  });

  it("joins a result streamed over several batches and responses", async () => {
    const e = new FakeEngine();
    const q = e.query("SELECT i, s");
    const columns = ["i", "s"];
    const b1 = cellsBatch([1n, "a", 2n, null], false);
    const b2 = cellsBatch([3n, "c"], false);
    const b3 = cellsBatch([4n, "d"], true);
    // Two batches in the first response, the last in a second one; the second
    // frame arrives split across chunks, coalesced with nothing else.
    e.onRpcResponseBytes(e.reply(QUERY, 203, queryResult({ columns, batches: [b1, b2] })));
    const second = e.reply(QUERY, 203, queryResult({ batches: [b3] }));
    let settled = false;
    void q.then(() => (settled = true));
    e.onRpcResponseBytes(second.subarray(0, 1));
    e.onRpcResponseBytes(second.subarray(1, 5));
    await Promise.resolve();
    expect(settled).toBe(false);
    e.onRpcResponseBytes(second.subarray(5));
    expect((await q).rows).toEqual([
      [1n, "a"],
      [2n, null],
      [3n, "c"],
      [4n, "d"],
    ]);
  });

  it("decodes several frames delivered in one chunk, in request order", async () => {
    const e = new FakeEngine();
    const q1 = e.query("SELECT 1");
    const q2 = e.query("SELECT 2");
    const r1 = e.reply(
      QUERY,
      203,
      queryResult({ columns: ["x"], batches: [cellsBatch([1n], true)] })
    );
    const r2 = e.reply(
      QUERY,
      203,
      queryResult({ columns: ["x"], batches: [cellsBatch([2n], true)] })
    );
    e.onRpcResponseBytes(bytes(r1, r2));
    expect((await q1).rows).toEqual([[1n]]);
    expect((await q2).rows).toEqual([[2n]]);
  });

  it("returns an empty result with its columns", async () => {
    const e = new FakeEngine();
    const q = e.query("SELECT 1 AS x WHERE 0");
    e.onRpcResponseBytes(
      e.reply(QUERY, 203, queryResult({ columns: ["x"], batches: [cellsBatch([], true)] }))
    );
    expect(await q).toEqual({ columns: ["x"], rows: [] });
  });

  it("suffixes duplicate column names like the Perfetto UI", async () => {
    const e = new FakeEngine();
    const q = e.query("SELECT 1 AS a, 2 AS a, 3 AS a_1");
    const batch = cellsBatch([1n, 2n, 3n], true);
    e.onRpcResponseBytes(
      e.reply(QUERY, 203, queryResult({ columns: ["a", "a", "a_1"], batches: [batch] }))
    );
    expect((await q).columns).toEqual(["a", "a_1", "a_1_1"]);
  });

  it("rejects with the SQL error text, even after rows arrived", async () => {
    const e = new FakeEngine();
    const q = e.query("SELECT * FROM nope");
    const text = "Traceback (most recent call last):\n  ...\nno such table: nope";
    e.onRpcResponseBytes(
      e.reply(QUERY, 203, queryResult({ columns: ["x"], batches: [cellsBatch([1n], false)] }))
    );
    e.onRpcResponseBytes(
      e.reply(QUERY, 203, queryResult({ error: text, batches: [cellsBatch([], true)] }))
    );
    await expect(q).rejects.toThrow(new Error(text));
    // The engine keeps serving queries after an SQL error.
    const next = e.query("SELECT 2");
    e.onRpcResponseBytes(
      e.reply(QUERY, 203, queryResult({ columns: ["y"], batches: [cellsBatch([2n], true)] }))
    );
    expect((await next).rows).toEqual([[2n]]);
  });

  it("throws synchronously on a sequence id mismatch", () => {
    const e = new FakeEngine();
    void e.query("SELECT 1");
    void e.query("SELECT 2");
    const ok = response(
      1,
      QUERY,
      203,
      queryResult({ columns: ["x"], batches: [cellsBatch([1n], true)] })
    );
    e.onRpcResponseBytes(ok);
    const skipped = response(
      3,
      QUERY,
      203,
      queryResult({ columns: ["x"], batches: [cellsBatch([2n], true)] })
    );
    expect(() => e.onRpcResponseBytes(skipped)).toThrow(
      "RPC sequence id mismatch cur=3 last=1 (ERR:rpc_seq)"
    );
    expect(e.failed).toBe("RPC sequence id mismatch cur=3 last=1 (ERR:rpc_seq)");
  });

  it("throws synchronously on fatal_error and on a framing error", () => {
    const e = new FakeEngine();
    void e.parse(Uint8Array.of(1));
    expect(() =>
      e.onRpcResponseBytes(response(1, 1, 201, new Uint8Array(0), "engine crashed"))
    ).toThrow("engine crashed");
    expect(e.failed).toBe("engine crashed");
    expect(() => new FakeEngine().onRpcResponseBytes(Uint8Array.of(0x08, 0x01))).toThrow(
      "RPC framing error, unexpected tag 8 @ offset 0"
    );
  });
});
