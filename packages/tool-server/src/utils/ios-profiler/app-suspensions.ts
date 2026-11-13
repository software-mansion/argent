/**
 * When macOS held a Mac app suspended during a recording. Instruments suspends
 * the whole app while it checks it for leaks (about every 11 s, up to about
 * 10 s each on an app that argent drove), and a debugger or a stop signal
 * suspends it too. A hang that began just before such a pause lasts as long as
 * the pause in the trace, though the app did not work in that time.
 */
import type { RawHang, UiHang } from "./types";
import type { RecorderAdjustment } from "./recorder-hangs";
import { classifyHangSeverity } from "./pipeline/01-correlate";

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

// xctrace's hang labels, measured on macOS 27 / Xcode 27.2 with main-thread blocks of known
// length: none for a block under 250 ms, "Microhang" for 402 ms, "Hang" for 504 and 1961 ms,
// "Severe Hang" for 2000.7 ms.
const MIN_HANG_NS = 250_000_000;
const HANG_NS = 500_000_000;
const SEVERE_HANG_NS = 2_000_000_000;
/**
 * The watch reads the suspend count every 10 ms, so each edge of a window can
 * be up to 10 ms off: a smaller overlap is no evidence that a suspension was in the hang.
 */
const MIN_OVERLAP_NS = 20_000_000;

/** What taking the app's suspensions out of its hangs changed. */
export interface SuspensionAdjustment {
  /** The suspensions on the trace's timeline, with overlapping ones merged. */
  pauses: number;
  pausedMs: number;
  /** Hangs left out: under 250 ms of each was not a suspension. */
  removedHangs: number;
  /** Hangs kept with the suspended time taken out of their length. */
  adjustedHangs: number;
}

export interface HangsWithoutSuspensions {
  /** The hangs to report, in their order, with their recorded spans. */
  hangs: RawHang[];
  /** For each of `hangs`: the ns of its recorded span during which the app was suspended. */
  suspendedNs: number[];
  /** For each of `hangs`: the ns of main-thread CPU time of Instruments' recorder in its span. */
  recorderNs: number[];
  summary: SuspensionAdjustment;
  /** What taking the recorder's time out changed, in the hangs that the suspensions left. */
  recorderSummary: RecorderAdjustment;
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

/**
 * Takes the time the app was suspended out of each hang, and then the main-thread
 * time of Instruments' recorder (`recorderNs`, one for each of `rawHangs`; from
 * recorderNsIn). A hang with under 250 ms of its own is left out, as xctrace
 * reports no shorter hang. The other hangs keep their recorded spans, so their
 * CPU samples stay theirs.
 */
export function removeSuspendedTime(
  rawHangs: readonly RawHang[],
  spans: readonly AppSuspensionSpan[],
  recorderNs: readonly number[] = []
): HangsWithoutSuspensions {
  const merged = mergeSpans(spans);
  const hangs: RawHang[] = [];
  const suspendedNs: number[] = [];
  const keptRecorderNs: number[] = [];
  let removedHangs = 0;
  let adjustedHangs = 0;
  const recorderSummary: RecorderAdjustment = { removedHangs: 0, adjustedHangs: 0, recorderMs: 0 };
  let recorderTotalNs = 0;
  rawHangs.forEach((hang, i) => {
    const overlap = overlapNs(hang.startNs, hang.startNs + hang.durationNs, merged);
    const suspended = overlap < MIN_OVERLAP_NS ? 0 : overlap;
    if (suspended > 0 && hang.durationNs - suspended < MIN_HANG_NS) {
      removedHangs++;
      return;
    }
    if (suspended > 0) adjustedHangs++;
    const recorder = recorderNs[i] ?? 0;
    recorderTotalNs += recorder;
    if (recorder > 0 && hang.durationNs - suspended - recorder < MIN_HANG_NS) {
      recorderSummary.removedHangs++;
      return;
    }
    if (recorder > 0) recorderSummary.adjustedHangs++;
    hangs.push(hang);
    suspendedNs.push(suspended);
    keptRecorderNs.push(recorder);
  });
  recorderSummary.recorderMs = Math.round(recorderTotalNs / 1_000_000);
  const pausedNs = merged.reduce((sum, s) => sum + (s.endNs - s.startNs), 0);
  return {
    hangs,
    suspendedNs,
    recorderNs: keptRecorderNs,
    summary: {
      pauses: merged.length,
      pausedMs: Math.round(pausedNs / 1_000_000),
      removedHangs,
      adjustedHangs,
    },
    recorderSummary,
  };
}

/** xctrace's label for a hang of this length (of 250 ms or more). */
function hangLabel(ns: number): string {
  if (ns >= SEVERE_HANG_NS) return "Severe Hang";
  return ns >= HANG_NS ? "Hang" : "Microhang";
}

/**
 * The hang as the report shows it: as long as its own time, without the suspended
 * time and the recorder's, and labeled and graded from that length. Its span stays
 * the recorded one.
 */
export function withoutSuspendedTime(hang: UiHang, suspendedNs: number, recorderNs = 0): UiHang {
  if (!(suspendedNs > 0) && !(recorderNs > 0)) return hang;
  const ownNs = hang.endNs - hang.startNs - suspendedNs - recorderNs;
  const hangType = hangLabel(ownNs);
  return {
    ...hang,
    hangType,
    durationMs: Math.round(ownNs / 1_000_000),
    severity: classifyHangSeverity(hangType),
    ...(suspendedNs > 0 ? { suspendedMs: Math.round(suspendedNs / 1_000_000) } : {}),
    ...(recorderNs > 0 ? { recorderMs: Math.round(recorderNs / 1_000_000) } : {}),
  };
}
