/**
 * Android-specific raw row shapes emitted by the `queries/*.sql` files and
 * decoded from the in-process Perfetto engine's QueryResult (integers come back
 * as JS numbers when safe, else bigint). The Android pipeline maps them into the
 * platform-agnostic Bottleneck shape in profiler-shared/types.ts.
 */

export interface AndroidCpuHotspotRow {
  thread_name: string;
  is_main_thread: 0 | 1 | null;
  leaf_function: string | null;
  sample_count: number;
  first_ts_ns: number;
  last_ts_ns: number;
  /**
   * SQL-side burst windows: comma-separated `start_ms:end_ms:count` triples in
   * NATIVE (monotonic) ms (pipeline subtracts traceStartMs). Replaces the old
   * per-sample `ts_array`.
   */
  burst_windows: string | null;
  total_samples: number;
}

export interface AndroidJankRow {
  kind: "anr" | "jank";
  ts_ns: number;
  dur_ns: number;
  process_name: string;
  reason: string | null;
  error_id: string | null;
}

export interface AndroidHangStateRow {
  state: string;
  blocked_function: string | null;
  total_dur_ns: number;
  occurrences: number;
}

export interface AndroidHangGcRow {
  gc_reason: string;
  ts_ns: number;
  dur_ns: number;
}

export interface AndroidRssRow {
  process_name: string;
  start_rss_mb: number;
  peak_rss_mb: number;
  growth_mb: number;
}

export interface AndroidThreadRow {
  thread_name: string;
  is_main_thread: 0 | 1 | null;
  sample_count: number;
  pct_of_app: number;
}

export interface AndroidFunctionCallersRow {
  callstack_text: string;
  occurrences: number;
}

export interface AndroidHangMainThreadSampleRow {
  ts_ns: number;
  callstack_text: string | null;
}
