// Anonymous crash diagnostics for the tool server's fatal-error path.
//
// Today every `toolserver:stop` with `reason:"crash"` collapses into a single
// bucket (`TOOLSERVER_UNCAUGHT_EXCEPTION`) — we learn *that* the process died on
// a top-level throw, never *which* throw. This turns an opaque crash into three
// coded, non-identifying signals plus a startup/serving phase, so crashes can be
// clustered and root-caused without ever transmitting free text.
//
// Anonymity is the hard constraint. We deliberately never emit the error message
// or a raw stack: those routinely embed absolute paths (`/Users/<name>/…`),
// URLs, hostnames, argv, and interpolated values — the highest-PII surface and
// impossible to reliably scrub. Instead:
//   • `error_name`      — the error's class name (a code identifier, e.g. TypeError)
//   • `error_syscall`   — the Node system-error code (e.g. EADDRINUSE) when present
//   • `crash_fingerprint` — a hash over the *de-identified* top stack frames
// The sanitizer (sanitize.ts) is the final gate: any value that doesn't match a
// strict coded shape is dropped before it can reach PostHog. Everything here is
// belt-and-suspenders on top of that.

import { createHash } from "node:crypto";

export type CrashPhase = "startup" | "serving";

export interface CrashDiagnostics {
  /** Error class name, e.g. "TypeError". Omitted when it can't be determined. */
  error_name?: string;
  /**
   * Node's system-error `code` string, e.g. "EADDRINUSE" / "ECONNREFUSED".
   * (This is `err.code`, the errno name — not `err.syscall`, which would be the
   * bare operation like "listen".) Omitted when absent.
   */
  error_syscall?: string;
  /** 16 hex chars: first 64 bits of a SHA-256 over the de-identified top frames. */
  crash_fingerprint?: string;
  /** Whether the crash landed before or after the HTTP listener bound. */
  crash_phase: CrashPhase;
}

// Top frames are the discriminating part of a stack; deeper frames are shared
// runtime plumbing that only dilutes the fingerprint. Bounded so a pathological
// stack can't blow up the hash input.
const MAX_FRAMES = 8;

// A single V8 stack frame line. Handles the two shapes V8 emits:
//   "    at Server.<anonymous> (/abs/path/index.js:12:34)"
//   "    at /abs/path/index.js:12:34"
// Group 1 (optional) = function label, 2 = file, 3 = line, 4 = column.
const FRAME_RE = /^\s*at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;

/**
 * Reduce a source path to a token that is identical across machines for the same
 * build, and that carries no user-identifying prefix:
 *   • `node:*` internal modules are kept verbatim (no PII, high signal).
 *   • node_modules frames keep only the package-relative tail (drops the
 *     `/Users/<name>/project/` prefix, keeps which dependency threw).
 *   • Anything else (our own bundled code) is reduced to its basename.
 * This runs on the hash *input*; the output is a hash regardless, so this is
 * about cross-user determinism as much as defense-in-depth.
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
 * Normalize one stack line to `functionLabel@deidentifiedFile:line`, or null if
 * the line isn't a frame. The column is dropped (it shifts more readily than the
 * line across minor edits, which would fragment the fingerprint).
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

/**
 * Deterministic 64-bit fingerprint of the de-identified top stack frames, or
 * undefined when there is no usable stack (e.g. a thrown non-Error primitive).
 */
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
 * Build the anonymous crash record for a fatal error. Values here are best-effort
 * and intentionally un-truncated/un-validated beyond the coarse shape checks
 * above — the sanitizer's coded allowlist is the authority that decides what
 * actually leaves the machine, so a malformed `error_name`/`error_syscall` is
 * dropped there rather than leaking.
 */
export function describeCrash(err: unknown, phase: CrashPhase): CrashDiagnostics {
  const diagnostics: CrashDiagnostics = { crash_phase: phase };
  // A crashing error is untrusted input: any of these fields could be a getter
  // that throws (or recurses). Each extraction is isolated so a hostile error
  // still yields the phase and whatever else could be read — describeCrash is
  // total by construction and never itself becomes a second crash.
  const name = safe(() => errorName(err));
  if (name !== undefined) diagnostics.error_name = name;
  const syscall = safe(() => syscallCode(err));
  if (syscall !== undefined) diagnostics.error_syscall = syscall;
  const fingerprint = safe(() => fingerprintStack(err));
  if (fingerprint !== undefined) diagnostics.crash_fingerprint = fingerprint;
  return diagnostics;
}
