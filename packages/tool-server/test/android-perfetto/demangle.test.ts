import { describe, it, expect } from "vitest";
import { demangleSymbol, demangleCallstackText } from "../../src/utils/profiler-shared/demangle";

describe("demangleSymbol", () => {
  it("demangles a nested name and drops the argument list", () => {
    // _ZN16GrDrawingManager5flushE6SkSpan... → GrDrawingManager::flush
    expect(demangleSymbol("_ZN16GrDrawingManager5flushE6SkSpanIP14GrSurfaceProxyE")).toBe(
      "GrDrawingManager::flush"
    );
  });

  it("demangles a plain (non-nested) function name", () => {
    expect(demangleSymbol("_Z13uncompressLZWP7_JNIEnv")).toBe("uncompressLZW");
    expect(demangleSymbol("_Z23__pthread_internal_findlPKc")).toBe("__pthread_internal_find");
  });

  it("handles internal-linkage (_ZL) symbols", () => {
    expect(demangleSymbol("_ZL25libutil_thread_trampolinePv")).toBe("libutil_thread_trampoline");
  });

  it("strips LLVM internal suffixes", () => {
    expect(
      demangleSymbol(
        "_ZL25libutil_thread_trampolinePv.__uniq.226528677032898775202282855395389835431"
      )
    ).toBe("libutil_thread_trampoline");
  });

  it("maps the std abbreviation in a parseable nested name", () => {
    // _ZNSt6chrono5stealE → std::chrono::steal
    expect(demangleSymbol("_ZNSt6chrono5stealE")).toBe("std::chrono::steal");
  });

  it("bails to the raw name on templates rather than guessing", () => {
    // Template args (`I...E`) are out of scope: returning the raw mangled name
    // is safer than emitting a partial, misleading demangle.
    expect(demangleSymbol("_ZNSt6vectorIiE9push_backEi")).toBe("_ZNSt6vectorIiE9push_backEi");
  });

  it("returns plain C / kernel symbols unchanged", () => {
    expect(demangleSymbol("goldfish_pipe_read_write")).toBe("goldfish_pipe_read_write");
    expect(demangleSymbol("do_syscall_64")).toBe("do_syscall_64");
    expect(demangleSymbol("__start_thread")).toBe("__start_thread");
  });

  it("never corrupts an unparseable mangled name (returns it raw)", () => {
    expect(demangleSymbol("_ZWeird$$$NotReal")).toBe("_ZWeird$$$NotReal");
    expect(demangleSymbol("")).toBe("");
  });
});

describe("demangleCallstackText", () => {
  it("demangles each frame and preserves the ' <- ' separators and order", () => {
    const raw =
      "_ZN16GrDrawingManager5flushE6SkSpan <- _ZL25libutil_thread_trampolinePv <- __start_thread";
    expect(demangleCallstackText(raw)).toBe(
      "GrDrawingManager::flush <- libutil_thread_trampoline <- __start_thread"
    );
  });

  it("leaves an all-C kernel stack readable and unchanged", () => {
    const raw = "goldfish_pipe_read_write <- vfs_read <- do_syscall_64";
    expect(demangleCallstackText(raw)).toBe(raw);
  });
});
