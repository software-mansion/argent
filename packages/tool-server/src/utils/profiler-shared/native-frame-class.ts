import type { UiHangStateBreakdownEntry } from "./types";

/**
 * On the Android emulator the hottest CPU frames are usually the goldfish/QEMU
 * GPU-transport pipe and kernel syscall/mm internals, which don't exist on a
 * physical device; the render layer keeps them in the table but labels them and
 * gives them their own advice.
 *
 * Patterns are unanchored substrings because perf leaf names are often
 * C++-mangled (`_Z23__pthread_internal_findlPKc`).
 */
export type NativeFrameClass = "app" | "system";

/**
 * Android perf labels kernel leaves `/kernel`; `[kernel.kallsyms]` and bare
 * `kallsyms` are the Perfetto / simpleperf variants. Deliberately narrow: real
 * module paths (`/system/lib64/*.so`, `/apex/…`, `/vendor/…`) must fall through
 * to the name patterns, which is where user-space emulator encoders are caught.
 */
function isKernelMapping(mapping: string): boolean {
  return mapping === "/kernel" || mapping === "[kernel.kallsyms]" || /kallsyms/.test(mapping);
}

const SYSTEM_FRAME_PATTERNS: RegExp[] = [
  // QEMU / goldfish / gfxstream emulator GPU + pipe transport.
  /goldfish_/,
  /qemu_pipe/,
  /QemuPipeStream/,
  /gfxstream/i,
  /rcCreateSync/,
  /_enc\b/, // emulator GL/Vulkan encoder trampolines
  // Linux kernel syscall entry + mm/vfs internals (no app symbol to act on).
  // x86-64 entry path:
  /\bdo_syscall_64\b/,
  /\bentry_SYSCALL/,
  /\b__x64_sys_/,
  /\bx64_sys_call\b/,
  // arm64 entry path, named nothing like the x86 one: the EL0
  // synchronous-exception vector dispatches to the SVC (syscall) handler, which
  // calls invoke_syscall → __arm64_sys_<name>.
  // arch/arm64/kernel/{entry.S,entry-common.c,syscall.c}.
  /\b__arm64_sys_/,
  /\bel0t_64_sync(_handler)?\b/, // exception-vector entry + its C handler
  /\bel0_svc(_common)?\b/, // SVC (syscall) exception handler
  /\bdo_el0_svc\b/,
  /\binvoke_syscall\b/,
  /\bel0_(da|ia)\b/, // data / instruction abort (page-fault) handlers
  /\b__arch_copy_(from|to)_user\b/, // arm64 uaccess copy helpers
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

export function classifyNativeFrame(
  name: string | null | undefined,
  mapping?: string | null
): NativeFrameClass {
  // Strongest signal, so checked first: a kernel-image leaf is system overhead
  // whatever its name — `writel`, `mod_node_state` match no name pattern.
  if (mapping && isKernelMapping(mapping)) return "system";
  if (!name) return "app";
  // Names still catch user-space emulator frames (gfxstream / goldfish encoders
  // live in `.so` mappings) and kernel frames that arrived without a mapping
  // (iOS passes none).
  for (const re of SYSTEM_FRAME_PATTERNS) {
    if (re.test(name)) return "system";
  }
  return "app";
}

/**
 * Linux scheduler states of the hung main thread: "Running" = on CPU, "R"/"R+"
 * = runnable (queued for a CPU), "S"/"D" = interruptible / uninterruptible
 * sleep. A hang dominated by "S"/"D" is a wait, not CPU-bound work, so "move
 * heavy work off the main thread" would be the wrong advice.
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
