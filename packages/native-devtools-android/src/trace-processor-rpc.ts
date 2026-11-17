// Minimal client for Perfetto trace-processor's RPC protocol: the subset argent
// uses (append trace data, finalize, streaming query). Wire format from
// protos/perfetto/trace_processor/trace_processor.proto at PERFETTO_VERSION.
//
// The behaviour (request framing, sequence-id check, fatal_error handling,
// streaming QueryResult / CellsBatch decoding, int64 cells as bigint) is ported
// from the Perfetto UI's engine.ts, query_result.ts and proto_ring_buffer.ts.
// Copyright (C) 2018 The Android Open Source Project. Licensed under the
// Apache License, Version 2.0; the Perfetto LICENSE ships with the wasm.

/** Integers arrive as `bigint`, floats as `number`. */
export type SqlValue = string | number | bigint | null | Uint8Array;

/** A fully received query result. */
export interface QueryResult {
  columns: string[];
  rows: SqlValue[][];
}

// TraceProcessorRpc.TraceProcessorMethod
const TPM_APPEND_TRACE_DATA = 1;
const TPM_FINALIZE_TRACE_DATA = 2;
const TPM_QUERY_STREAMING = 3;

// QueryResult.CellsBatch.CellType
const CELL_NULL = 1;
const CELL_VARINT = 2;
const CELL_FLOAT64 = 3;
const CELL_STRING = 4;
const CELL_BLOB = 5;

const WIRE_VARINT = 0;
const WIRE_I64 = 1;
const WIRE_LEN = 2;
const WIRE_I32 = 5;

const MAX_MSG_SIZE = 1024 * 1024 * 1024;

const utf8Encoder = new TextEncoder();
// Cell strings go through a default TextDecoder, as in the Perfetto UI.
const cellDecoder = new TextDecoder();
// Other strings (column names, errors) were decoded by protobufjs, which keeps a BOM.
const fieldDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

// --- Encoding ---

function varintBytes(n: number): number[] {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return out;
}

function concat(parts: ArrayLike<number>[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function lenField(field: number, payload: Uint8Array): ArrayLike<number>[] {
  return [varintBytes(field * 8 + WIRE_LEN), varintBytes(payload.length), payload];
}

/**
 * One TraceProcessorRpcStream frame holding a single TraceProcessorRpc:
 * `{seq = 1, request = 2, [argsField] = args}`.
 */
export function encodeRpcRequest(
  seq: number,
  method: number,
  argsField?: number,
  args?: Uint8Array
): Uint8Array {
  const parts: ArrayLike<number>[] = [[0x08], varintBytes(seq), [0x10], varintBytes(method)];
  if (argsField !== undefined && args) parts.push(...lenField(argsField, args));
  const rpc = concat(parts);
  return concat(lenField(1, rpc));
}

// --- Decoding ---

class Reader {
  pos: number;
  constructor(
    readonly buf: Uint8Array,
    pos = 0,
    readonly end = buf.length
  ) {
    this.pos = pos;
  }

  varint(): number {
    let result = 0;
    let mul = 1;
    for (;;) {
      if (this.pos >= this.end) throw new Error("Index out of range");
      const b = this.buf[this.pos++];
      result += (b & 0x7f) * mul;
      if (b < 0x80) return result;
      mul *= 0x80;
    }
  }

  /** Signed 64-bit varint as a bigint (two's complement, like proto int64). */
  int64(): bigint {
    const buf = this.buf;
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new Error("Index out of range");
      const b = buf[this.pos++];
      if (i < 4) lo |= (b & 0x7f) << (i * 7);
      else if (i === 4) {
        lo |= (b & 0x7f) << 28;
        hi = (b & 0x7f) >> 4;
      } else hi |= (b & 0x7f) << ((i - 5) * 7 + 3);
      if (b < 0x80) {
        return BigInt.asIntN(64, (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0));
      }
    }
    throw new Error("invalid varint encoding");
  }

  bytes(): Uint8Array {
    const len = this.varint();
    const start = this.pos;
    this.pos += len;
    if (this.pos > this.end) throw new Error("Index out of range");
    return this.buf.subarray(start, this.pos);
  }

  skip(wireType: number): void {
    if (wireType === WIRE_VARINT) this.varint();
    else if (wireType === WIRE_I64) this.pos += 8;
    else if (wireType === WIRE_LEN) this.bytes();
    else if (wireType === WIRE_I32) this.pos += 4;
    else throw new Error(`invalid wire type ${wireType} at offset ${this.pos}`);
  }
}

function lenOnly(wireType: number): void {
  if (wireType !== WIRE_LEN) throw new Error("Failed assertion");
}

/** Decodes one QueryResult.CellsBatch into whole rows. */
function decodeBatch(batch: Uint8Array, numColumns: number): { rows: SqlValue[][]; last: boolean } {
  const r = new Reader(batch);
  let cellTypes: Uint8Array = new Uint8Array(0);
  let varints = new Reader(batch, 0, 0);
  let floats = new Float64Array(0);
  const blobs: Uint8Array[] = [];
  let strings: string[] = [];
  let last = false;
  while (r.pos < r.end) {
    const tag = r.varint();
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (field >= 1 && field <= 5) lenOnly(wire);
    if (field === 1) cellTypes = r.bytes();
    else if (field === 2) {
      const packed = r.bytes();
      varints = new Reader(batch, packed.byteOffset - batch.byteOffset, r.pos);
    } else if (field === 3) {
      const packed = r.bytes();
      if (packed.length % 8 !== 0) throw new Error("Failed assertion");
      floats = new Float64Array(packed.slice().buffer);
    } else if (field === 4) blobs.push(r.bytes().slice());
    else if (field === 5) strings = cellDecoder.decode(r.bytes()).split("\0");
    else if (field === 6) last = r.varint() !== 0;
    else r.skip(wire);
  }

  const numCells = cellTypes.length;
  if (numColumns === 0 ? numCells !== 0 : numCells % numColumns !== 0) {
    throw new Error("Failed assertion");
  }
  const rows: SqlValue[][] = [];
  let f = 0;
  let s = 0;
  let b = 0;
  for (let i = 0; i < numCells; i += numColumns) {
    const row: SqlValue[] = new Array(numColumns);
    for (let c = 0; c < numColumns; c++) {
      const type = cellTypes[i + c];
      if (type === CELL_NULL) row[c] = null;
      else if (type === CELL_VARINT) row[c] = varints.int64();
      else if (type === CELL_FLOAT64) row[c] = floats[f++];
      else if (type === CELL_STRING) row[c] = strings[s++];
      else if (type === CELL_BLOB) row[c] = blobs[b++];
      else throw new Error(`Invalid cell type ${type}`);
    }
    rows.push(row);
  }
  return { rows, last };
}

interface Deferred<T> {
  resolve(value: T): void;
  reject(err: Error): void;
}

function deferred<T>(): Deferred<T> & { promise: Promise<T> } {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A query whose batches are still arriving. */
class PendingQuery {
  readonly result: QueryResult = { columns: [], rows: [] };
  error: string | undefined;
  complete = false;
  constructor(readonly done: Deferred<QueryResult>) {}

  /** Appends one proto-encoded QueryResult message. */
  append(msg: Uint8Array): void {
    const r = new Reader(msg);
    const { columns } = this.result;
    const columnsEmptyAtStart = columns.length === 0;
    const seen = new Set<string>();
    while (r.pos < r.end) {
      const tag = r.varint();
      const field = Math.floor(tag / 8);
      if (field === 1) {
        if (!columnsEmptyAtStart) throw new Error("Failed assertion");
        const orig = fieldDecoder.decode(r.bytes());
        let name = orig;
        for (let i = 1; seen.has(name); i++) name = `${orig}_${i}`;
        seen.add(name);
        columns.push(name);
      } else if (field === 2) {
        const err = fieldDecoder.decode(r.bytes());
        this.error = err.length ? err : undefined;
      } else if (field === 3) {
        const batch = decodeBatch(r.bytes(), columns.length);
        this.complete = batch.last;
        for (const row of batch.rows) this.result.rows.push(row);
      } else r.skip(tag & 7);
    }
  }
}

/**
 * Speaks trace-processor RPC over a byte pipe. The subclass sends request frames
 * (`rpcSendRequestBytes`) and feeds every reply chunk to `onRpcResponseBytes`,
 * which throws synchronously on a framing error, a sequence mismatch or a
 * `fatal_error` from the engine.
 */
export abstract class TraceProcessorRpc {
  private txSeqId = 0;
  private rxSeqId = 0;
  private rxBuf = new Uint8Array(0);
  private readonly pendingParses: Deferred<void>[] = [];
  private readonly pendingEofs: Deferred<void>[] = [];
  private readonly pendingQueries: PendingQuery[] = [];
  /** Reason of the first fatal failure, if any. */
  failed: string | undefined;

  protected abstract rpcSendRequestBytes(data: Uint8Array): void;

  /** Pushes a chunk of trace data. Each call must stay under 64 MiB. */
  parse(data: Uint8Array): Promise<void> {
    const d = deferred<void>();
    this.pendingParses.push(d);
    this.send(TPM_APPEND_TRACE_DATA, 101, data);
    return d.promise;
  }

  /** Signals the end of the trace, after the last parse(). */
  notifyEof(): Promise<void> {
    const d = deferred<void>();
    this.pendingEofs.push(d);
    this.send(TPM_FINALIZE_TRACE_DATA);
    return d.promise;
  }

  /** Runs SQL; resolves once every batch arrived, rejects with the SQL error. */
  query(sql: string): Promise<QueryResult> {
    const d = deferred<QueryResult>();
    this.pendingQueries.push(new PendingQuery(d));
    // QueryArgs { sql_query = 1 }
    this.send(TPM_QUERY_STREAMING, 103, concat(lenField(1, utf8Encoder.encode(sql))));
    return d.promise;
  }

  private send(method: number, argsField?: number, args?: Uint8Array): void {
    this.rpcSendRequestBytes(encodeRpcRequest(this.txSeqId++, method, argsField, args));
  }

  onRpcResponseBytes(data: Uint8Array): void {
    const buf = this.rxBuf.length ? concat([this.rxBuf, data]) : data;
    let pos = 0;
    for (;;) {
      const msg = this.nextFrame(buf, pos);
      if (!msg) break;
      pos = msg.byteOffset - buf.byteOffset + msg.length;
      this.onRpcResponseMessage(msg);
    }
    this.rxBuf = buf.slice(pos);
  }

  // A frame is a TraceProcessorRpcStream.msg field: tag 0x0a, varint size, body.
  private nextFrame(buf: Uint8Array, pos: number): Uint8Array | undefined {
    if (pos >= buf.length) return undefined;
    const tag = buf[pos];
    if (tag >= 128 || (tag & 7) !== WIRE_LEN) {
      throw new Error(`RPC framing error, unexpected tag ${tag} @ offset ${pos}`);
    }
    const r = new Reader(buf, pos + 1);
    let len: number;
    try {
      len = r.varint();
    } catch {
      return undefined; // size varint not fully received yet
    }
    if (len >= MAX_MSG_SIZE) {
      throw new Error(`RPC framing error, message too large (${len} > ${MAX_MSG_SIZE}`);
    }
    if (r.pos + len > buf.length) return undefined;
    return buf.subarray(r.pos, r.pos + len);
  }

  private onRpcResponseMessage(msg: Uint8Array): void {
    const r = new Reader(msg);
    let seq = 0;
    let fatalError: string | undefined;
    let response: number | undefined;
    let args: Uint8Array | undefined;
    while (r.pos < r.end) {
      const tag = r.varint();
      const field = Math.floor(tag / 8);
      if (field === 1) seq = r.varint();
      else if (field === 5) fatalError = fieldDecoder.decode(r.bytes());
      else if (field === 3) response = r.varint();
      else if (field === 201 || field === 203 || field === 212) args = r.bytes();
      else r.skip(tag & 7);
    }

    if (fatalError) this.fail(fatalError);
    if (seq !== this.rxSeqId + 1 && this.rxSeqId !== 0 && seq !== 0) {
      this.fail(`RPC sequence id mismatch cur=${seq} last=${this.rxSeqId} (ERR:rpc_seq)`);
    }
    this.rxSeqId = seq;

    if (response === TPM_APPEND_TRACE_DATA || response === TPM_FINALIZE_TRACE_DATA) {
      // AppendTraceDataResult { error = 2 }, FinalizeDataResult { error = 1 }.
      const errorField = response === TPM_APPEND_TRACE_DATA ? 2 : 1;
      const queue = response === TPM_APPEND_TRACE_DATA ? this.pendingParses : this.pendingEofs;
      const pending = queue.shift();
      if (!pending) throw new Error(`Unexpected response ${response} with no pending request`);
      let error = "";
      if (args) {
        const a = new Reader(args);
        while (a.pos < a.end) {
          const tag = a.varint();
          if (Math.floor(tag / 8) === errorField) error = fieldDecoder.decode(a.bytes());
          else a.skip(tag & 7);
        }
      }
      if (error.length > 0) pending.reject(new Error(error));
      else pending.resolve();
    } else if (response === TPM_QUERY_STREAMING) {
      const pending = this.pendingQueries[0];
      if (!pending) throw new Error("Unexpected query result with no pending query");
      pending.append(args ?? new Uint8Array(0));
      if (pending.complete) {
        this.pendingQueries.shift();
        if (pending.error === undefined) pending.done.resolve(pending.result);
        else pending.done.reject(new Error(pending.error));
      }
    }
  }

  private fail(reason: string): never {
    this.failed = reason;
    throw new Error(reason);
  }
}
