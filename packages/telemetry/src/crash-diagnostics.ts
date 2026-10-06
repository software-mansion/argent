// Anonymous crash diagnostics for the tool server's fatal-error path.
//
// Anonymity is the hard constraint: the error message and the raw stack are never
// emitted, because they routinely embed absolute paths, URLs, hostnames, argv and
// interpolated values that cannot be reliably scrubbed. Only coded signals go out
// — error class name, Node error code, and a hash over de-identified top frames.
// sanitize.ts is the final gate: anything not matching a strict coded shape is
// dropped before it can reach the OTLP collector.

import { createHash } from "node:crypto";

export type CrashPhase = "startup" | "serving";

export interface CrashDiagnostics {
  /** Error class name, e.g. "TypeError". */
  error_name?: string;
  /** Node's system-error `code`, e.g. "EADDRINUSE" — `err.code`, not `err.syscall`. */
  error_syscall?: string;
  /** 16 hex chars: first 64 bits of a SHA-256 over the de-identified top frames. */
  crash_fingerprint?: string;
  /** Whether the crash landed before or after the HTTP listener bound. */
  crash_phase: CrashPhase;
}

// Top frames discriminate; deeper frames are shared runtime plumbing that only
// dilutes the fingerprint. Bounded so a pathological stack can't blow up the hash.
const MAX_FRAMES = 8;

// One V8 stack frame line, in both shapes V8 emits:
//   "    at Server.<anonymous> (/abs/path/index.js:12:34)"
//   "    at /abs/path/index.js:12:34"
// Groups: 1 = function label (optional), 2 = file, 3 = line, 4 = column.
const FRAME_RE = /^\s*at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;

/**
 * Reduce a source path to a token identical across machines for the same build:
 * `node:*` verbatim, node_modules frames to the package-relative tail (last marker
 * wins, so pnpm's nested layout matches npm's), anything else to its basename.
 * The result is hashed regardless, so this is about cross-user determinism as much
 * as PII.
 */
function deidentifyPath(file: string): string {
  const unified = file.replace(/\\/g, "/");
  if (unified.startsWith("node:")) return unified;
  const marker = "node_modules/";
  const idx = unified.lastIndexOf(marker);
  if (idx !== -1) return unified.slice(idx + marker.length);
  const slash = unified.lastIndexOf("/");
  return slash === -1 ? unified : unified.slice(slash + 1);
}

/**
 * Normalize one stack line to `functionLabel@deidentifiedFile:line`, or null if it
 * isn't a frame. The column is dropped: it shifts across minor edits and would
 * fragment the fingerprint.
 */
function normalizeFrame(line: string): string | null {
  const m = FRAME_RE.exec(line);
  if (!m) return null;
  const fn = (m[1] ?? "").trim() || "?";
  const file = deidentifyPath(m[2]);
  return `${fn}@${file}:${m[3]}`;
}

function stackOf(err: unknown): string | undefined {
  if (err instanceof Error && typeof err.stack === "string") return err.stack;
  if (err && typeof err === "object") {
    const stack = (err as { stack?: unknown }).stack;
    if (typeof stack === "string") return stack;
  }
  return undefined;
}

/** 64-bit fingerprint of the de-identified top frames; undefined without a usable stack. */
function fingerprintStack(err: unknown): string | undefined {
  const stack = stackOf(err);
  if (!stack) return undefined;
  const frames: string[] = [];
  for (const line of stack.split("\n")) {
    const norm = normalizeFrame(line);
    if (norm) frames.push(norm);
    if (frames.length >= MAX_FRAMES) break;
  }
  if (frames.length === 0) return undefined;
  return createHash("sha256").update(frames.join("\n")).digest("hex").slice(0, 16);
}

/** Run an extractor, swallowing anything it throws (e.g. a hostile getter). */
function safe<T>(fn: () => T | undefined): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function errorName(err: unknown): string | undefined {
  if (err instanceof Error && typeof err.name === "string" && err.name) return err.name;
  if (err && typeof err === "object") {
    const ctor = (err as { constructor?: { name?: unknown } }).constructor;
    if (ctor && typeof ctor.name === "string" && ctor.name) return ctor.name;
  }
  return undefined;
}

function syscallCode(err: unknown): string | undefined {
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
  }
  return undefined;
}

/**
 * Build the anonymous crash record. Values are best-effort and not truncated or
 * validated here — the sanitizer's coded allowlist is what decides what actually
 * leaves the machine, so a malformed value is dropped there rather than leaking.
 */
export function describeCrash(err: unknown, phase: CrashPhase): CrashDiagnostics {
  const diagnostics: CrashDiagnostics = { crash_phase: phase };
  // A crashing error is untrusted input: any field could be a getter that throws.
  // Isolating each extraction keeps the record total — the phase plus whatever else
  // was readable — instead of turning into a second crash.
  const name = safe(() => errorName(err));
  if (name !== undefined) diagnostics.error_name = name;
  const syscall = safe(() => syscallCode(err));
  if (syscall !== undefined) diagnostics.error_syscall = syscall;
  const fingerprint = safe(() => fingerprintStack(err));
  if (fingerprint !== undefined) diagnostics.crash_fingerprint = fingerprint;
  return diagnostics;
}
