// Hand-written types for the vendored Perfetto RPC decoder
// (`assets/trace-processor/engine.mjs`, an esbuild of `@lynx-js/trace-processor`'s
// `vendor/perfetto/engine.js`). It is loaded by path at runtime, so TypeScript
// cannot associate it with its own `.d.ts`. Only the subset
// `wasm-trace-processor.ts` uses is typed; resync on a Perfetto bump.

/** Integers arrive as `bigint`, floats as `number`. */
export type SqlValue = string | number | bigint | null | Uint8Array;

export interface RowIteratorBase {
  valid(): boolean;
  next(): void;
  get(columnName: string): SqlValue;
}

export interface QueryResult {
  iter(spec: object): RowIteratorBase;
  /** Non-empty string when the statement failed; undefined on success. */
  error(): string | undefined;
  numRows(): number;
  columns(): string[];
}

/** Instance surface of the abstract `EngineBase` we subclass. */
export interface EngineBaseInstance {
  parse(data: Uint8Array): Promise<void>;
  notifyEof(): Promise<void>;
  query(sql: string, tag?: string): Promise<QueryResult>;
  /** Feed an RPC response frame back into the decoder. */
  onRpcResponseBytes(data: Uint8Array): void;
}

/**
 * `EngineBase` is abstract upstream and the compiled bundle erases that, so it is
 * typed here as a concrete zero-arg constructor, with the abstract members
 * supplied by the subclass.
 */
export interface EngineBaseCtor {
  new (): EngineBaseInstance;
  readonly prototype: EngineBaseInstance;
}

/** Shape of the dynamically-imported `engine.mjs` module. */
export interface PerfettoEngineModule {
  EngineBase: EngineBaseCtor;
}
