// GENERATED at pack time by packages/argent/scripts/bundle-tools.cjs.
//
// Committed with a sane fallback value so dev / source builds (and the
// submodule-less checkout) still compile; the pack step overwrites this file
// with the Perfetto version pinned in argent-private's PERFETTO_VERSION. esbuild
// inlines it into every published bundle. The trace-processor engine is now a
// single cross-platform WASM artifact (no per-platform binary), fetched +
// sha256-verified at pack time, so this version is purely informational — it
// stamps the bundled `trace_processor.wasm` — and JS<->engine version skew is
// structurally impossible.

export const PERFETTO_VERSION = "v55.3";
