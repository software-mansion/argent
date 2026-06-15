import type { UiHangStateBreakdownEntry } from "./types";

/**
 * Classify a native leaf frame as app-relevant or system/emulator overhead.
 *
 * On the Android emulator the hottest CPU frames are almost always the
 * goldfish/QEMU GPU-transport pipe and Linux kernel syscall/mm internals, not
 * the app's own code. Presenting those as actionable app hotspots (with
 * "reduce view hierarchy depth" advice) is misleading: they don't exist on a
 * physical device and the developer can't act on them. The analyzer keeps them
 * in the table for honesty but labels them and tailors the advice.
 *
 * Patterns are matched as substrings (not anchored) because perf leaf frames
 * are often C++-mangled (e.g. `_Z23__pthread_internal_findlPKc`), so the bare
 * symbol appears verbatim inside the mangled name.
 */
export type NativeFrameClass = "app" | "system";

const SYSTEM_FRAME_PATTERNS: RegExp[] = [
  // QEMU / goldfish / gfxstream emulator GPU + pipe transport.
  /goldfish_/,
  /qemu_pipe/,
  /QemuPipeStream/,
  /gfxstream/i,
  /rcCreateSync/,
  /_enc\b/, // gl*Enc / rc*_enc emulator encoder trampolines
  // Linux kernel syscall entry + mm/vfs internals (no app symbol to act on).
  /\bdo_syscall_64\b/,
  /\bentry_SYSCALL/,
  /\b__x64_sys_/,
  /\b__arm64_sys_/,
  /\bx64_sys_call\b/,
  /\bksys_/,
  /\bvfs_(read|write|fsync)\b/,
  /\bgup_/,
  /get_user_pages/,
  /\bhandle_mm_fault\b/,
  // pthread / low-level lock internals — usually the leaf of a lock/futex wait.
  /__pthread_internal/,
  /__pthread_mutex/,
  /__lll_/,
  /\bfutex_/,
];

export function classifyNativeFrame(name: string | null | undefined): NativeFrameClass {
  if (!name) return "app";
  for (const re of SYSTEM_FRAME_PATTERNS) {
    if (re.test(name)) return "system";
  }
  return "app";
}

/**
 * Summarise an Android hang's main-thread state breakdown into the single
 * fact the advice layer needs: was the thread mostly OFF the CPU (sleeping /
 * blocked) during the hang, or actually executing?
 *
 * Linux scheduler states: "Running" = on CPU; "R"/"R+" = runnable (in the run
 * queue, waiting for a CPU); "S" = interruptible sleep; "D" = uninterruptible
 * sleep (usually I/O). A hang dominated by "S"/"D" is a *wait*, not CPU-bound
 * work — so "move heavy work off the main thread" would be the wrong fix.
 */
export type HangCpuKind = "executing" | "runnable" | "blocked";

export interface HangBlockingSummary {
  dominantState: string;
  kind: HangCpuKind;
}

export function summarizeHangBlocking(
  states: UiHangStateBreakdownEntry[] | undefined
): HangBlockingSummary | null {
  if (!states || states.length === 0) return null;
  const top = [...states].sort((a, b) => b.durationMs - a.durationMs)[0]!;
  const s = top.state.trim();
  let kind: HangCpuKind;
  if (s === "Running") kind = "executing";
  else if (s === "R" || s === "R+") kind = "runnable";
  else kind = "blocked";
  return { dominantState: s, kind };
}
