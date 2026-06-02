/**
 * Hard cap on a native profiler recording's wall-clock duration. After this the
 * platform start handlers auto-stop the capture so a forgotten session can't run
 * unbounded. Shared by the Android and iOS start paths.
 */
export const RECORDING_CAP_MS = 10 * 60 * 1000;
