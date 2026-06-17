# @argent/ios-profiling

An xctrace-free iOS-Simulator profiler for Argent. On **Xcode 26.4 / 26.5 / 26.6 / 27.0**,
`xctrace record --device <sim>` hangs on finalize (the simulator `coreprofilesessiontap`
finalize regression), breaking Argent's native iOS profiler. This package replaces the broken
capture+export step: a native binary drives the Instruments server directly over **DTX**, and a
**pure-TypeScript** parser emits the same `xctrace export`-format XML that
`runIosProfilerPipeline` already consumes — so everything downstream is unchanged.

macOS-only (iOS Simulator profiling is darwin-only). **No Python, no third-party deps** — just
the native binary + stdlib TypeScript + `atos`/`simctl` (Xcode CLT).

## API

```ts
import { captureProfile, captureMemory, captureAllocations } from "@argent/ios-profiling";

// CPU + Hangs + Leaks → the xctrace-export XML set for runIosProfilerPipeline
const { cpu, hangs, leaks, meta } = await captureProfile({
  udid,
  durationSec: 5,
  target: "MyApp" /* or pid */,
  outPrefix: "/tmp/prof",
});
// → /tmp/prof_raw_{cpu,hangs,leaks}.xml  (drop into runIosProfilerPipeline({cpu,hangs,leaks}))

const mem = await captureMemory(udid, 3, pid); // [{physFootprintBytes, residentBytes}, …]
const heap = await captureAllocations(udid, pid); // {totalNodes, objcClasses, swiftClasses, summary}
```

## Coverage (Argent's template + extras), all validated on a real 26.5 sim

| Vector                  | Source                                     | Output                                              |
| ----------------------- | ------------------------------------------ | --------------------------------------------------- |
| **Time Profiler (CPU)** | `coreprofilesessiontap` (DTX)              | `time-profile` XML, symbolicated via `atos -p`      |
| **Hangs**               | derived (main-thread on-CPU runs ≥250ms)   | `potential-hangs` XML                               |
| **Leaks**               | in-sim leaks engine (`simctl spawn leaks`) | `Leaks` detail XML                                  |
| **Memory**              | `sysmontap` (DTX)                          | per-process footprint/RSS time series               |
| **Allocations**         | in-sim heap engine (`simctl spawn heap`)   | live-object profile (size histogram + class counts) |

## Architecture / data flow

```
captureProfile (TS)
  ├─ bin/darwin/ios-profiler-capture (ObjC)  → DTServiceHubClient → coreprofilesessiontap
  │     writes a length-framed kdebug stream (frame 0 = stackshot, frames 1+ = RAW_VERSION2)
  ├─ src/parser/kdebug.ts   deframe + parse RAW_VERSION2 → kperf user-stack callstacks + tid→pid
  ├─ src/parser/emit.ts     symbolicate (atos -p) → time-profile + potential-hangs XML
  └─ src/leaks.ts           simctl spawn leaks → Leaks XML   (+ heap → allocations)
```

The TS layer is the orchestrator; the ObjC binary is a leaf that only produces raw bytes. The
`src/parser/kdebug.ts` parser is a port of the pykdebugparser callstack path — during development
it was diffed against the Python reference on a real capture (identical 36,028-callstack output),
and its framing/threadmap/record-alignment logic is covered by the unit tests
(`src/parser/kdebug.test.ts`) — so the package has zero runtime dependency on `pymobiledevice3` /
`pykdebugparser`.

## Build

```
npm run build:native   -w @argent/ios-profiling   # clang → bin/darwin/ios-profiler-{capture,mem}
npm run build          -w @argent/ios-profiling   # tsc → dist/
npm run format:native  -w @argent/ios-profiling   # clang-format → objc_src/*.{m,h}
```

`PREBUILT_IOS_PROFILER_BIN_DIR` lets CI on non-macOS copy prebuilt binaries instead of building.

TypeScript is formatted by the repo-wide Prettier; the `objc_src/*.{m,h}` sources are formatted by
**clang-format** (the LLVM/Xcode-toolchain standard) per the package `.clang-format` (Google
Objective-C style, tuned to Prettier's 2-space / 100-column settings). `format:native:check`
verifies formatting without writing.

## Argent integration

Replace the iOS `native-profiler-start`/`stop` xctrace path with `captureProfile`: it returns the
exact `{cpu, hangs, leaks}` file set `runIosProfilerPipeline` expects. Profile your app **while
busy** (an idle app shows `mach_msg2_trap`).

## CPU sampling — periodic PET timer (1 kHz, xctrace parity)

The capture configures the `coreprofilesessiontap` **periodic time trigger** (kperf "Profile
Every Thread"), matching xctrace's Time Profiler:

- `tk: 1` — the periodic time trigger (`DTKPTriggerTime`). The earlier `tk: 3` was a _kdebug-event_
  trigger that only sampled on syscalls/context-switches, so it massively under-sampled CPU-bound
  threads (~38 Hz) and over-sampled idle ones (wait-state noise).
- `si: 1000000` — sample interval in **nanoseconds** (1 ms → 1 kHz; clamped by the kernel to
  `kperf.limits.timer_min_pet_period_ns`). Override via `ARGENT_IOS_PROFILER_SI_NS`.
- `kdf2: {0x25000000, 0x25010000, 0x25020000}` — restrict the kdebug typefilter to the PERF class
  (0x25) subclasses actually parsed (PERF_Event / thread-data / user-stacks), instead of
  `{0xFFFFFFFF}` all-classes which floods the buffer (~130 MB/s) and drops samples.

Validated against xctrace-26.3 on a deterministic 100%-CPU workload: **4655 samples (931 Hz)** vs
xctrace **5187 (1037 Hz)** over 5 s — within ~10%, both 100 % on the same hot symbol. Data volume
dropped from ~668 MB to ~12 MB for the same window. An idle app correctly yields ~0 CPU samples
(the timer only samples on-CPU threads).

## Known limitations

- Leaks/Allocations report leaked-object type/size/count; responsible-frame backtraces need the
  target relaunched with `MallocStackLogging`.
- On bursty multi-threaded workloads (e.g. a scrolling RN app) the capture is ~5× sparser than
  xctrace's Time Profiler — the _relative_ hotspot ranking and weights match closely (validated on
  ParadiseGallery: identical #1 Hermes-interpreter frame at ~8%), but absolute sample density is
  lower. Raising the PET rate doesn't close it, so the residual gap (xctrace's scheduler-integrated
  sampling of sub-millisecond on-CPU runs) is a separate follow-up; single-thread CPU-bound capture
  is at parity.
