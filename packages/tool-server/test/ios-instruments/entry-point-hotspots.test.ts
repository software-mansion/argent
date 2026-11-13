/**
 * The app's entry point (`main`, `static App.$main()`) is in every stack of the main
 * thread. When only system code runs below it (drawing, layout, animation), it was the
 * report's top hotspot, with advice to look at what calls it, and a hang suspect, and no
 * query broke it down. Now it is "system code under" the entry point, with the system
 * frameworks that ran, and function_callers gives its heaviest system stack. A React
 * Native frame below the entry point is reported in its place.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIosProfilerPipeline } from "../../src/utils/ios-profiler/pipeline/index";
import {
  aggregateCpuHotspots,
  findDominantFunction,
  toolingWork,
} from "../../src/utils/ios-profiler/pipeline/02-aggregate";
import { correlateHangsWithCpu } from "../../src/utils/ios-profiler/pipeline/01-correlate";
import { renderNativeProfilerReport } from "../../src/utils/ios-profiler/render";
import {
  renderFunctionCallersIos,
  renderHangStacksIos,
  renderThreadBreakdownIos,
} from "../../src/tools/profiler/query/profiler-stack-query";
import { profilerCombinedReportTool } from "../../src/tools/profiler/combined/profiler-combined-report";
import {
  cacheProfilerPaths,
  clearCachedProfilerPaths,
} from "../../src/blueprints/react-profiler-session";
import type { CpuSample, StackFrame, UiHang } from "../../src/utils/ios-profiler/types";
import type { AppSuspensionSpan } from "../../src/utils/ios-profiler/app-suspensions";

const APP = "/Applications/Example.app/Contents/MacOS/Example.debug.dylib";
const FRAMEWORKS = "/System/Library/Frameworks";

function binaryDef(id: number, name: string, path: string): string {
  return `<binary id="${id}" name="${name}" UUID="00000000-0000-0000-0000-000000000000" arch="arm64" load-addr="0x100000000" path="${path}"/>`;
}

function cpuXml(rows: string[]): string {
  return `<trace-query-result><node>${rows.join("\n")}</node></trace-query-result>`;
}

function row(timeMs: number, backtrace: string, thread = "Main Thread 0x1", weightMs = 1): string {
  return (
    `<row><sample-time>${timeMs * 1_000_000}</sample-time>` +
    `<thread fmt="${thread} (Example, pid: 4321)"></thread>` +
    `<weight>${weightMs * 1_000_000}</weight>${backtrace}</row>`
  );
}

/** A backtrace, leaf first, of [name, binary name, binary path] frames. */
function backtrace(id: number, frames: [string, string, string][]): string {
  const binaries = new Map<string, number>();
  let next = id * 100;
  const body = frames
    .map(([name, lib, path]) => {
      let binary: string;
      const known = binaries.get(path);
      if (known === undefined) {
        const binaryId = next++;
        binaries.set(path, binaryId);
        binary = binaryDef(binaryId, lib, path);
      } else {
        binary = `<binary ref="${known}"/>`;
      }
      if (lib === "") return `<frame id="${next++}" name="${name}" addr="${name}"/>`;
      return `<frame id="${next++}" name="${name}" addr="0x1">${binary}</frame>`;
    })
    .join("");
  return `<backtrace id="${id}">${body}</backtrace>`;
}

const fw = (name: string, lib: string): [string, string, string] => [
  name,
  lib,
  `${FRAMEWORKS}/${lib}.framework/Versions/A/${lib}`,
];
const runtime = (name: string, lib: string): [string, string, string] => [
  name,
  lib,
  `/usr/lib/${lib}`,
];
const app = (name: string): [string, string, string] => [name, "Example.debug.dylib", APP];
const ENTRY: [string, string, string][] = [
  fw("-[NSApplication run]", "AppKit"),
  fw("NSApplicationMain", "AppKit"),
  fw("static App.main()", "SwiftUI"),
  app("static ExampleApp.$main()"),
  app("__debug_main_executable_dylib_entry_point"),
  runtime("start", "dyld"),
];

/** An idle animation: Core Animation commits and SwiftUI renders below the run loop. */
const ANIMATION = backtrace(1, [
  runtime("objc_msgSend", "libobjc.A.dylib"),
  fw("CA::Transaction::commit()", "QuartzCore"),
  fw("__CFRunLoopRun", "CoreFoundation"),
  ...ENTRY,
]);
const RENDER = backtrace(2, [
  fw("ViewGraphRootValueUpdater.render(interval:updateDisplayList:targetTimestamp:)", "SwiftUI"),
  fw("NSHostingView.layout()", "SwiftUI"),
  fw("__CFRunLoopRun", "CoreFoundation"),
  ...ENTRY,
]);
/** The app's own work, called from the run loop. */
const SPIN = backtrace(3, [
  app("profFixtureSpinMain()"),
  app("closure #1 in ContentView.body.getter"),
  fw("__CFRunLoopRun", "CoreFoundation"),
  ...ENTRY,
]);

describe("system code under the app's entry point", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "argent-entry-point-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function analyze(
    rows: string[],
    hangsXml?: string,
    { leaksXml, appSuspensions }: { leaksXml?: string; appSuspensions?: AppSuspensionSpan[] } = {}
  ) {
    const cpu = join(dir, "cpu.xml");
    writeFileSync(cpu, cpuXml(rows));
    let hangs: string | null = null;
    if (hangsXml) {
      hangs = join(dir, "hangs.xml");
      writeFileSync(hangs, hangsXml);
    }
    let leaks: string | null = null;
    if (leaksXml) {
      leaks = join(dir, "leaks.xml");
      writeFileSync(leaks, leaksXml);
    }
    const out = await runIosProfilerPipeline(
      { cpu, hangs, leaks },
      appSuspensions ? { appSuspensions } : {}
    );
    const { report } = await renderNativeProfilerReport({
      payload: {
        metadata: { traceFile: null, platform: "macOS", timestamp: "2026-11-13T00:00:00Z" },
        bottlenecks: out.bottlenecks,
      },
      traceFile: null,
    });
    return { out, report };
  }

  /**
   * The combined report of `hang` with a React commit at `commitMs`, and of the same hang a
   * minute later, with no commit.
   */
  async function combinedReport(
    hang: UiHang,
    commitMs: number,
    out: Awaited<ReturnType<typeof runIosProfilerPipeline>>
  ): Promise<string> {
    const DEVICE = "macos-app-com.example.app";
    const PORT = 8081;
    const START = 1_000_000;
    const commitsPath = join(dir, "commits.json");
    writeFileSync(
      commitsPath,
      JSON.stringify({
        commits: [
          {
            commitIndex: 0,
            timestamp: commitMs,
            componentName: "MyComp",
            actualDuration: 200,
            selfDuration: 200,
            commitDuration: 200,
            didRender: true,
            changeDescription: null,
          },
        ],
        meta: { profileStartWallMs: START },
      })
    );
    cacheProfilerPaths(
      PORT,
      {
        sessionId: "s",
        debugDir: dir,
        cpuProfilePath: null,
        commitsPath,
        cpuSampleIndexPath: null,
        detectedArchitecture: null,
        anyCompilerOptimized: null,
        hotCommitIndices: [0],
        totalReactCommits: 1,
      },
      DEVICE
    );
    try {
      const later = { ...hang, startNs: 60_000_000_000, endNs: 60_300_000_000 };
      const api = {
        platform: "macos",
        traceFile: join(dir, "native-profiler-20260101-000000.trace"),
        exportedFiles: null,
        profilingActive: false,
        recordingTimedOut: false,
        recordingExitedUnexpectedly: false,
        stopInProgress: null,
        parsedData: {
          cpuSamples: out.cpuSamples,
          uiHangs: [hang, { ...later, startTimeFormatted: "01:00.000" }],
          cpuHotspots: out.cpuHotspots,
          memoryLeaks: [],
          leaksRecorded: true,
          mallocStackLogging: null,
          wallClockStartMs: START,
        },
      };
      return (await profilerCombinedReportTool.execute({ nativeSession: api } as never, {
        port: PORT,
        device_id: DEVICE,
      })) as string;
    } finally {
      clearCachedProfilerPaths(PORT, DEVICE);
    }
  }

  // 60 ms of an idle animation, 20 ms of SwiftUI rendering, 20 ms of the app's own spin.
  const rows = [
    row(1, ANIMATION),
    ...Array.from({ length: 59 }, (_, i) => row(2 + i, `<backtrace ref="1"/>`)),
    row(100, RENDER),
    ...Array.from({ length: 19 }, (_, i) => row(101 + i, `<backtrace ref="2"/>`)),
    row(200, SPIN),
    ...Array.from({ length: 19 }, (_, i) => row(201 + i, `<backtrace ref="3"/>`)),
  ];

  it("names the system frameworks that ran, not the entry point, as the hotspot", async () => {
    const { out, report } = await analyze(rows);

    const entry = out.cpuHotspots.find((h) => h.dominantFunction === "static ExampleApp.$main()");
    expect(entry?.weightPercentage).toBe(80);
    // libobjc's time counts for QuartzCore, which called it.
    expect(entry?.systemCode).toEqual({
      frameworks: [
        { name: "QuartzCore", weightPercentage: 75 },
        { name: "SwiftUI", weightPercentage: 25 },
      ],
    });
    expect(report).toContain(
      "| 1 | system code under `static ExampleApp.$main()` | Main Thread | 80 | 80% |"
    );
    expect(report).toContain(
      "### system code under `static ExampleApp.$main()` (Main Thread)\n\nOnly the entry point of the app is in these stacks: below it, the main run loop ran system code.\n"
    );
    expect(report).not.toMatch(
      /`static ExampleApp\.\$main\(\)` on Main Thread \(80%\): High CPU in this function/
    );
    expect(report).toContain(
      "system code under `static ExampleApp.$main()` on Main Thread (80%): Not a function of the app: system frameworks (QuartzCore 75%, SwiftUI 25%) did this work"
    );
    expect(report).toContain(
      "mode=`function_callers` function_name=`static ExampleApp.$main()` — the heaviest system stack below it"
    );
    // Each once: the frameworks in the advice, function_callers in the next steps.
    expect(report.split("QuartzCore 75%, SwiftUI 25%")).toHaveLength(2);
    expect(report.split("heaviest system stack below it")).toHaveLength(2);
  });

  it("leaves a hotspot of the app's own code as it was", async () => {
    const { out, report } = await analyze(rows);

    const spin = out.cpuHotspots.find((h) => h.dominantFunction === "profFixtureSpinMain()");
    expect(spin).toMatchObject({ weightPercentage: 20, severity: "RED", thread: "Main Thread" });
    expect(spin).not.toHaveProperty("systemCode");
    expect(spin?.topCallChain).toEqual([
      "profFixtureSpinMain()",
      "closure #1 in ContentView.body.getter",
      "static ExampleApp.$main()",
      "__debug_main_executable_dylib_entry_point",
    ]);
    expect(report).toContain(
      "`profFixtureSpinMain()` on Main Thread (20%): High CPU in this function"
    );
    expect(report).toContain(
      "mode=`function_callers` function_name=`profFixtureSpinMain()` — who calls this hot function"
    );
  });

  it("labels the entry point as system code where it is a hang suspect", async () => {
    const { out, report } = await analyze(
      rows,
      `<trace-query-result><node><row><start-time>1000000</start-time><duration>300000000</duration>` +
        `<hang-type>Hang</hang-type><thread fmt="Main Thread"></thread></row></node></trace-query-result>`
    );

    expect(out.uiHangs[0]!.suspectedFunctions[0]).toBe("static ExampleApp.$main()");
    expect(report).toContain(
      "Likely caused by: `static ExampleApp.$main()` (the app's entry point, with only system code below it)."
    );
    // Only where no app frame is below it: the spin's chain runs the app's own code.
    expect(report).toContain(
      "1. `static ExampleApp.$main()` (the app's entry point, with only system code below it) > `__debug_main_executable_dylib_entry_point` (80 samples)"
    );
    expect(report).toContain(
      "2. `profFixtureSpinMain() > closure #1 in ContentView.body.getter > static ExampleApp.$main() > __debug_main_executable_dylib_entry_point` (20 samples)"
    );
  });

  it("labels the entry point in hang_stacks as the report does", async () => {
    const { out } = await analyze(
      rows,
      `<trace-query-result><node><row><start-time>1000000</start-time><duration>300000000</duration>` +
        `<hang-type>Hang</hang-type><thread fmt="Main Thread"></thread></row></node></trace-query-result>`
    );

    const stacks = renderHangStacksIos(out.cpuSamples, out.uiHangs, 0, 15);
    expect(stacks).toContain(
      "1. `static ExampleApp.$main()` (the app's entry point, with only system code below it)\n" +
        "2. `profFixtureSpinMain()`\n"
    );
    expect(stacks).toContain(
      "- (80 samples) `static ExampleApp.$main()` (the app's entry point, with only system code below it) → `__debug_main_executable_dylib_entry_point`\n" +
        "- (20 samples) `profFixtureSpinMain()` → `closure #1 in ContentView.body.getter` → `static ExampleApp.$main()` → `__debug_main_executable_dylib_entry_point`\n"
    );
  });

  it("gives a labelled suspect a code span that function_callers matches", async () => {
    const { out, report } = await analyze(
      rows,
      `<trace-query-result><node><row><start-time>1000000</start-time><duration>300000000</duration>` +
        `<hang-type>Hang</hang-type><thread fmt="Main Thread"></thread></row></node></trace-query-result>`
    );

    const stacks = renderHangStacksIos(out.cpuSamples, out.uiHangs, 0, 15);
    const fromStacks = /1\. `([^`]+)`/.exec(stacks)![1]!;
    const fromReport = /Likely caused by: `([^`]+)`/.exec(report)![1]!;
    for (const name of [fromStacks, fromReport]) {
      expect(name).toBe("static ExampleApp.$main()");
      expect(renderFunctionCallersIos(out.cpuSamples, name, 15)).toContain(
        "**Occurrences in samples:** 100"
      );
    }
  });

  it("names system code as such in thread_breakdown and in the combined report", async () => {
    const { out } = await analyze(
      rows,
      `<trace-query-result><node><row><start-time>1000000</start-time><duration>300000000</duration>` +
        `<hang-type>Hang</hang-type><thread fmt="Main Thread"></thread></row></node></trace-query-result>`
    );

    expect(renderThreadBreakdownIos(out.cpuSamples, out.cpuHotspots, "main", 15)).toContain(
      "| system code under `static ExampleApp.$main()` | 80 | 80% | Yes |"
    );

    // A React commit at the hang, and the same hang a minute later, with no commit.
    const DEVICE = "macos-app-com.example.app";
    const PORT = 8081;
    const START = 1_000_000;
    const commitsPath = join(dir, "commits.json");
    writeFileSync(
      commitsPath,
      JSON.stringify({
        commits: [
          {
            commitIndex: 0,
            timestamp: 100,
            componentName: "MyComp",
            actualDuration: 200,
            selfDuration: 200,
            commitDuration: 200,
            didRender: true,
            changeDescription: null,
          },
        ],
        meta: { profileStartWallMs: START },
      })
    );
    cacheProfilerPaths(
      PORT,
      {
        sessionId: "s",
        debugDir: dir,
        cpuProfilePath: null,
        commitsPath,
        cpuSampleIndexPath: null,
        detectedArchitecture: null,
        anyCompilerOptimized: null,
        hotCommitIndices: [0],
        totalReactCommits: 1,
      },
      DEVICE
    );
    try {
      const hang = out.uiHangs[0]!;
      const later = { ...hang, startNs: 60_000_000_000, endNs: 60_300_000_000 };
      const api = {
        platform: "macos",
        traceFile: join(dir, "native-profiler-20260101-000000.trace"),
        exportedFiles: null,
        profilingActive: false,
        recordingTimedOut: false,
        recordingExitedUnexpectedly: false,
        stopInProgress: null,
        parsedData: {
          cpuSamples: out.cpuSamples,
          uiHangs: [hang, { ...later, startTimeFormatted: "01:00.000" }],
          cpuHotspots: out.cpuHotspots,
          memoryLeaks: [],
          leaksRecorded: true,
          mallocStackLogging: null,
          wallClockStartMs: START,
        },
      };
      const report = (await profilerCombinedReportTool.execute({ nativeSession: api } as never, {
        port: PORT,
        device_id: DEVICE,
      })) as string;
      const entry =
        "`static ExampleApp.$main()` (the app's entry point, with only system code below it)";
      expect(report).toContain(
        `Native CPU (Instruments) during this hang:\n- ${entry}\n- \`profFixtureSpinMain()\``
      );
      expect(report).toContain(`- **Hang** at 01:00.000 (300ms) — ${entry}`);
    } finally {
      clearCachedProfilerPaths(PORT, DEVICE);
    }
  });

  describe("a hang's suspects", () => {
    // Map tiles that the system decodes on a worker thread, and a loop of the app on another.
    const tiles = backtrace(5, [
      fw("-[VKTile decode]", "VectorKit"),
      runtime("_dispatch_worker_thread2", "libdispatch.dylib"),
      runtime("_pthread_wqthread", "libsystem_pthread.dylib"),
      runtime("start_wqthread", "libsystem_pthread.dylib"),
    ]);
    const loop = backtrace(6, [
      app("ExampleWorkerLoop"),
      runtime("_pthread_start", "libsystem_pthread.dylib"),
    ]);
    // In the main thread's hang (80 ms of system code, 20 ms of its spin), 100 ms of the
    // tiles and 90 ms of the loop.
    const workers = [
      row(1, tiles, "Example 0x2"),
      ...Array.from({ length: 99 }, (_, i) => row(2 + i, `<backtrace ref="5"/>`, "Example 0x2")),
      row(1, loop, "Example 0x3"),
      ...Array.from({ length: 89 }, (_, i) => row(2 + i, `<backtrace ref="6"/>`, "Example 0x3")),
    ];
    const hang = (thread: string) =>
      `<trace-query-result><node><row><start-time>1000000</start-time><duration>300000000</duration>` +
      `<hang-type>Hang</hang-type><thread fmt="${thread}"></thread></row></node></trace-query-result>`;

    it("come from the hang's thread, not from work on other threads at the same time", async () => {
      const { out, report } = await analyze(
        [...rows, ...workers],
        hang("Main Thread 0x1 (Example, pid: 4321)")
      );

      expect(out.uiHangs[0]!.suspectedFunctions).toEqual([
        "static ExampleApp.$main()",
        "profFixtureSpinMain()",
      ]);
      expect(out.uiHangs[0]!.appCallChains.map((c) => [c.chain[0], c.sampleCount])).toEqual([
        ["static ExampleApp.$main()", 80],
        ["profFixtureSpinMain()", 20],
      ]);
      expect(report).toContain(
        "Likely caused by: `static ExampleApp.$main()` (the app's entry point, with only system code below it)."
      );
      // The workers' time still overlaps the hang.
      expect(out.cpuHotspots.find((h) => h.dominantFunction === "start_wqthread")).toMatchObject({
        thread: "Example",
        duringHang: true,
      });
    });

    it("come from all threads when no sample has the name of the hang's thread", async () => {
      const { out } = await analyze([...rows, ...workers], hang("Render 0x9 (Example, pid: 4321)"));

      expect(out.uiHangs[0]!.suspectedFunctions).toEqual([
        "start_wqthread",
        "ExampleWorkerLoop",
        "static ExampleApp.$main()",
        "profFixtureSpinMain()",
      ]);
    });

    // The main thread waits from 400 ms for a worker of the app (dispatch_sync, a semaphore).
    const load = backtrace(7, [
      app("ExampleStore.loadAll()"),
      runtime("_pthread_start", "libsystem_pthread.dylib"),
    ]);
    const loader = [
      row(500, load, "Example 0x3"),
      ...Array.from({ length: 99 }, (_, i) => row(501 + i, `<backtrace ref="7"/>`, "Example 0x3")),
    ];
    const waiting =
      `<trace-query-result><node><row><start-time>400000000</start-time><duration>300000000</duration>` +
      `<hang-type>Hang</hang-type><thread fmt="Main Thread 0x1 (Example, pid: 4321)"></thread></row></node></trace-query-result>`;
    /** The main thread's system code in the hang, for `ms` samples of `weightMs` from 690 ms back. */
    const mainInHang = (count: number, weightMs = 1) =>
      Array.from({ length: count }, (_, i) =>
        row(690 - i * weightMs, `<backtrace ref="1"/>`, "Main Thread 0x1", weightMs)
      );
    const waitedNote = (ranMs: number) =>
      `The main thread ran for ${ranMs} ms of this 300 ms hang, so it very possibly waited, for ` +
      `example for a lock, a synchronous call to another thread or I/O. These are what all ` +
      `threads ran.`;

    it("come from the other threads when the hang's thread has no sample in the hang", async () => {
      const { out, report } = await analyze([...rows, ...loader], waiting);

      expect(out.uiHangs[0]!.suspectedFunctions).toEqual(["ExampleStore.loadAll()"]);
      expect(out.uiHangs[0]).toMatchObject({ suspectsFromOtherThreads: true, hangThreadRanMs: 0 });
      expect(report).toContain(
        "**Hang at 00:00.400 (300ms)** — app call chains during this hang:\n" +
          `${waitedNote(0)}\n` +
          "1. `ExampleStore.loadAll()` (100 samples)"
      );
      expect(renderHangStacksIos(out.cpuSamples, out.uiHangs, 0, 15)).toContain(
        `**Severity:** RED\n\n${waitedNote(0)}\n\n` +
          "### Suspected Functions (by sample frequency)\n\n" +
          "1. `ExampleStore.loadAll()`\n"
      );
      // A hang whose thread ran keeps the suspects of its own thread.
      const own = await analyze(
        [...rows, ...workers],
        hang("Main Thread 0x1 (Example, pid: 4321)")
      );
      expect(own.out.uiHangs[0]!.suspectsFromOtherThreads).toBeUndefined();
    });

    it("come from the other threads when the hang's thread woke for 2 ms of the hang", async () => {
      const { out, report } = await analyze([...rows, ...loader, ...mainInHang(2)], waiting);

      expect(out.uiHangs[0]!.suspectedFunctions).toEqual([
        "ExampleStore.loadAll()",
        "static ExampleApp.$main()",
      ]);
      expect(out.uiHangs[0]).toMatchObject({ suspectsFromOtherThreads: true, hangThreadRanMs: 2 });
      expect(report).toContain(
        "**Hang at 00:00.400 (300ms)** — app call chains during this hang:\n" + waitedNote(2)
      );
    });

    it("come from the hang's thread when it ran for 10% of the hang or more", async () => {
      // 31 ms of a 300 ms hang: its own suspects. 29 ms: what the other threads ran.
      const above = await analyze([...rows, ...loader, ...mainInHang(31)], waiting);
      expect(above.out.uiHangs[0]!.suspectedFunctions).toEqual(["static ExampleApp.$main()"]);
      expect(above.out.uiHangs[0]!.suspectsFromOtherThreads).toBeUndefined();
      expect(above.report).not.toContain("very possibly waited");

      const below = await analyze([...rows, ...loader, ...mainInHang(29)], waiting);
      expect(below.out.uiHangs[0]!.suspectedFunctions[0]).toBe("ExampleStore.loadAll()");
      expect(below.out.uiHangs[0]!.hangThreadRanMs).toBe(29);

      // The samples' weights count, not their number: 4 samples of 10 ms are 40 ms.
      const weighted = await analyze([...rows, ...loader, ...mainInHang(4, 10)], waiting);
      expect(weighted.out.uiHangs[0]!.suspectsFromOtherThreads).toBeUndefined();
    });

    it("take the hang's length without the time when the app was suspended", async () => {
      // A 2000 ms hang with 1700 ms suspended: 40 ms of the main thread is 13% of its 300 ms.
      const long =
        `<trace-query-result><node><row><start-time>400000000</start-time><duration>2000000000</duration>` +
        `<hang-type>Severe Hang</hang-type><thread fmt="Main Thread 0x1 (Example, pid: 4321)"></thread></row></node></trace-query-result>`;
      const cpu = join(dir, "cpu.xml");
      writeFileSync(cpu, cpuXml([...rows, ...loader, ...mainInHang(40)]));
      const hangs = join(dir, "hangs.xml");
      writeFileSync(hangs, long);
      const out = await runIosProfilerPipeline(
        { cpu, hangs, leaks: null },
        { appSuspensions: [{ startNs: 700_000_000, endNs: 2_400_000_000 }] }
      );
      expect(out.uiHangs[0]).toMatchObject({ durationMs: 300, suspendedMs: 1700 });
      expect(out.uiHangs[0]!.suspectedFunctions).toEqual(["static ExampleApp.$main()"]);
      expect(out.uiHangs[0]!.suspectsFromOtherThreads).toBeUndefined();
    });

    it("say in the advice that the main thread very possibly waited, not to move work off it", async () => {
      const { report } = await analyze([...rows, ...loader], waiting);
      const advice = report.split("\n").find((l) => l.startsWith("- 🔴 Hang at 00:00.400"));
      expect(advice).toBe(
        "- 🔴 Hang at 00:00.400 (300ms): The main thread mostly did not run during the hang, so " +
          "it very possibly waited, for example for a lock, a synchronous call to another thread " +
          "or I/O. The function that ran most on all threads: `ExampleStore.loadAll()`."
      );
    });

    it("are marked in the combined report as what other threads ran", async () => {
      const { out } = await analyze([...rows, ...loader], waiting);
      const report = await combinedReport(out.uiHangs[0]!, 400, out);
      expect(report).toContain(
        `Native CPU (Instruments) during this hang:\n${waitedNote(0)}\n- \`ExampleStore.loadAll()\``
      );
      expect(report).toContain(
        "- **Hang** at 01:00.000 (300ms) — `ExampleStore.loadAll()` (on all threads: the main " +
          "thread very possibly waited)\n"
      );
    });

    // The Mac fixture's "block" hangs: the main thread sleeps, and no other thread runs.
    const block = backtrace(8, [
      app("Delegate.blockPressed()"),
      fw("__CFRunLoopRun", "CoreFoundation"),
      ...ENTRY,
    ]);
    const severe = (durationMs: number, thread = "Main Thread 0x1") =>
      `<trace-query-result><node><row><start-time>400000000</start-time><duration>${durationMs * 1_000_000}</duration>` +
      `<hang-type>Severe Hang</hang-type><thread fmt="${thread} (Example, pid: 4321)"></thread></row></node></trace-query-result>`;
    const noThreadNote = (ranMs: number, durationMs: number) =>
      `The main thread ran for ${ranMs} ms of this ${durationMs} ms hang, and no other thread ` +
      `ran on the CPU, so the main thread very possibly waited, for example in a sleep, for a ` +
      `lock or for I/O.`;
    const noThreadAdvice =
      "No thread ran on the CPU for most of the hang, so the main thread very possibly " +
      "waited, for example in a sleep, for a lock or for I/O.";
    const adviceAt400 = (report: string) =>
      report.split("\n").find((l) => /^- (🔴|🟡) .* at 00:00\.400 /.test(l));

    const mainRan = " These are what the main thread ran.";
    const blockChain =
      "`Delegate.blockPressed() > static ExampleApp.$main() > __debug_main_executable_dylib_entry_point`";

    it("come from the main thread when no other thread ran for most of the hang", async () => {
      // 1 ms of the main thread in a 2166 ms hang, and no other thread on the CPU: its one
      // sample names the function that blocked.
      const { out, report } = await analyze([...rows, row(500, block)], severe(2166));

      expect(out.uiHangs[0]).toMatchObject({
        suspectedFunctions: ["Delegate.blockPressed()"],
        hangThreadRanMs: 1,
      });
      expect(out.uiHangs[0]!.suspectsFromOtherThreads).toBeUndefined();
      expect(adviceAt400(report)).toBe(
        `- 🔴 Severe Hang at 00:00.400 (2166ms): ${noThreadAdvice} The function that ran most ` +
          "on the main thread: `Delegate.blockPressed()`."
      );
      expect(report).toContain(
        "**Severe Hang at 00:00.400 (2166ms)** — app call chains during this hang:\n" +
          `${noThreadNote(1, 2166)}${mainRan}\n1. ${blockChain} (1 samples)`
      );
      expect(report).not.toContain("Likely caused by");
      expect(renderHangStacksIos(out.cpuSamples, out.uiHangs, 0, 15)).toContain(
        `**Severity:** RED\n\n${noThreadNote(1, 2166)}${mainRan}\n\n` +
          "### Suspected Functions (by sample frequency)\n\n1. `Delegate.blockPressed()`\n"
      );
      expect(renderFunctionCallersIos(out.cpuSamples, "Delegate.blockPressed()", 5)).toContain(
        "**Occurrences in samples:** 1"
      );
      const combined = await combinedReport(out.uiHangs[0]!, 400, out);
      expect(combined).toContain(
        "Native CPU (Instruments) during this hang:\n" +
          `${noThreadNote(1, 2166)}${mainRan}\n- \`Delegate.blockPressed()\`\n`
      );
      expect(combined).toContain(
        "- **Severe Hang** at 01:00.000 (2166ms) — `Delegate.blockPressed()` (the main thread " +
          "very possibly waited)\n"
      );
    });

    it("are none in a hang with no CPU sample, of a thread with samples elsewhere in the trace", async () => {
      const { out, report } = await analyze(rows, severe(2173));
      expect(out.uiHangs[0]).toMatchObject({ suspectedFunctions: [], hangThreadRanMs: 0 });
      expect(adviceAt400(report)).toBe(`- 🔴 Severe Hang at 00:00.400 (2173ms): ${noThreadAdvice}`);
      expect(report).toContain(`**Severe Hang at 00:00.400 (2173ms)**\n${noThreadNote(0, 2173)}\n`);
      expect(await combinedReport(out.uiHangs[0]!, 400, out)).toContain(
        "- **Severe Hang** at 01:00.000 (2173ms) — the main thread very possibly waited\n"
      );

      // A thread with no sample in the whole trace can have another name in the samples, so
      // how long it ran is not known.
      const unknown = await analyze(rows, severe(2173, "Render 0x9"));
      expect(unknown.out.uiHangs[0]!.hangThreadRanMs).toBeUndefined();
      expect(adviceAt400(unknown.report)).toBe(
        "- 🔴 Severe Hang at 00:00.400 (2173ms): Main thread stalled past the frame budget — " +
          "move heavy work off the main thread."
      );
    });

    describe("of a trace with leak data", () => {
      // The main thread spins for 400 ms of a 5000 ms hang, and a worker loads for 100 ms.
      // Then the app is suspended, for example for a leak check, until the hang ends.
      const busy = [
        ...rows,
        ...loader,
        ...Array.from({ length: 400 }, (_, i) => row(401 + i, `<backtrace ref="1"/>`)),
      ];
      const long = severe(5000);
      const leaksXml = "<trace-query-result><node></node></trace-query-result>";
      const leakCheck = " Instruments may also have held the app suspended for a leak check.";

      it("name a leak check as a cause of a waited hang when the app's suspensions are not known", async () => {
        const { out, report } = await analyze(busy, long, { leaksXml });

        expect(out.uiHangs[0]).toMatchObject({
          suspectsFromOtherThreads: true,
          hangThreadRanMs: 400,
          mayHoldLeakCheck: true,
        });
        expect(adviceAt400(report)).toBe(
          "- 🔴 Severe Hang at 00:00.400 (5000ms): The main thread mostly did not run during " +
            "the hang, so it very possibly waited, for example for a lock, a synchronous call to " +
            `another thread or I/O.${leakCheck} The function that ran most on all threads: ` +
            "`static ExampleApp.$main()` (the app's entry point, with only system code below it)."
        );
        const note =
          "The main thread ran for 400 ms of this 5000 ms hang, so it very possibly waited, for " +
          "example for a lock, a synchronous call to another thread or I/O." +
          leakCheck +
          " These are what all threads ran.";
        expect(report).toContain(`app call chains during this hang:\n${note}\n`);
        expect(renderHangStacksIos(out.cpuSamples, out.uiHangs, 0, 15)).toContain(
          `**Severity:** RED\n\n${note}\n`
        );
        const combined = await combinedReport(out.uiHangs[0]!, 400, out);
        expect(combined).toContain(`Native CPU (Instruments) during this hang:\n${note}\n`);
        expect(combined).toContain(
          "(on all threads: the main thread very possibly waited, and Instruments may also have " +
            "held the app suspended for a leak check)\n"
        );

        // No other thread ran: the leak check is also named.
        const blocked = await analyze([...rows, row(500, block)], severe(2166), { leaksXml });
        expect(adviceAt400(blocked.report)).toBe(
          `- 🔴 Severe Hang at 00:00.400 (2166ms): ${noThreadAdvice}${leakCheck} The function ` +
            "that ran most on the main thread: `Delegate.blockPressed()`."
        );
        expect(blocked.report).toContain(`${noThreadNote(1, 2166)}${leakCheck}${mainRan}\n`);
        expect(await combinedReport(blocked.out.uiHangs[0]!, 400, blocked.out)).toContain(
          "— `Delegate.blockPressed()` (the main thread very possibly waited, and Instruments may " +
            "also have held the app suspended for a leak check)\n"
        );
      });

      it("keep the main thread's own suspects in a waited hang that holds a leak check's pause", async () => {
        // A 1000 ms spin of the main thread, then 11 s of a leak check that argent did not see,
        // in one 12000 ms hang, and no other thread on the CPU.
        const spin = [
          ...rows,
          ...Array.from({ length: 1000 }, (_, i) => row(400 + i, `<backtrace ref="3"/>`)),
        ];
        const { out, report } = await analyze(spin, severe(12_000), { leaksXml });

        expect(out.uiHangs[0]).toMatchObject({
          hangThreadRanMs: 1000,
          mayHoldLeakCheck: true,
          suspectedFunctions: ["profFixtureSpinMain()"],
        });
        expect(adviceAt400(report)).toBe(
          `- 🔴 Severe Hang at 00:00.400 (12000ms): ${noThreadAdvice}${leakCheck} The function ` +
            "that ran most on the main thread: `profFixtureSpinMain()`."
        );
        expect(renderHangStacksIos(out.cpuSamples, out.uiHangs, 0, 15)).toContain(
          `${noThreadNote(1000, 12_000)}${leakCheck}${mainRan}\n\n` +
            "### Suspected Functions (by sample frequency)\n\n1. `profFixtureSpinMain()`\n"
        );

        // With the pause known, the hang is the spin's own 1000 ms.
        const known = await analyze(spin, severe(12_000), {
          leaksXml,
          appSuspensions: [{ startNs: 1_400_000_000, endNs: 12_400_000_000 }],
        });
        expect(known.out.uiHangs[0]).toMatchObject({ durationMs: 1000, suspendedMs: 11_000 });
        expect(known.out.uiHangs[0]!.hangThreadRanMs).toBeUndefined();
        expect(adviceAt400(known.report)).toContain("Likely caused by: `profFixtureSpinMain()`.");
      });

      it("name no leak check in a waited hang when the app's suspensions are known", async () => {
        // A block that a leak check hit (5585 ms, 4891 ms suspended), and a watch that saw no pause.
        for (const appSuspensions of [[{ startNs: 1_000_000_000, endNs: 5_891_000_000 }], []]) {
          const { out, report } = await analyze(rows, severe(5585), { leaksXml, appSuspensions });
          expect(out.uiHangs[0]!.hangThreadRanMs).toBe(0);
          expect(out.uiHangs[0]!.mayHoldLeakCheck).toBeUndefined();
          expect(report).not.toContain("leak check");
        }
      });

      it("keep the main thread's own suspects when the app's suspensions are known", async () => {
        const { out, report } = await analyze(busy, long, {
          leaksXml,
          appSuspensions: [{ startNs: 800_000_000, endNs: 5_400_000_000 }],
        });

        expect(out.uiHangs[0]).toMatchObject({ durationMs: 400, suspendedMs: 4600 });
        expect(out.uiHangs[0]!.suspectedFunctions).toEqual(["static ExampleApp.$main()"]);
        expect(out.uiHangs[0]!.hangThreadRanMs).toBeUndefined();
        expect(out.uiHangs[0]!.mayHoldLeakCheck).toBeUndefined();
        expect(adviceAt400(report)).toContain("move heavy work off the main thread");
      });

      it("do not name a leak check when the trace has no leak data", async () => {
        const { out, report } = await analyze(busy, long);
        expect(out.uiHangs[0]).toMatchObject({ hangThreadRanMs: 400 });
        expect(out.uiHangs[0]!.mayHoldLeakCheck).toBeUndefined();
        expect(report).not.toContain("leak check");
      });
    });
  });

  it("reports a stack with no app frame under its root as system code", async () => {
    // From an idle app on an iOS 27 simulator: two frames of no known binary, below
    // libsystem_pthread's thread start. It had been a RED hotspot `_pthread_wqthread`.
    const worker = backtrace(4, [
      ["0x1e643d281", "", ""],
      ["0x1e642f2ff", "", ""],
      runtime("_pthread_wqthread", "libsystem_pthread.dylib"),
      runtime("start_wqthread", "libsystem_pthread.dylib"),
    ]);
    const { out, report } = await analyze([
      ...rows,
      row(300, worker, "Example 0x2"),
      ...Array.from({ length: 24 }, (_, i) => row(301 + i, `<backtrace ref="4"/>`, "Example 0x2")),
    ]);

    expect(out.cpuHotspots.map((h) => h.dominantFunction)).not.toContain("_pthread_wqthread");
    const workerHotspot = out.cpuHotspots.find((h) => h.dominantFunction === "start_wqthread");
    expect(workerHotspot).toMatchObject({
      weightPercentage: 20,
      systemCode: { frameworks: [{ name: "libsystem_pthread.dylib", weightPercentage: 100 }] },
    });
    expect(report).toContain("### system code under `start_wqthread` (Example)");
    expect(report).toContain(
      "No function of the app is in these stacks: only system code ran on this thread.\n"
    );
    expect(report).toContain(
      "system code under `start_wqthread` on Example (20%): Not a function of the app: only system code (libsystem_pthread.dylib 100%) ran on this thread"
    );
    const text = renderFunctionCallersIos(out.cpuSamples, "start_wqthread", 15);
    expect(text).toContain("In the 25 samples with only system code below the function");
    expect(text).toContain("| `_pthread_wqthread` > `0x1e642f2ff` > `0x1e643d281` | 25 | 100.0% |");
  });

  it("gives function_callers of the entry point its heaviest system stack", async () => {
    const { out } = await analyze(rows);

    const text = renderFunctionCallersIos(out.cpuSamples, "static ExampleApp.$main()", 15);
    expect(text).toContain("### Heaviest System Stack Below");
    expect(text).toContain("In the 80 samples with only system code below the function");
    expect(text).toContain(
      "| `static App.main()` > `NSApplicationMain` > `-[NSApplication run]` > `__CFRunLoopRun` | 80 | 100.0% |"
    );
    expect(text).toContain("| `CA::Transaction::commit()` > `objc_msgSend` | 60 | 75.0% |");
    // The app's own spin under the entry point is its own hotspot, not part of this stack.
    expect(text).not.toMatch(/\| `[^|]*profFixtureSpinMain/);
    // An app function's callers keep their old form.
    expect(renderFunctionCallersIos(out.cpuSamples, "profFixtureSpinMain()", 15)).not.toContain(
      "Heaviest System Stack Below"
    );
  });
});

const appFrame = (name: string): StackFrame => ({ name, isSystemLibrary: false });
const sys = (name: string, library?: string): StackFrame => ({
  name,
  isSystemLibrary: true,
  ...(library ? { library } : {}),
});

function sample(timeMs: number, stack: StackFrame[]): CpuSample {
  return {
    timestampNs: timeMs * 1_000_000,
    threadFmt: "Main Thread 0x1",
    weightNs: 1_000_000,
    stack,
  };
}

describe("the frame reported for a stack with the entry point", () => {
  it("is a React Native frame below the entry point, not the entry point", () => {
    const stack = [
      sys("objc_retain", "libobjc.A.dylib"),
      appFrame("-[RCTViewComponentView unmountChildComponentView:index:]"),
      appFrame("RCTPerformMountInstructions(...)"),
      sys("__CFRunLoopRun", "CoreFoundation"),
      appFrame("main"),
      sys("start", "dyld"),
    ];
    expect(findDominantFunction(stack)).toBe(
      "-[RCTViewComponentView unmountChildComponentView:index:]"
    );
    const [hotspot] = aggregateCpuHotspots([sample(1, stack)]);
    expect(hotspot).not.toHaveProperty("systemCode");
  });

  it("is the entry point, as the app's own code, when it is the leaf", () => {
    const stack = [appFrame("main"), sys("start", "dyld")];
    expect(findDominantFunction(stack)).toBe("main");
    const [hotspot] = aggregateCpuHotspots([sample(1, stack)]);
    expect(hotspot!.dominantFunction).toBe("main");
    expect(hotspot).not.toHaveProperty("systemCode");
  });

  it("does not change whose work a tool's sample is", () => {
    // argent's describe reads a React Native view: argent's work, as before.
    const stack: StackFrame[] = [
      appFrame("-[RCTViewComponentView accessibilityLabel]"),
      { name: "SomeLibraryFunction", isSystemLibrary: false, tooling: "argent" },
      sys("__CFRunLoopRun", "CoreFoundation"),
      appFrame("main"),
    ];
    expect(toolingWork(stack)).toBe("argent");
  });

  it("leaves Instruments' recorder out of the heaviest system stack, as out of the hotspot", () => {
    const run = [sys("-[NSApplication run]", "AppKit"), appFrame("main"), sys("start", "dyld")];
    const recorder: StackFrame[] = [
      { name: "0x1201208b8", isSystemLibrary: false, tooling: "instruments" },
      sys("_malloc_zone_malloc_instrumented_or_legacy", "libsystem_malloc.dylib"),
      sys("CA::Transaction::commit()", "QuartzCore"),
      ...run,
    ];
    const drawing = [sys("CA::Layer::display()", "QuartzCore"), ...run];
    const samples = [
      ...Array.from({ length: 3 }, (_, i) => sample(1 + i, recorder)),
      ...Array.from({ length: 2 }, (_, i) => sample(10 + i, drawing)),
    ];
    const text = renderFunctionCallersIos(samples, "main", 15);
    expect(text).toContain("In the 2 samples with only system code below the function");
    expect(text).toContain("| `-[NSApplication run]` > `CA::Layer::display()` | 2 | 100.0% |");
  });

  it("is the root of a stack of system frames, also unsymbolicated ones", () => {
    const stack: StackFrame[] = [
      { name: "0x1e643d281", isSystemLibrary: true, library: "libdispatch.dylib" },
      sys("_pthread_wqthread", "libsystem_pthread.dylib"),
      sys("start_wqthread", "libsystem_pthread.dylib"),
    ];
    expect(findDominantFunction(stack)).toBe("start_wqthread");
    const [hotspot] = aggregateCpuHotspots([sample(1, stack)]);
    expect(hotspot!.systemCode).toEqual({
      frameworks: [{ name: "libsystem_pthread.dylib", weightPercentage: 100 }],
    });
  });

  it("is not system code when no frame has a symbol", () => {
    const stack: StackFrame[] = [
      { name: "0x1e643d281", isSystemLibrary: true, library: "libdispatch.dylib" },
      { name: "0x1e642f2ff", isSystemLibrary: false },
    ];
    const [hotspot] = aggregateCpuHotspots([sample(1, stack)]);
    expect(hotspot!.dominantFunction).toBe("0x1e643d281");
    expect(hotspot).not.toHaveProperty("systemCode");
  });

  it("keeps a stack with an unsymbolicated frame of the app as the app's", () => {
    const stack: StackFrame[] = [
      { name: "0x104a2c3f0", isSystemLibrary: false, library: "Example" },
      sys("_pthread_wqthread", "libsystem_pthread.dylib"),
      sys("start_wqthread", "libsystem_pthread.dylib"),
    ];
    expect(findDominantFunction(stack)).toBe("_pthread_wqthread");
    const [hotspot] = aggregateCpuHotspots([sample(1, stack)]);
    expect(hotspot).not.toHaveProperty("systemCode");
  });

  it("labels a hang suspect with no app frame as system code", () => {
    const { uiHangs } = correlateHangsWithCpu(
      [{ startNs: 0, durationNs: 10_000_000, hangType: "Hang", threadFmt: "Main" }],
      [sample(1, [sys("mach_msg2_trap", "libsystem_kernel.dylib"), sys("start", "dyld")])]
    );
    expect(uiHangs[0]!.suspectedFunctions).toEqual(["start"]);
    expect(uiHangs[0]!.toolingLabels).toEqual({
      start: "system code, with no function of the app in its stacks",
    });
  });

  it("labels no suspect of a hang whose entry point is the leaf", () => {
    const { uiHangs } = correlateHangsWithCpu(
      [{ startNs: 0, durationNs: 10_000_000, hangType: "Hang", threadFmt: "Main" }],
      [sample(1, [appFrame("main"), sys("start", "dyld")])]
    );
    expect(uiHangs[0]!.suspectedFunctions).toEqual(["main"]);
    expect(uiHangs[0]).not.toHaveProperty("toolingLabels");
  });
});
