// GENERATED at pack time by packages/argent/scripts/bundle-tools.cjs.
//
// Committed with sane fallback values so dev / source builds (and the
// submodule-less checkout) still compile; the pack step overwrites this file
// with the platform whose trace_processor_shell was actually bundled and the
// Perfetto version pinned in argent-private's PERFETTO_VERSION. esbuild inlines
// it into every published bundle, so the resolver always knows the bundled
// platform (and never hands a mac-arm64 binary to a Linux host) and the cache
// key always matches the version the shipped JS was built against.
import type { TraceProcessorPlatform } from "./platform";

export const BUNDLED_TRACE_PROCESSOR_PLATFORM: TraceProcessorPlatform = "mac-arm64";
export const PERFETTO_VERSION = "v55.3";
