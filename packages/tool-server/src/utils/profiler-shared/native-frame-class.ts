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
 *
 * Name patterns are inherently whack-a-mole: kernel leaves like `writel` (a
 * goldfish/QEMU MMIO write — the GPU-pipe transport) or `mod_node_state`
 * (vmstat accounting) carry no recognisable substring, so they slip through as
 * "app". The robust signal is the leaf's *mapping* (the loaded object the symbol
 * lives in): on Android perf traces every kernel frame maps to `/kernel` while
 * user-space frames map to a real module path (`/system/lib64/libhwui.so`,
 * `/apex/com.android.art/lib64/libart.so`, …). So a leaf whose mapping is the
 * kernel is unambiguously a system frame — checked first, before the names.
 * Android's cpu-hotspots.sql now carries this mapping through; iOS does not pass
 * one (the arg defaults undefined), so iOS classification is unchanged.
 */
export type NativeFrameClass = "app" | "system";

/**
 * Mapping names that denote the Linux kernel image (not a user-space module).
 * On the arm64 Android emulator/device the perf sampler labels every kernel leaf
 * `/kernel`; `[kernel.kallsyms]` and a bare `kallsyms` are the common Perfetto /
 * simpleperf variants. Deliberately narrow — real module paths
 * (`/system/lib64/*.so`, `/apex/.../*.so`, `/vendor/.../*.so`) must NOT match,
 * so user-space emulator encoders still fall through to the name patterns.
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
  /_enc\b/, // gl*Enc / rc*_enc emulator encoder trampolines
  // Linux kernel syscall entry + mm/vfs internals (no app symbol to act on).
  // x86-64 entry path:
  /\bdo_syscall_64\b/,
  /\bentry_SYSCALL/,
  /\b__x64_sys_/,
  /\bx64_sys_call\b/,
  // arm64 (aarch64) entry path — the emulator/device the Android profiler runs
  // on is arm64, so these are the leaves actually seen there. The names differ
  // entirely from x86: the EL0 synchronous-exception vector dispatches to the
  // SVC (syscall) handler, which calls invoke_syscall → __arm64_sys_<name>.
  // arch/arm64/kernel/{entry.S,entry-common.c,syscall.c}.
  /\b__arm64_sys_/,
  /\bel0t_64_sync(_handler)?\b/, // exception-vector entry + its C handler
  /\bel0_svc(_common)?\b/, // SVC (syscall) exception handler
  /\bdo_el0_svc\b/,
  /\binvoke_syscall\b/,
  /\bel0_(da|ia)\b/, // data / instruction abort handlers (page-fault leaves)
  /\b__arch_copy_(from|to)_user\b/, // arm64 uaccess copy helpers (copy_{from,to}_user.S)
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
  // Mapping is the strongest signal and is checked first: a leaf in the kernel
  // image is system overhead regardless of its (often unrecognisable) name.
  // This catches `writel`, `mod_node_state`, etc. that no name pattern matches.
  if (mapping && isKernelMapping(mapping)) return "system";
  if (!name) return "app";
  // Name patterns still catch USER-SPACE emulator frames (gfxstream / goldfish
  // encoders living in `.so` mappings, which are NOT `/kernel`) and any kernel
  // frame whose mapping wasn't carried through (iOS, or a missing mapping).
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
