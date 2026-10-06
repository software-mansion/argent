// In-process Perfetto trace-processor engine: the vendored `.wasm` under
// `assets/trace-processor/` runs on every OS/arch, offline, with no subprocess
// and no download. Google's prebuilt wasm is driven through its emscripten glue
// plus the version-agnostic `EngineBase` RPC decoder, over a `MessageChannel`.
// One warm engine is kept per trace path — the trace is parsed once and reused
// across the whole analyze pipeline + drill-downs.
//
// The three vendored artifacts are *runtime data*, never statically imported, so
// the bundler ships them verbatim alongside `assets/queries`:
//   • trace_processor.wasm        — read as bytes, handed to emscripten
//   • engine_bundle.node.js       — Google glue; read + patched + vm.runInThisContext
//   • engine.mjs                  — EngineBase decoder; dynamic-import-by-path

import { readFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { TraceProcessorUnavailableError } from "./errors.js";
import type {
  EngineBaseCtor,
  PerfettoEngineModule,
  QueryResult,
  SqlValue,
} from "./perfetto-engine.js";

// Time the patched glue is given to finish `onRuntimeInitialized` (addFunction +
// trace_processor_rpc_init) before the engine accepts queries. Override with
// ARGENT_TRACE_PROCESSOR_INIT_MS on unusually slow hosts.
const DEFAULT_INIT_MS = 1500;
// Each warm engine holds its parsed trace plus the wasm heap, so the cap bounds
// resident memory.
const MAX_WARM_ENGINES = 3;
// Dispose a warm engine after this long with no query, so the MCP server doesn't
// hold trace memory forever once an analysis is done. The timer is unref'd, so
// it never keeps the process alive.
const IDLE_DISPOSE_MS = 5 * 60_000;
// Perfetto's RPC ring buffer rejects any single request frame larger than
// 64 MiB, and parse() emits one TPM_APPEND_TRACE_DATA frame per call, so a
// bigger trace must be fed across several parse() calls before notifyEof().
// 32 MiB mirrors the Perfetto UI's own slice size.
const TRACE_PARSE_CHUNK_BYTES = 32 * 1024 * 1024;

interface AssetPaths {
  wasmPath: string;
  gluePath: string;
  enginePath: string;
}

/** Worker-scope / handoff globals the prebuilt web/worker glue needs. */
interface EngineGlobals {
  self?: typeof globalThis;
  WorkerGlobalScope?: unknown;
  location?: { href: string };
  __TP_WASM_BYTES?: Uint8Array;
  __TP_bridge?: { initialize(port: MessagePort): void };
}

function engineGlobals(): EngineGlobals {
  return globalThis as unknown as EngineGlobals;
}

/**
 * Resolve the three vendored trace-processor artifacts. Same `__dirname/..`
 * resolution `traceProcessorQueriesDir()` uses, so it works in dev (src/),
 * the built package (dist/), and the bundled argent package — the bundler copies
 * `assets/trace-processor/` next to `assets/queries/`.
 *
 * `ARGENT_TRACE_PROCESSOR_WASM` overrides the wasm file only.
 */
export function resolveTraceProcessorAssets(): AssetPaths {
  const dir = path.join(__dirname, "..", "assets", "trace-processor");
  const wasmOverride = process.env.ARGENT_TRACE_PROCESSOR_WASM;
  if (wasmOverride && !existsSync(wasmOverride)) {
    throw new TraceProcessorUnavailableError("wasm_path_invalid", { path: wasmOverride });
  }
  return {
    wasmPath: wasmOverride ?? path.join(dir, "trace_processor.wasm"),
    gluePath: path.join(dir, "engine_bundle.node.js"),
    enginePath: path.join(dir, "engine.mjs"),
  };
}

/**
 * Re-target Google's web/worker emscripten glue for Node. The input
 * (`engine_bundle.node.js`) already has `ENVIRONMENT_IS_NODE` forced false; this
 * applies the remaining three edits, throwing if an anchor stops matching
 * (glue-format drift on a Perfetto bump).
 */
export function patchGlueForNode(src: string): string {
  const edits: ReadonlyArray<readonly [string, string]> = [
    // Force memory32: skip the memory64 probe and its __syscall_mprotect path.
    ["this.useMemory64 = hasMemory64Support();", "this.useMemory64 = false;"],
    // Hand the wasm bytes straight to emscripten -> it never calls readBinary/XHR.
    ["locateFile: (s) => s,", "locateFile: (s) => s, wasmBinary: globalThis.__TP_WASM_BYTES,"],
    // Expose the constructed bridge so we can drive it without self.onmessage.
    [
      "const wasmBridge = new wasm_bridge_1.WasmBridge();",
      "const wasmBridge = new wasm_bridge_1.WasmBridge(); globalThis.__TP_bridge = wasmBridge;",
    ],
  ];
  for (const [from, to] of edits) {
    if (!src.includes(from)) {
      throw new Error(`patchGlueForNode: anchor not found: ${from.slice(0, 40)}…`);
    }
    src = src.replace(from, to);
  }
  return src;
}

/** What we cache and hand back to callers. */
interface ReadyEngine {
  parse(data: Uint8Array): Promise<void>;
  notifyEof(): Promise<void>;
  query(sql: string): Promise<QueryResult>;
  dispose(): void;
  /**
   * Rejects if the engine faults inside its RPC response handler; stays pending
   * for the engine's whole healthy life. Callers race their in-flight parse /
   * query against it so a fault surfaces as a rejection instead of a hang.
   */
  fatal: Promise<never>;
}

// The decoder module is loaded once per process; the bridge handoff, however, is
// a shared global, so engine *creation* is serialized (createMutex) even though
// queries run concurrently per engine.
let engineModulePromise: Promise<PerfettoEngineModule> | null = null;
let wasmEngineClass: (new (port: MessagePort) => ReadyEngine) | null = null;
let workerScopeReady = false;
let decoderWarningSilenced = false;
let createMutex: Promise<unknown> = Promise.resolve();

// Must stay a literal dynamic `import()`: it's the only form vitest's vm sandbox
// wires its dynamic-import callback to (a `new Function`/`eval` import throws
// ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING). The package compiles under
// `module: nodenext`, so tsc preserves the native `import()` in its CJS emit
// rather than downleveling it to `require()`, which can't load ESM by URL.
function loadEngineModule(enginePath: string): Promise<PerfettoEngineModule> {
  if (!engineModulePromise) {
    engineModulePromise = import(pathToFileURL(enginePath).href) as Promise<PerfettoEngineModule>;
  }
  return engineModulePromise;
}

/**
 * Install the minimal worker scope the `ENVIRONMENT=web,worker` prebuilt bundle
 * assumes (`self`/`WorkerGlobalScope`/`location`). defineProperty so it also
 * overrides a host's built-in non-writable `self`/`location`.
 */
function setupWorkerScope(assetsDir: string): void {
  if (workerScopeReady) return;
  const g = engineGlobals();
  if (typeof g.self === "undefined" || g.self !== globalThis) {
    Object.defineProperty(globalThis, "self", {
      value: globalThis,
      writable: true,
      configurable: true,
    });
  }
  if (typeof g.WorkerGlobalScope === "undefined") {
    g.WorkerGlobalScope = function WorkerGlobalScope() {};
  }
  if (!g.location || !g.location.href) {
    Object.defineProperty(globalThis, "location", {
      value: { href: pathToFileURL(assetsDir).href + "/" },
      writable: true,
      configurable: true,
    });
  }
  workerScopeReady = true;
}

/**
 * The version-agnostic decoder logs a benign "Unexpected QueryResult field" for
 * fields it doesn't know; rows still decode. Drop just that line.
 */
function silenceDecoderWarning(): void {
  if (decoderWarningSilenced) return;
  decoderWarningSilenced = true;
  const orig = console.warn.bind(console);
  console.warn = (...args: unknown[]): void => {
    if (/Unexpected QueryResult field/.test(JSON.stringify(args[0] ?? ""))) return;
    orig(...args);
  };
}

function makeWasmEngineClass(Base: EngineBaseCtor): new (port: MessagePort) => ReadyEngine {
  if (wasmEngineClass) return wasmEngineClass;
  class WasmEngine extends Base {
    mode = "WASM";
    id = "v55.3";
    private readonly port: MessagePort;
    private disposed = false;
    readonly fatal: Promise<never>;
    private rejectFatal!: (err: Error) => void;
    constructor(port: MessagePort) {
      super();
      this.port = port;
      this.fatal = new Promise<never>((_resolve, reject) => {
        this.rejectFatal = reject;
      });
      // A fault nobody happens to be awaiting (the warm engine sits idle between
      // tool calls) would otherwise surface as an unhandledRejection and take the
      // process down; callers racing `fatal` still observe the rejection.
      this.fatal.catch(() => {});
      this.port.onmessage = (m: MessageEvent): void => {
        if (!(m.data instanceof Uint8Array)) return;
        try {
          this.onRpcResponseBytes(m.data);
        } catch (err) {
          // EngineBase.fail() throws synchronously (e.g. an RPC framing error),
          // and this runs inside a MessagePort onmessage handler, so an escaping
          // throw becomes a Node uncaughtException and kills the entire
          // tool-server. Contain it to this engine: reject `fatal` so racing
          // callers fail cleanly, and tear the port down so the warm-engine cache
          // evicts and the next call rebuilds from scratch.
          const e = err instanceof Error ? err : new Error(String(err));
          this.rejectFatal(e);
          this.dispose();
        }
      };
    }
    rpcSendRequestBytes(data: Uint8Array): void {
      this.port.postMessage(data);
    }
    dispose(): void {
      if (this.disposed) return;
      this.disposed = true;
      this.port.onmessage = null;
      this.port.close();
    }
  }
  wasmEngineClass = WasmEngine as unknown as new (port: MessagePort) => ReadyEngine;
  return wasmEngineClass;
}

/**
 * Boot a fresh engine (no trace loaded). Serialized via createMutex so the shared
 * `__TP_bridge` global handoff can't race when several traces warm at once. Wraps
 * any glue/vm/instantiation failure as a TraceProcessorUnavailableError so the
 * analyze path can render the "engine failed to load" banner.
 */
async function createEngine(): Promise<ReadyEngine> {
  const prev = createMutex;
  let release!: () => void;
  createMutex = new Promise<void>((r) => (release = r));
  await prev.catch(() => {});
  try {
    const { wasmPath, gluePath, enginePath } = resolveTraceProcessorAssets();
    const dir = path.dirname(wasmPath);
    const initMs = Number(process.env.ARGENT_TRACE_PROCESSOR_INIT_MS) || DEFAULT_INIT_MS;

    const { EngineBase } = await loadEngineModule(enginePath);
    setupWorkerScope(dir);
    silenceDecoderWarning();

    const g = engineGlobals();
    // Hand the bytes to the patched glue (it reads globalThis.__TP_WASM_BYTES).
    g.__TP_WASM_BYTES = new Uint8Array(readFileSync(wasmPath));
    const src = patchGlueForNode(readFileSync(gluePath, "utf8"));
    vm.runInThisContext(src, { filename: "engine_bundle.node.patched.js" });

    const bridge = g.__TP_bridge;
    if (!bridge) throw new Error("patched glue did not expose globalThis.__TP_bridge");

    const channel = new MessageChannel();
    bridge.initialize(channel.port1);
    const WasmEngine = makeWasmEngineClass(EngineBase);
    const engine = new WasmEngine(channel.port2);

    // Let onRuntimeInitialized -> addFunction + trace_processor_rpc_init finish.
    await new Promise<void>((r) => setTimeout(r, initMs));

    // Drop the one-shot handoff globals; the wasm has copied the bytes into its
    // own heap by now, so we can release the 13 MB reference.
    g.__TP_bridge = undefined;
    g.__TP_WASM_BYTES = undefined;
    return engine;
  } catch (err) {
    if (err instanceof TraceProcessorUnavailableError) throw err;
    throw new TraceProcessorUnavailableError("wasm_load_failed", { cause: err });
  } finally {
    release();
  }
}

// Warm-engine cache: one entry per trace path, LRU + idle dispose.

interface WarmEntry {
  engine: Promise<ReadyEngine>;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const warmEngines = new Map<string, WarmEntry>();

function clearIdleTimer(entry: WarmEntry): void {
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
}

function armIdleTimer(tracePath: string, entry: WarmEntry): void {
  clearIdleTimer(entry);
  entry.idleTimer = setTimeout(() => {
    if (warmEngines.get(tracePath) === entry) {
      warmEngines.delete(tracePath);
      void entry.engine.then((e) => e.dispose()).catch(() => {});
    }
  }, IDLE_DISPOSE_MS);
  entry.idleTimer.unref?.();
}

function evictBeyondCap(keep: string): void {
  while (warmEngines.size > MAX_WARM_ENGINES) {
    const oldest = warmEngines.keys().next().value;
    if (oldest === undefined || oldest === keep) break;
    const entry = warmEngines.get(oldest)!;
    clearIdleTimer(entry);
    warmEngines.delete(oldest);
    void entry.engine.then((e) => e.dispose()).catch(() => {});
  }
}

/**
 * Get (or create) the warm engine for a trace: boot, parse the trace once,
 * notifyEof, cache. LRU-bumps on hit and (re)arms the idle-dispose timer. A
 * failed boot/parse is evicted so the next call retries from scratch.
 */
function getWarmEngine(tracePath: string): Promise<ReadyEngine> {
  const hit = warmEngines.get(tracePath);
  if (hit) {
    // LRU bump: re-insert so it becomes the most-recently-used key.
    warmEngines.delete(tracePath);
    warmEngines.set(tracePath, hit);
    armIdleTimer(tracePath, hit);
    return hit.engine;
  }

  const enginePromise = (async (): Promise<ReadyEngine> => {
    const engine = await createEngine();
    const bytes = new Uint8Array(await readFile(tracePath));
    // Feed the trace in sub-cap chunks, and race the load against `engine.fatal`
    // so a contained engine fault rejects here (evicting the cached promise)
    // instead of hanging on a parse() the dead engine will never acknowledge.
    const load = (async (): Promise<void> => {
      for (let offset = 0; offset < bytes.length; offset += TRACE_PARSE_CHUNK_BYTES) {
        await engine.parse(bytes.subarray(offset, offset + TRACE_PARSE_CHUNK_BYTES));
      }
      await engine.notifyEof();
    })();
    await Promise.race([load, engine.fatal]);
    return engine;
  })();

  const entry: WarmEntry = { engine: enginePromise, idleTimer: null };
  warmEngines.set(tracePath, entry);
  armIdleTimer(tracePath, entry);
  evictBeyondCap(tracePath);

  // Don't cache a rejected promise: drop it so a retry re-attempts cleanly.
  enginePromise.catch(() => {
    if (warmEngines.get(tracePath) === entry) {
      clearIdleTimer(entry);
      warmEngines.delete(tracePath);
    }
  });

  return enginePromise;
}

/** Translate a `SqlValue` cell into the plain JS value the pipeline expects. */
function readCell(v: SqlValue): unknown {
  if (typeof v === "bigint") {
    // Trace-relative ns and sample counts stay < 2^53, so hand downstream
    // arithmetic a Number; keep the bigint only for the rare unsafe-range value.
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : v;
  }
  return v;
}

function decodeRows<Row>(result: QueryResult): Row[] {
  const cols = result.columns();
  const rows: Row[] = [];
  for (const it = result.iter({}); it.valid(); it.next()) {
    const row: Record<string, unknown> = {};
    for (const c of cols) row[c] = readCell(it.get(c));
    rows.push(row as Row);
  }
  return rows;
}

/**
 * Run a fully-rendered SQL string against the warm engine for `tracePath`,
 * returning decoded rows. The first call for a trace pays the engine-boot +
 * trace-parse cost; later calls (other pipeline queries, drill-downs) reuse the
 * warm engine. A SQL error surfaces as a thrown Error.
 */
export async function queryWarm<Row = Record<string, unknown>>(
  tracePath: string,
  sql: string
): Promise<Row[]> {
  const engine = await getWarmEngine(tracePath);
  let result: QueryResult;
  try {
    // Race against `engine.fatal` so a mid-query fault surfaces as a clean error
    // rather than awaiting a response the dead engine will never send.
    result = await Promise.race([engine.query(sql), engine.fatal]);
  } catch (err) {
    // A fatal fault leaves a dead engine in the warm cache; drop it so the next
    // call rebuilds from scratch.
    await disposeWarmEngine(tracePath);
    throw err;
  }
  const err = result.error();
  if (err) throw new Error(err);
  return decodeRows<Row>(result);
}

/** Explicitly dispose the warm engine for a trace (e.g. when a session ends). */
export async function disposeWarmEngine(tracePath: string): Promise<void> {
  const entry = warmEngines.get(tracePath);
  if (!entry) return;
  clearIdleTimer(entry);
  warmEngines.delete(tracePath);
  try {
    (await entry.engine).dispose();
  } catch {
    // best-effort: a failed boot has nothing to dispose
  }
}

/**
 * Pre-flight the engine for a trace so the pipeline's real queries hit a warm
 * engine. A wasm-load failure throws TraceProcessorUnavailableError (the analyze
 * path renders the actionable "engine failed to load" banner instead of three
 * identical per-query errors); any other failure (e.g. an unreadable/corrupt
 * trace) is tolerated here and left to surface per-query.
 */
export async function ensureTraceProcessorReady(tracePath: string): Promise<void> {
  try {
    await getWarmEngine(tracePath);
  } catch (err) {
    if (err instanceof TraceProcessorUnavailableError) throw err;
    // Engine booted but the trace didn't parse — not an "unavailable engine".
    // The real queries will retry and fold the failure into exportErrors.
  }
}
