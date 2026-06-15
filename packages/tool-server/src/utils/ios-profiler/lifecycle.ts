// Hoisted to utils/profiler-shared/lifecycle.ts — both iOS xctrace and Android
// perfetto use the same SIGINT → SIGTERM → SIGKILL shutdown ladder. This file
// is kept as a thin re-export for source compatibility with existing imports.
export {
  waitForChildExit,
  shutdownChild,
  type ShutdownTimings,
  type ShutdownResult,
} from "../profiler-shared/lifecycle";
