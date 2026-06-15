-- Argent — trace timestamp anchor.
--
-- Returns the trace's earliest ts so the JS side can normalise Perfetto's
-- CLOCK_MONOTONIC timestamps to trace-relative ns.
-- See README.md ("Timestamps are CLOCK_MONOTONIC nanoseconds").
SELECT start_ts FROM trace_bounds;
