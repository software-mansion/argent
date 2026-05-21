-- Argent — trace timestamp anchor.
--
-- Perfetto perf_sample / actual_frame_timeline_slice / thread_state etc. ts
-- columns are CLOCK_MONOTONIC nanoseconds since device boot — NOT
-- trace-relative. trace_bounds gives us the trace's earliest ts so we can
-- normalise to trace-relative ns in JS before storing into the Bottleneck
-- shape (which the cross-tool combined-report expects to be 0-anchored).
SELECT start_ts FROM trace_bounds;
