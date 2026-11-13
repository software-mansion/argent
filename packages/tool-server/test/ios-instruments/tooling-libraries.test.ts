/**
 * Frames of the libraries that argent and Instruments load into the profiled
 * app are those tools' work, not the app's: the xml parser marks them by binary
 * name, the CPU hotspots leave their samples out (but are still shares of all
 * the CPU time), a hang labels them as a tool's, and the pipeline totals them
 * per tool.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCpuXml } from "../../src/utils/ios-profiler/pipeline/xml-parser";
import {
  aggregateCpuHotspots,
  toolingWeightNs,
  toolingWork,
  withAppCallsThroughArgent,
} from "../../src/utils/ios-profiler/pipeline/02-aggregate";
import { correlateHangsWithCpu } from "../../src/utils/ios-profiler/pipeline/01-correlate";
import { runIosProfilerPipeline } from "../../src/utils/ios-profiler/pipeline/index";
import { renderThreadBreakdownIos } from "../../src/tools/profiler/query/profiler-stack-query";
import type { CpuSample, StackFrame } from "../../src/utils/ios-profiler/types";

const ARGENT_LIB_DIR = "/Users/dev/.argent/macos/lib/0123456789abcdef";
const INSTRUMENTS_DIR =
  "/Applications/Xcode.app/Contents/SharedFrameworks/DVTInstrumentsFoundation.framework/Versions/A/Resources";
const APP_EXECUTABLE = "/Applications/Example.app/Contents/MacOS/ExampleExec";
const APPKIT = "/System/Library/Frameworks/AppKit.framework/Versions/C/AppKit";
const CORE_FOUNDATION =
  "/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation";

function binaryDef(id: number, name: string, path: string): string {
  return `<binary id="${id}" name="${name}" UUID="00000000-0000-0000-0000-000000000000" arch="arm64" load-addr="0x100000000" path="${path}"/>`;
}

function frame(id: number, name: string, binary: string): string {
  return `<frame id="${id}" name="${name}" addr="0x${(0x1000 + id).toString(16)}">${binary}</frame>`;
}

function row(timeNs: number, backtrace: string, weightNs = 1_000_000): string {
  return (
    `<row><sample-time>${timeNs}</sample-time>` +
    `<thread fmt="Main Thread 0x1 (ExampleExec, pid: 4321)"></thread>` +
    `<weight>${weightNs}</weight>${backtrace}</row>`
  );
}

function cpuXml(rows: string[]): string {
  return `<trace-query-result><node>${rows.join("\n")}</node></trace-query-result>`;
}

const app = (name: string): StackFrame => ({ name, isSystemLibrary: false });
const system = (name: string): StackFrame => ({ name, isSystemLibrary: true });
const argent = (name: string): StackFrame => ({ name, isSystemLibrary: false, tooling: "argent" });
const instruments = (name: string): StackFrame => ({
  name,
  isSystemLibrary: false,
  tooling: "instruments",
});

function sample(timeMs: number, stack: StackFrame[], weightNs = 1_000_000): CpuSample {
  return { timestampNs: timeMs * 1_000_000, threadFmt: "Main Thread 0x1", weightNs, stack };
}

/** `count` one-millisecond samples of the same stack, one per millisecond from `startMs`. */
function repeat(count: number, startMs: number, stack: StackFrame[]): CpuSample[] {
  return Array.from({ length: count }, (_, i) => sample(startMs + i, stack));
}

describe("xml-parser: frames of the tools' libraries", () => {
  it.each([
    ["libNativeDevtoolsMacos.dylib", "argent", ARGENT_LIB_DIR],
    ["libNativeDevtoolsIos.dylib", "argent", ARGENT_LIB_DIR],
    ["libArgentInjectionBootstrap.dylib", "argent", ARGENT_LIB_DIR],
    ["libKeyboardPatch.dylib", "argent", ARGENT_LIB_DIR],
    ["liboainject.dylib", "instruments", INSTRUMENTS_DIR],
  ])(
    "marks a frame of %s as the work of %s, also through a binary or frame ref",
    (lib, owner, dir) => {
      const samples = parseCpuXml(
        cpuXml([
          // The binary is defined with its first frame...
          row(
            1_000_000,
            `<backtrace id="1">${frame(2, "SomeLibraryFunction", binaryDef(3, lib, `${dir}/${lib}`))}</backtrace>`
          ),
          // ...a later frame of it refers to the binary...
          row(
            2_000_000,
            `<backtrace id="4">${frame(5, "OtherLibraryFunction", `<binary ref="3"/>`)}</backtrace>`
          ),
          // ...and a later sample refers to an earlier frame.
          row(3_000_000, `<backtrace id="6"><frame ref="2"/></backtrace>`),
        ])
      );

      const binary = { library: lib, libraryPath: `${dir}/${lib}` };
      expect(samples.map((s) => s.stack)).toEqual([
        [{ name: "SomeLibraryFunction", isSystemLibrary: false, tooling: owner, ...binary }],
        [{ name: "OtherLibraryFunction", isSystemLibrary: false, tooling: owner, ...binary }],
        [{ name: "SomeLibraryFunction", isSystemLibrary: false, tooling: owner, ...binary }],
      ]);
    }
  );

  it("leaves the app's and the system's frames unmarked, matching the file name exactly", () => {
    const samples = parseCpuXml(
      cpuXml([
        row(
          1_000_000,
          `<backtrace id="1">${frame(2, "-[ExampleView layout]", binaryDef(3, "ExampleExec", APP_EXECUTABLE))}</backtrace>`
        ),
        row(
          2_000_000,
          `<backtrace id="4">${frame(5, "objc_msgSend", binaryDef(6, "libobjc.A.dylib", "/usr/lib/libobjc.A.dylib"))}</backtrace>`
        ),
        // A library of the app's own that only resembles argent's, and one that
        // sits in argent's folder under another name.
        row(
          3_000_000,
          `<backtrace id="7">${frame(8, "HelperFunction", binaryDef(9, "libNativeDevtoolsMacosHelpers.dylib", `${ARGENT_LIB_DIR}/libNativeDevtoolsMacosHelpers.dylib`))}</backtrace>`
        ),
        row(
          4_000_000,
          `<backtrace id="10">${frame(11, "PluginFunction", binaryDef(12, "Plugin.dylib", `${ARGENT_LIB_DIR}/Plugin.dylib`))}</backtrace>`
        ),
      ])
    );

    const frames = samples.map((s) => s.stack[0]!);
    expect(frames.map((f) => f.tooling)).toEqual([undefined, undefined, undefined, undefined]);
    expect(frames.map((f) => "tooling" in f)).toEqual([false, false, false, false]);
    expect(frames[1]!.isSystemLibrary).toBe(true);
  });

  it("marks only the tool's frames of a stack that mixes the tool, the system and the app", () => {
    const [s] = parseCpuXml(
      cpuXml([
        row(
          1_000_000,
          `<backtrace id="1">` +
            frame(2, "objc_msgSend", binaryDef(3, "libobjc.A.dylib", "/usr/lib/libobjc.A.dylib")) +
            frame(
              4,
              "SomeLibraryFunction",
              binaryDef(
                5,
                "libNativeDevtoolsMacos.dylib",
                `${ARGENT_LIB_DIR}/libNativeDevtoolsMacos.dylib`
              )
            ) +
            frame(6, "main", binaryDef(7, "ExampleExec", APP_EXECUTABLE)) +
            `</backtrace>`
        ),
      ])
    );

    expect(s!.stack).toEqual([
      {
        name: "objc_msgSend",
        isSystemLibrary: true,
        library: "libobjc.A.dylib",
        libraryPath: "/usr/lib/libobjc.A.dylib",
      },
      {
        name: "SomeLibraryFunction",
        isSystemLibrary: false,
        tooling: "argent",
        library: "libNativeDevtoolsMacos.dylib",
        libraryPath: `${ARGENT_LIB_DIR}/libNativeDevtoolsMacos.dylib`,
      },
      { name: "main", isSystemLibrary: false, library: "ExampleExec", libraryPath: APP_EXECUTABLE },
    ]);
  });

  it("takes a frame's binary from that frame only, not from a later frame that defines one", () => {
    const argentLib = binaryDef(
      10,
      "libNativeDevtoolsMacos.dylib",
      `${ARGENT_LIB_DIR}/libNativeDevtoolsMacos.dylib`
    );
    const samples = parseCpuXml(
      cpuXml([
        // Defines the app's binary and AppKit.
        row(
          1_000_000,
          `<backtrace id="1">` +
            frame(2, "-[ExampleView layout]", binaryDef(3, "ExampleExec", APP_EXECUTABLE)) +
            frame(4, "-[NSView layout]", binaryDef(5, "AppKit", APPKIT)) +
            `</backtrace>`
        ),
        // The app's and AppKit's frames refer to their binaries, and the frame
        // after them defines argent's library.
        row(
          2_000_000,
          `<backtrace id="6">` +
            frame(7, "-[ExampleView drawRect:]", `<binary ref="3"/>`) +
            frame(8, "-[NSWindow displayIfNeeded]", `<binary ref="5"/>`) +
            frame(9, "SomeLibraryFunction", argentLib) +
            `</backtrace>`
        ),
        // argent's frame refers to its library, and the frame after it defines CoreFoundation.
        row(
          3_000_000,
          `<backtrace id="11">` +
            frame(12, "OtherLibraryFunction", `<binary ref="10"/>`) +
            frame(13, "__CFRunLoopRun", binaryDef(14, "CoreFoundation", CORE_FOUNDATION)) +
            `</backtrace>`
        ),
      ])
    );

    const argentBinary = {
      library: "libNativeDevtoolsMacos.dylib",
      libraryPath: `${ARGENT_LIB_DIR}/libNativeDevtoolsMacos.dylib`,
    };
    expect(samples.slice(1).map((s) => s.stack)).toEqual([
      [
        {
          name: "-[ExampleView drawRect:]",
          isSystemLibrary: false,
          library: "ExampleExec",
          libraryPath: APP_EXECUTABLE,
        },
        {
          name: "-[NSWindow displayIfNeeded]",
          isSystemLibrary: true,
          library: "AppKit",
          libraryPath: APPKIT,
        },
        { name: "SomeLibraryFunction", isSystemLibrary: false, tooling: "argent", ...argentBinary },
      ],
      [
        {
          name: "OtherLibraryFunction",
          isSystemLibrary: false,
          tooling: "argent",
          ...argentBinary,
        },
        {
          name: "__CFRunLoopRun",
          isSystemLibrary: true,
          library: "CoreFoundation",
          libraryPath: CORE_FOUNDATION,
        },
      ],
    ]);
  });

  it("gives a frame with no binary none, also when the next frame defines one", () => {
    const [s] = parseCpuXml(
      cpuXml([
        row(
          1_000_000,
          `<backtrace id="1">` +
            `<frame id="2" name="0x104b84503" addr="0x104b84503"/>` +
            frame(
              3,
              "SomeLibraryFunction",
              binaryDef(
                4,
                "libNativeDevtoolsMacos.dylib",
                `${ARGENT_LIB_DIR}/libNativeDevtoolsMacos.dylib`
              ) + `<source line="12"><path id="5">/src/Example.m</path></source>`
            ) +
            `<frame id="6" name="0x19a3afe69" addr="0x19a3afe69"/>` +
            frame(7, "__CFRunLoopRun", binaryDef(8, "CoreFoundation", CORE_FOUNDATION)) +
            `</backtrace>`
        ),
      ])
    );

    expect(s!.stack).toEqual([
      { name: "0x104b84503", isSystemLibrary: false },
      {
        name: "SomeLibraryFunction",
        isSystemLibrary: false,
        tooling: "argent",
        library: "libNativeDevtoolsMacos.dylib",
        libraryPath: `${ARGENT_LIB_DIR}/libNativeDevtoolsMacos.dylib`,
      },
      { name: "0x19a3afe69", isSystemLibrary: false },
      {
        name: "__CFRunLoopRun",
        isSystemLibrary: true,
        library: "CoreFoundation",
        libraryPath: CORE_FOUNDATION,
      },
    ]);
  });
});

describe("toolingWork: whose work a sample is", () => {
  it("is the tool's when its frame is the most actionable one, under system leaf frames", () => {
    expect(toolingWork([system("objc_msgSend"), argent("SomeLibraryFunction"), app("main")])).toBe(
      "argent"
    );
    expect(toolingWork([instruments("SomeRecorderFunction"), app("main")])).toBe("instruments");
  });

  it("is the app's when an app frame comes before the tool's, as for a callback into the app", () => {
    expect(
      toolingWork([app("-[ExampleView accessibilityLabel]"), argent("SomeLibraryFunction")])
    ).toBeNull();
  });

  it("is the recorder's when its frame has no symbol, below an allocation of the app", () => {
    const stack = [
      system("thread_stack_pcs"),
      instruments("0x1201208b8"),
      system("_malloc_zone_malloc_instrumented_or_legacy"),
      app("static ExampleApp.$main()"),
    ];
    expect(toolingWork(stack)).toBe("instruments");
    expect(aggregateCpuHotspots([sample(1, stack, 10_000_000)], new Set())).toEqual([]);
    expect(toolingWeightNs([sample(1, stack, 10_000_000)]).instruments).toBe(10_000_000);
  });

  it("is the tool's anywhere in a stack with no named frame outside the system", () => {
    // The recorder's own thread, and a thread of the system that allocates.
    const recorderThread = [
      system("mach_absolute_time"),
      instruments("0x1201208b8"),
      system("_pthread_start"),
      system("thread_start"),
    ];
    const systemThread = [
      system("__ulock_wait2"),
      system("_os_unfair_lock_lock_slow"),
      instruments("0x115685048"),
      system("_malloc_zone_malloc_instrumented_or_legacy"),
      system("_CFRuntimeCreateInstance"),
      system("_dispatch_client_callout"),
    ];
    expect(toolingWork(recorderThread)).toBe("instruments");
    expect(toolingWork(systemThread)).toBe("instruments");
    expect(
      aggregateCpuHotspots([sample(1, recorderThread), sample(2, systemThread)], new Set())
    ).toEqual([]);
    expect(toolingWork([system("mach_msg2_trap"), system("_pthread_start")])).toBeNull();
  });

  it("is the app's for a stack with no tool frame, and for an empty stack", () => {
    expect(toolingWork([system("objc_msgSend"), app("main")])).toBeNull();
    expect(toolingWork([])).toBeNull();
  });
});

describe("withAppCallsThroughArgent: a method of the system that argent's library replaces", () => {
  // The app orders a window in: argent's replacement of the ordering method calls the
  // original, which lays out the window.
  const windowOrdering = [
    system("-[NSView layoutSubtreeIfNeeded]"),
    system("-[NSWindow orderWindow:relativeTo:]"),
    argent("SomeReplacedMethod"),
    system("-[NSWindow makeKeyAndOrderFront:]"),
    app("ExampleApp.openWindow()"),
    system("-[NSApplication sendAction:to:from:]"),
    system("-[NSApplication run]"),
    system("NSApplicationMain"),
    app("main"),
  ];
  // argent's describe, which the run loop calls.
  const describeFromRunLoop = [
    system("AXUIElementCopyAttributeValue"),
    argent("SomeLibraryFunction"),
    argent("OtherLibraryFunction"),
    system("__CFRUNLOOP_IS_CALLING_OUT_TO_A_BLOCK__"),
    system("__CFRunLoopDoBlocks"),
    system("CFRunLoopRunSpecific"),
    system("-[NSApplication run]"),
    system("NSApplicationMain"),
    app("main"),
  ];

  it("gives the app the work under argent's frame when an app function called through it", () => {
    const stack = withAppCallsThroughArgent(windowOrdering);

    expect(stack[2]).toEqual({ name: "SomeReplacedMethod", isSystemLibrary: true });
    expect(toolingWork(stack)).toBeNull();
    expect(aggregateCpuHotspots(repeat(10, 0, stack)).map((h) => h.dominantFunction)).toEqual([
      "ExampleApp.openWindow()",
    ]);
    // The input is not changed.
    expect(windowOrdering[2]!.tooling).toBe("argent");
  });

  it("gives the app the work when the app calls the replaced method itself", () => {
    const stack = withAppCallsThroughArgent([
      system("-[NSView layoutSubtreeIfNeeded]"),
      argent("SomeReplacedMethod"),
      system("0x19a3afe69"),
      app("-[ExampleWindowController showWindow:]"),
      app("main"),
    ]);
    expect(toolingWork(stack)).toBeNull();
  });

  it("keeps the recorder's work under the replaced method the recorder's", () => {
    const stack = withAppCallsThroughArgent([
      instruments("SomeRecorderFunction"),
      system("_malloc_zone_malloc_instrumented_or_legacy"),
      ...windowOrdering,
    ]);
    expect(toolingWork(stack)).toBe("instruments");
  });

  it("keeps argent's work that the run loop calls argent's, also while an app function runs a modal loop", () => {
    expect(withAppCallsThroughArgent(describeFromRunLoop)).toBe(describeFromRunLoop);
    expect(toolingWork(describeFromRunLoop)).toBe("argent");

    const duringModal = [
      ...describeFromRunLoop.slice(0, 6),
      system("-[NSApplication runModalForWindow:]"),
      system("-[NSAlert runModal]"),
      app("ExampleApp.showAlert()"),
      ...windowOrdering.slice(5),
    ];
    expect(withAppCallsThroughArgent(duringModal)).toBe(duringModal);
  });

  it("keeps argent's work that a dispatch queue or an event monitor calls argent's", () => {
    const fromQueue = [
      argent("SomeLibraryFunction"),
      system("_dispatch_call_block_and_release"),
      system("_dispatch_client_callout"),
      system("__CFRUNLOOP_IS_SERVICING_THE_MAIN_DISPATCH_QUEUE__"),
      app("main"),
    ];
    const fromEventMonitor = [
      argent("SomeLibraryFunction"),
      system("_NSSendEventToObservers"),
      system("-[NSApplication sendEvent:]"),
      system("-[NSApplication run]"),
      app("main"),
    ];
    expect(withAppCallsThroughArgent(fromQueue)).toBe(fromQueue);
    expect(withAppCallsThroughArgent(fromEventMonitor)).toBe(fromEventMonitor);
  });

  it("keeps a replaced method that argent's own work calls argent's", () => {
    const stack = [
      system("-[NSWindow orderWindow:relativeTo:]"),
      argent("SomeReplacedMethod"),
      system("-[NSWindow orderFront:]"),
      ...describeFromRunLoop.slice(1),
    ];
    expect(withAppCallsThroughArgent(stack)).toBe(stack);
  });

  it("keeps argent's work on a thread with no app frame argent's", () => {
    const stack = [
      argent("SomeLibraryFunction"),
      system("-[NSURLSession dataTaskWithRequest:]"),
      system("_pthread_start"),
    ];
    expect(withAppCallsThroughArgent(stack)).toBe(stack);
  });

  it("returns a stack with no argent frame unchanged", () => {
    const stack = [instruments("SomeRecorderFunction"), app("main")];
    expect(withAppCallsThroughArgent(stack)).toBe(stack);
    expect(withAppCallsThroughArgent([])).toEqual([]);
  });
});

describe("aggregateCpuHotspots without the tools' samples", () => {
  it("lists only the app's work, as a share of all the CPU time, the tools' included", () => {
    const samples = [
      ...[1, 2, 3, 4].map((ms) => sample(ms, [app("-[ExampleView layout]"), app("main")])),
      // An argent describe whose deeper frames are the app's main: not the app's cost.
      ...[10, 11, 12, 13, 14, 15].map((ms) =>
        sample(ms, [system("objc_msgSend"), argent("SomeLibraryFunction"), app("main")])
      ),
      sample(20, [instruments("SomeRecorderFunction"), app("main")]),
    ];

    const hotspots = aggregateCpuHotspots(samples);

    expect(hotspots.map((h) => h.dominantFunction)).toEqual(["-[ExampleView layout]"]);
    // 4 of the 11 samples.
    expect(hotspots[0]).toMatchObject({
      sampleCount: 4,
      totalWeightMs: 4,
      weightPercentage: 36.36,
    });
  });

  it("drops the app's small functions under the 3% floor when a tool did most of the work", () => {
    // 226 ms of samples, 216 ms of them argent's describe: each 2 ms function is
    // 0.9% of the CPU time, not 20% of the app's 10 ms.
    const hotspots = aggregateCpuHotspots([
      ...repeat(216, 0, [system("objc_msgSend"), argent("SomeLibraryFunction")]),
      ...repeat(2, 300, [app("-[ExampleView layout]")]),
      ...repeat(2, 310, [app("-[ExampleView drawRect:]")]),
      ...repeat(6, 320, [app("main")]),
    ]);

    expect(hotspots).toEqual([]);
  });

  it("bands the severity against all the CPU time", () => {
    const hotspots = aggregateCpuHotspots([
      ...repeat(28, 0, [argent("SomeLibraryFunction")]),
      ...repeat(60, 100, [app("-[ExampleView layout]")]),
      ...repeat(12, 200, [app("-[ExampleView drawRect:]")]),
    ]);

    expect(hotspots.map((h) => [h.dominantFunction, h.weightPercentage, h.severity])).toEqual([
      ["-[ExampleView layout]", 60, "RED"],
      ["-[ExampleView drawRect:]", 12, "YELLOW"],
    ]);
  });

  it("gives a thread's only function the share of the CPU time that thread_breakdown gives the thread", () => {
    const worker = (timeMs: number): CpuSample => ({
      ...sample(timeMs, [app("ExampleWorkerLoop")]),
      threadFmt: "Worker Thread 0x2",
    });
    const samples = [
      ...repeat(50, 0, [argent("SomeLibraryFunction")]),
      ...repeat(30, 100, [app("-[ExampleView layout]")]),
      ...Array.from({ length: 20 }, (_, i) => worker(200 + i)),
    ];
    const hotspots = aggregateCpuHotspots(samples);

    expect(renderThreadBreakdownIos(samples, hotspots, undefined, 10)).toContain(
      "| Worker Thread | 20 | 20.0% | 20 |"
    );
    expect(renderThreadBreakdownIos(samples, hotspots, "Worker", 10)).toContain(
      "| `ExampleWorkerLoop` | 20 | 20% | No |"
    );
  });

  it("finds no hotspot in a trace that holds only the tools' work", () => {
    const samples = [1, 2, 3].map((ms) => sample(ms, [argent("SomeLibraryFunction")]));
    expect(aggregateCpuHotspots(samples)).toEqual([]);
  });
});

describe("toolingWeightNs", () => {
  it("sums the weight of each tool's samples, and none of the app's", () => {
    const samples = [
      sample(1, [argent("SomeLibraryFunction")], 2_000_000),
      sample(2, [system("objc_msgSend"), argent("OtherLibraryFunction")], 3_000_000),
      sample(3, [instruments("SomeRecorderFunction")], 1_500_000),
      sample(4, [app("-[ExampleView layout]"), argent("SomeLibraryFunction")], 7_000_000),
      sample(5, [app("main")], 9_000_000),
    ];

    expect(toolingWeightNs(samples)).toEqual({ argent: 5_000_000, instruments: 1_500_000 });
  });

  it("is zero for both tools without samples", () => {
    expect(toolingWeightNs([])).toEqual({ argent: 0, instruments: 0 });
  });
});

describe("hang suspects from the tools' libraries", () => {
  it("lists the plain names, which the drill-down matches, and labels the tools' functions apart", () => {
    const samples = [
      ...[100, 101, 102].map((ms) => sample(ms, [argent("SomeLibraryFunction")])),
      sample(103, [app("-[ExampleView layout]")]),
      // Outside the hang window.
      sample(500, [instruments("SomeRecorderFunction")]),
    ];
    const { uiHangs } = correlateHangsWithCpu(
      [{ startNs: 100_000_000, durationNs: 10_000_000, hangType: "Hang", threadFmt: "Main" }],
      samples
    );

    expect(uiHangs[0]!.suspectedFunctions).toEqual([
      "SomeLibraryFunction",
      "-[ExampleView layout]",
    ]);
    // The recorder's sample is outside the hang window.
    expect(uiHangs[0]!.toolingLabels).toEqual({ SomeLibraryFunction: "argent's own library" });
  });

  it("has no labels for a hang with no tool's frame", () => {
    const { uiHangs } = correlateHangsWithCpu(
      [{ startNs: 100_000_000, durationNs: 10_000_000, hangType: "Hang", threadFmt: "Main" }],
      [sample(101, [system("objc_msgSend"), app("-[ExampleView layout]")])]
    );
    expect(uiHangs[0]!.suspectedFunctions).toEqual(["-[ExampleView layout]"]);
    expect(uiHangs[0]).not.toHaveProperty("toolingLabels");
  });
});

describe("runIosProfilerPipeline: the tools' CPU time", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "argent-tooling-pipeline-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports each tool's time and the total in whole milliseconds, apart from the hotspots", async () => {
    const cpu = join(dir, "cpu.xml");
    writeFileSync(
      cpu,
      cpuXml([
        row(
          1_000_000,
          `<backtrace id="1">${frame(2, "-[ExampleView layout]", binaryDef(3, "ExampleExec", APP_EXECUTABLE))}</backtrace>`,
          5_000_000
        ),
        row(
          2_000_000,
          `<backtrace id="4">${frame(5, "SomeLibraryFunction", binaryDef(6, "libNativeDevtoolsMacos.dylib", `${ARGENT_LIB_DIR}/libNativeDevtoolsMacos.dylib`))}</backtrace>`,
          1_400_000
        ),
        row(3_000_000, `<backtrace ref="4"/>`, 1_400_000),
        row(
          4_000_000,
          `<backtrace id="7">${frame(8, "SomeRecorderFunction", binaryDef(9, "liboainject.dylib", `${INSTRUMENTS_DIR}/liboainject.dylib`))}</backtrace>`,
          400_000
        ),
        // A sample with no stack is in no hotspot, so not in the total either.
        row(5_000_000, `<backtrace id="10"></backtrace>`, 2_000_000),
      ])
    );

    const out = await runIosProfilerPipeline({ cpu, hangs: null, leaks: null });

    // argent 2.8 ms, Instruments 0.4 ms, all 8.2 ms.
    expect(out.toolingCpuMs).toEqual({ argent: 3, instruments: 0 });
    expect(out.totalCpuMs).toBe(8);
    expect(out.cpuSamples).toHaveLength(5);
    expect(out.cpuHotspots.map((h) => h.dominantFunction)).toEqual(["-[ExampleView layout]"]);
    // 5 of the 8.2 ms.
    expect(out.cpuHotspots[0]!.weightPercentage).toBe(60.98);
  });

  it("gives the app a hang in a replaced method that the app called, in the hotspots and the suspects", async () => {
    const cpu = join(dir, "cpu.xml");
    const hangs = join(dir, "hangs.xml");
    const appKit = binaryDef(4, "AppKit", APPKIT);
    const app = binaryDef(9, "ExampleExec", APP_EXECUTABLE);
    // The app orders a window in through argent's replacement of the ordering method.
    const ordering =
      `<backtrace id="1">` +
      frame(2, "-[NSView layoutSubtreeIfNeeded]", appKit) +
      frame(5, "-[NSWindow orderWindow:relativeTo:]", `<binary ref="4"/>`) +
      frame(
        6,
        "SomeReplacedMethod",
        binaryDef(
          7,
          "libNativeDevtoolsMacos.dylib",
          `${ARGENT_LIB_DIR}/libNativeDevtoolsMacos.dylib`
        )
      ) +
      frame(8, "-[NSWindow makeKeyAndOrderFront:]", `<binary ref="4"/>`) +
      frame(10, "ExampleApp.openWindow()", app) +
      frame(11, "main", `<binary ref="9"/>`) +
      `</backtrace>`;
    // 40 ms of a 300 ms hang (13%): the main thread ran for 10% of the hang or more, so the
    // suspects are its own.
    writeFileSync(
      cpu,
      cpuXml([
        row(100_000_000, ordering),
        ...Array.from({ length: 39 }, (_, i) => row((101 + i) * 1_000_000, `<backtrace ref="1"/>`)),
      ])
    );
    writeFileSync(
      hangs,
      `<trace-query-result><node><row><start-time>100000000</start-time><duration>300000000</duration>` +
        `<hang-type>Hang</hang-type><thread fmt="Main Thread"></thread></row></node></trace-query-result>`
    );

    const out = await runIosProfilerPipeline({ cpu, hangs, leaks: null });

    expect(out.toolingCpuMs).toEqual({ argent: 0, instruments: 0 });
    expect(out.cpuHotspots.map((h) => h.dominantFunction)).toEqual(["ExampleApp.openWindow()"]);
    expect(out.uiHangs[0]!.suspectedFunctions).toEqual(["ExampleApp.openWindow()"]);
    expect(out.uiHangs[0]!.appCallChains[0]!.chain).toEqual(["ExampleApp.openWindow()", "main"]);
    expect(out.uiHangs[0]).not.toHaveProperty("toolingLabels");
  });

  it("reports zero time without a CPU export", async () => {
    const out = await runIosProfilerPipeline({ cpu: null, hangs: null, leaks: null });
    expect(out.toolingCpuMs).toEqual({ argent: 0, instruments: 0 });
    expect(out.totalCpuMs).toBe(0);
  });
});
