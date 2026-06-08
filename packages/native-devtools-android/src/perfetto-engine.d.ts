// Hand-written type surface for the vendored Perfetto RPC decoder
// (`assets/trace-processor/engine.mjs`, an esbuild of `@lynx-js/trace-processor`'s
// `vendor/perfetto/engine.js`). The decoder is loaded at runtime by *path*
// (dynamic `import(pathToFileURL(...))`), so TypeScript cannot associate it with
// its own `.d.ts`; this file types only the small subset `wasm-trace-processor.ts`
// actually uses. The full upstream surface lives in `engine.d.ts` next to the
// vendored bundle. Keep these shapes in sync with that file on a Perfetto bump.

/** A single decoded cell. Integers arrive as `bigint`, floats as `number`. */
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
 * Constructor type for `EngineBase`. It is `abstract` upstream, but the compiled
 * bundle erases that, so we treat it as a concrete zero-arg constructor and
 * supply the abstract members (`rpcSendRequestBytes`, `mode`, `id`,
 * `[Symbol.dispose]`) in the subclass.
 */
export interface EngineBaseCtor {
  new (): EngineBaseInstance;
  readonly prototype: EngineBaseInstance;
}

/** Shape of the dynamically-imported `engine.mjs` module. */
export interface PerfettoEngineModule {
  EngineBase: EngineBaseCtor;
}
