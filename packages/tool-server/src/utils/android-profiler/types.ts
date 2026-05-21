/**
 * Android-specific raw row shapes returned by `trace_processor_shell` JSON.
 *
 * These mirror the columns the queries in `queries/*.sql` emit. The Android
 * pipeline maps them into the platform-agnostic Bottleneck shape defined in
 * utils/profiler-shared/types.ts.
 */

export interface AndroidCpuHotspotRow {
  thread_name: string;
  is_main_thread: 0 | 1 | null;
  leaf_function: string | null;
  leaf_mapping: string | null;
  sample_count: number;
  first_ts_ns: number;
  last_ts_ns: number;
  /** GROUP_CONCAT'd timestamps in nanoseconds. */
  ts_array: string;
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
  peak_anon_rss_mb: number | null;
  peak_swap_mb: number | null;
}

export interface AndroidThreadRow {
  thread_name: string;
  is_main_thread: 0 | 1 | null;
  sample_count: number;
  pct_of_app: number;
}

export interface AndroidFunctionCallersRow {
  callsite_id: number;
  callstack_text: string;
  occurrences: number;
}

export interface AndroidHangMainThreadSampleRow {
  ts_ns: number;
  leaf_function: string | null;
  callstack_text: string | null;
}
