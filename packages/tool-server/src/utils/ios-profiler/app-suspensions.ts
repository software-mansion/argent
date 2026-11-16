/**
 * When macOS held a Mac app suspended during a recording. Instruments suspends
 * the whole app while it checks it for leaks (about every 11 s, up to about
 * 10 s each on an app that argent drove), and a debugger or a stop signal
 * suspends it too. A hang that such a pause overlaps holds the pause in the
 * trace. The pause makes a hang of fixed work longer, but not a hang whose main
 * thread waits for something that goes on during the pause (a sleep, a deadline,
 * I/O, another process). Measured on a Mac app: a 1.5 s main-thread spin to a
 * deadline was recorded as a 7167 ms hang with 6726 ms of it suspended, though the
 * app's own hang was about 1.8 s. The trace cannot tell the two cases apart, so a
 * hang keeps its recorded length and Instruments' label, and gets the suspended
 * part of its span: the app's own hang is between the recorded length less that
 * part and the recorded length.
 */
import type { RawHang, UiHang } from "./types";

/** A suspension in wall-clock ms since 1970, as `argent-macos-helper watch-suspension` reports it. */
export interface AppSuspensionWindow {
  startMs: number;
  endMs: number;
}

/** A suspension in trace time: ns from the start of the trace. */
export interface AppSuspensionSpan {
  startNs: number;
  endNs: number;
}

/**
 * The windows on the trace's timeline, cut to the trace. `traceStartMs` is the
 * trace's `<start-date>`: start date plus a row's time matched the wall clock
 * within 1 ms (6 of 6 signposts of a test program). `traceDurationMs`, when
 * known, ends the trace: the watch runs until xctrace has ended, after the trace.
 */
export function suspensionSpansInTrace(
  windows: readonly AppSuspensionWindow[],
  traceStartMs: number,
  traceDurationMs?: number
): AppSuspensionSpan[] {
  const endMs = traceDurationMs !== undefined ? traceStartMs + traceDurationMs : Infinity;
  const spans: AppSuspensionSpan[] = [];
  for (const w of windows) {
    const start = Math.max(w.startMs, traceStartMs);
    const end = Math.min(w.endMs, endMs);
    if (!(end > start)) continue;
    spans.push({
      startNs: Math.round((start - traceStartMs) * 1_000_000),
      endNs: Math.round((end - traceStartMs) * 1_000_000),
    });
  }
  return spans;
}

/**
 * The watch reads the suspend count every 10 ms, so each edge of a window can
 * be up to 10 ms off: a smaller overlap is no evidence that a suspension was in the hang.
 */
const MIN_OVERLAP_NS = 20_000_000;

/** What the app's suspensions overlapped. */
export interface SuspensionAdjustment {
  /** The suspensions on the trace's timeline, with overlapping ones merged. */
  pauses: number;
  pausedMs: number;
  /** Hangs that a suspension overlapped. Each keeps its recorded length and label. */
  overlappedHangs: number;
}

export interface SuspendedTimeInHangs {
  /** For each hang: the ns of its recorded span during which the app was suspended. */
  suspendedNs: number[];
  summary: SuspensionAdjustment;
}

/** Sorted, with the empty spans left out and the overlapping ones merged. */
function mergeSpans(spans: readonly AppSuspensionSpan[]): AppSuspensionSpan[] {
  const sorted = spans
    .filter((s) => s.endNs > s.startNs)
    .sort((a, b) => a.startNs - b.startNs)
    .map((s) => ({ ...s }));
  const merged: AppSuspensionSpan[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.startNs <= last.endNs) last.endNs = Math.max(last.endNs, span.endNs);
    else merged.push(span);
  }
  return merged;
}

function overlapNs(startNs: number, endNs: number, merged: readonly AppSuspensionSpan[]): number {
  let total = 0;
  for (const span of merged) {
    if (span.startNs >= endNs) break;
    total += Math.max(0, Math.min(endNs, span.endNs) - Math.max(startNs, span.startNs));
  }
  return total;
}

/** The time the app was suspended in each hang's recorded span. */
export function suspendedTimeInHangs(
  rawHangs: readonly RawHang[],
  spans: readonly AppSuspensionSpan[]
): SuspendedTimeInHangs {
  const merged = mergeSpans(spans);
  const suspendedNs = rawHangs.map((hang) => {
    const overlap = overlapNs(hang.startNs, hang.startNs + hang.durationNs, merged);
    return overlap < MIN_OVERLAP_NS ? 0 : overlap;
  });
  const pausedNs = merged.reduce((sum, s) => sum + (s.endNs - s.startNs), 0);
  return {
    suspendedNs,
    summary: {
      pauses: merged.length,
      pausedMs: Math.round(pausedNs / 1_000_000),
      overlappedHangs: suspendedNs.filter((ns) => ns > 0).length,
    },
  };
}

/**
 * The hang with the suspended part of its span. Its length, label and severity
 * stay those that Instruments recorded.
 */
export function withSuspendedTime(hang: UiHang, suspendedNs: number): UiHang {
  if (!(suspendedNs > 0)) return hang;
  return { ...hang, suspendedMs: Math.round(suspendedNs / 1_000_000) };
}
