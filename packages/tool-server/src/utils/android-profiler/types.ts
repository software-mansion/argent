/**
 * Raw row shapes returned by the SQL in native-devtools-android/assets/queries.
 * Integers arrive as JS numbers unless outside the safe range, where readCell
 * keeps them as bigint. The pipeline maps these into the platform-agnostic
 * Bottleneck shape in profiler-shared/types.ts.
 */

export interface AndroidCpuHotspotRow {
  thread_name: string;
  is_main_thread: 0 | 1 | null;
  leaf_function: string | null;
  /**
   * Loaded object the leaf frame lives in — `/kernel`, or a module path such as
   * `/system/lib64/libhwui.so`. Fed to classifyNativeFrame so kernel leaves with
   * no recognisable name (e.g. `writel`) are still classed as system.
   */
  leaf_mapping: string | null;
  sample_count: number;
  first_ts_ns: number;
  last_ts_ns: number;
  /**
   * Comma-separated `start_ms:end_ms:count` triples in NATIVE (monotonic) ms;
   * the pipeline subtracts traceStartMs.
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
  thread_name: string;
  is_main_thread: 0 | 1 | null;
  /** Raw (mangled) leaf frame name; the queried name is matched as a substring of it. */
  matched_function: string;
  /** 1 when matched_function equals the query verbatim, 0 for a substring match. */
  is_exact: 0 | 1;
  callstack_text: string;
  occurrences: number;
}

export interface AndroidHangMainThreadSampleRow {
  ts_ns: number;
  callstack_text: string | null;
}
