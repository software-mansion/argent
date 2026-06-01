# SQL smoke-test fixtures

`sql-smoke.test.ts` runs the real `queries/*.sql` against a real `.pftrace`
through `trace_processor_shell` (nothing mocked). It auto-skips unless **both**
the binary and a fixture trace are present, so it is a no-op in bare CI.

## Pointing the test at a trace

The test resolves its fixture in this order:

1. `ARGENT_PFTRACE_FIXTURE` — absolute path to a `.pftrace` (preferred).
2. `./sample.pftrace` next to this README (committed only if small enough).

The target process is resolved from `ARGENT_PFTRACE_TARGET`, else the busiest
process in `perf_sample` is used automatically.

```bash
ARGENT_PFTRACE_FIXTURE=/path/to/trace.pftrace \
  npm run test:sql-smoke --workspace packages/tool-server
```

## Regenerating a fixture

Capture a short (~3–5 s) trace of any profileable app so the file stays in the
single-digit-MB range, then commit it here as `sample.pftrace` (or keep it
local and pass `ARGENT_PFTRACE_FIXTURE`):

1. Boot an emulator / device and launch a debuggable (or `<profileable
   android:shell="true">`) app.
2. Run the Argent native profiler against it for a few seconds and stop — the
   resulting `native-profiler-*.pftrace` is a valid fixture. Any Perfetto trace
   that contains `perf_sample`, `thread_state`, `actual_frame_timeline_slice`,
   and process RSS counters for the target app works.
3. Trim the capture window to keep the file small. Verify with:

   ```bash
   ARGENT_PFTRACE_FIXTURE=<trace> npm run test:sql-smoke --workspace packages/tool-server
   ```

The test pins `trace_processor_shell` to the version in
`scripts/download-native-binaries.sh` (currently **v55.3**); regenerate the
binary via that script if the version guard fails.
