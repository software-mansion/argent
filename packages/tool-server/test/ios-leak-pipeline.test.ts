/**
 * iOS leak pipeline — parse + aggregate.
 *
 * Pins the *real* shape of an `xctrace export` of the `Leaks` track detail.
 * Unlike the CPU/hangs schema tables (`<row>…</row>` blocks with an id/ref
 * dedup scheme), the Leaks detail exports **self-closing attribute rows**:
 *
 *   <row leaked-object="…" size="…" responsible-frame="…" count="…"
 *        responsible-library="…" address="…"/>
 *
 * The fixture below is a trimmed real capture (xctrace 16, Argent template,
 * `--attach`) plus one synthetic *attributed* row so the parser's XML-decode
 * (`&lt;…&gt;`), grouping, size summing, sort order, and severity are all
 * covered. This is the regression guard that would have caught any attempt to
 * "normalise" the leak parser onto the schema-table format (which would parse
 * zero rows).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, promises as fsPromises } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseLeaksXml } from "../src/utils/ios-profiler/pipeline/xml-parser";
import { aggregateLeaks, isLeakAttributed } from "../src/utils/ios-profiler/pipeline/01-correlate";
import { runIosProfilerPipeline } from "../src/utils/ios-profiler/pipeline/index";

const REAL_LEAKS_XML = `<?xml version="1.0"?>
<trace-query-result>
<node xpath='//trace-toc[1]/run[1]/tracks[1]/track[2]/details[1]/detail[1]'><row leaked-object="dispatch_mach_msg_t" size="512" responsible-frame="&lt;Call stack limit reached&gt;" count="1" responsible-library="" address="0x10150cd60"/>
<row leaked-object="dispatch_mach_msg_t" size="512" responsible-frame="&lt;Call stack limit reached&gt;" count="1" responsible-library="" address="0x10150cd90"/>
<row leaked-object="Malloc 16 Bytes" size="16" responsible-frame="&lt;Call stack limit reached&gt;" count="1" responsible-library="" address="0x600000010f50"/>
<row leaked-object="Malloc 16 Bytes" size="16" responsible-frame="&lt;Call stack limit reached&gt;" count="1" responsible-library="" address="0x600000010f70"/>
<row leaked-object="Malloc 16 Bytes" size="16" responsible-frame="&lt;Call stack limit reached&gt;" count="1" responsible-library="" address="0x600000010f80"/>
<row leaked-object="MyModel" size="128" responsible-frame="-[MyViewController loadData]" count="3" responsible-library="MyApp" address="0x600000abc000"/>
</node></trace-query-result>`;

describe("parseLeaksXml", () => {
  it("parses the self-closing attribute rows xctrace emits for the Leaks detail", () => {
    const rows = parseLeaksXml(REAL_LEAKS_XML);
    expect(rows).toHaveLength(6);

    // First row, fields read straight off the row attributes.
    expect(rows[0]).toEqual({
      objectType: "dispatch_mach_msg_t",
      sizeBytes: 512,
      responsibleFrame: "<Call stack limit reached>", // XML-decoded from &lt;…&gt;
      responsibleLibrary: "",
      count: 1,
    });

    // Attributed row keeps its real frame + library.
    const attributed = rows.find((r) => r.objectType === "MyModel");
    expect(attributed).toEqual({
      objectType: "MyModel",
      sizeBytes: 128,
      responsibleFrame: "-[MyViewController loadData]",
      responsibleLibrary: "MyApp",
      count: 3,
    });
  });

  it("returns [] for empty / non-leak XML rather than throwing", () => {
    expect(parseLeaksXml("")).toEqual([]);
    expect(parseLeaksXml("<trace-query-result></trace-query-result>")).toEqual([]);
  });
});

describe("aggregateLeaks", () => {
  it("groups by type, marks attributed RED + unattributed YELLOW, sorts attributed first", () => {
    const leaks = aggregateLeaks(parseLeaksXml(REAL_LEAKS_XML));

    // The attributed leak sorts ahead of the (larger) unattributed ones; within
    // each attribution bucket, by total size desc.
    expect(leaks.map((l) => l.objectType)).toEqual([
      "MyModel", //             attributed,   3 × 128 = 384
      "dispatch_mach_msg_t", // unattributed, 2 × 512 = 1024
      "Malloc 16 Bytes", //     unattributed, 3 × 16  = 48
    ]);

    const myModel = leaks[0];
    expect(myModel.type).toBe("memory_leak");
    expect(myModel.platform).toBe("ios");
    expect(myModel.count).toBe(3);
    expect(myModel.totalSizeBytes).toBe(384);
    expect(myModel.responsibleFrame).toBe("-[MyViewController loadData]");
    expect(myModel.responsibleLibrary).toBe("MyApp");
    expect(myModel.attributed).toBe(true);
    expect(myModel.severity).toBe("RED");

    const dispatch = leaks[1];
    expect(dispatch.count).toBe(2);
    expect(dispatch.totalSizeBytes).toBe(1024);
    expect(dispatch.attributed).toBe(false);
    expect(dispatch.severity).toBe("YELLOW");

    // Every `<Call stack limit reached>` leak is demoted — never a confident RED.
    const unattributed = leaks.filter((l) => !l.attributed);
    expect(unattributed).toHaveLength(2);
    expect(unattributed.every((l) => l.severity === "YELLOW")).toBe(true);
  });

  it("keeps distinct responsible frames as separate rows (same type, different call sites)", () => {
    // Attribution is the feature's whole point: the same object type leaked from
    // two different call sites must NOT collapse into one row attributed to
    // whichever was parsed first (that hides the second site). Group by
    // (type, frame).
    const rows = aggregateLeaks([
      {
        objectType: "Malloc 48 Bytes",
        sizeBytes: 48,
        responsibleFrame: "-[SiteA make]",
        responsibleLibrary: "App",
        count: 3,
      },
      {
        objectType: "Malloc 48 Bytes",
        sizeBytes: 48,
        responsibleFrame: "-[SiteB make]",
        responsibleLibrary: "App",
        count: 2,
      },
    ]);
    expect(rows).toHaveLength(2);
    const bySite = new Map(rows.map((r) => [r.responsibleFrame, r]));
    expect(bySite.get("-[SiteA make]")?.count).toBe(3);
    expect(bySite.get("-[SiteB make]")?.count).toBe(2);
  });

  it("still merges same type + same frame (unattributed sentinel case unaffected)", () => {
    const rows = aggregateLeaks([
      {
        objectType: "Malloc 16 Bytes",
        sizeBytes: 16,
        responsibleFrame: "<Call stack limit reached>",
        responsibleLibrary: "",
        count: 2,
      },
      {
        objectType: "Malloc 16 Bytes",
        sizeBytes: 16,
        responsibleFrame: "<Call stack limit reached>",
        responsibleLibrary: "",
        count: 1,
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(3);
    expect(rows[0]?.attributed).toBe(false);
  });

  it("does not collide distinct (type, frame) pairs that share a space-joined key", () => {
    // The group key joins objectType and responsibleFrame with a NUL delimiter
    // precisely so it can't collide. These two leaks are distinct sites, but a
    // space (or any character that can appear in the fields) as the delimiter
    // would map both to the same key "Malloc 48 Bytes make" and silently merge
    // them — hiding a real leak. Pin the collision-safety so nobody "simplifies"
    // the delimiter back to a printable character.
    const rows = aggregateLeaks([
      {
        objectType: "Malloc 48",
        sizeBytes: 48,
        responsibleFrame: "Bytes make",
        responsibleLibrary: "App",
        count: 1,
      },
      {
        objectType: "Malloc 48 Bytes",
        sizeBytes: 48,
        responsibleFrame: "make",
        responsibleLibrary: "App",
        count: 1,
      },
    ]);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.objectType))).toEqual(
      new Set(["Malloc 48", "Malloc 48 Bytes"])
    );
  });

  it("merges every unattributed frame spelling of one object type into one group", () => {
    // The exporter is not consistent about how "no stack" is spelled: a missing
    // responsible-frame attribute parses as "Unknown" (xml-parser default) while
    // recorded-but-truncated stacks emit the "<Call stack limit reached>"
    // sentinel, and isLeakAttributed() trims before matching. All of those are
    // one attribution state, so they must be one group — keying on the verbatim
    // frame would split them and inflate the "N unattributed leak group(s)"
    // count in the report.
    const rows = aggregateLeaks([
      {
        objectType: "Malloc 48 Bytes",
        sizeBytes: 48,
        responsibleFrame: "<Call stack limit reached>",
        responsibleLibrary: "",
        count: 2,
      },
      {
        objectType: "Malloc 48 Bytes",
        sizeBytes: 48,
        responsibleFrame: "Unknown",
        responsibleLibrary: "",
        count: 1,
      },
      {
        objectType: "Malloc 48 Bytes",
        sizeBytes: 48,
        responsibleFrame: " <Call stack limit reached> ",
        responsibleLibrary: "",
        count: 1,
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(4);
    expect(rows[0]?.totalSizeBytes).toBe(192);
    expect(rows[0]?.attributed).toBe(false);
  });

  it("merges attributed frames that differ only by surrounding whitespace", () => {
    const rows = aggregateLeaks([
      {
        objectType: "MyModel",
        sizeBytes: 128,
        responsibleFrame: "-[SiteA make]",
        responsibleLibrary: "App",
        count: 1,
      },
      {
        objectType: "MyModel",
        sizeBytes: 128,
        responsibleFrame: "-[SiteA make] ",
        responsibleLibrary: "App",
        count: 1,
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(2);
    expect(rows[0]?.attributed).toBe(true);
  });

  it("returns [] for no leaks", () => {
    expect(aggregateLeaks([])).toEqual([]);
  });
});

describe("isLeakAttributed", () => {
  it("treats xctrace's no-stack sentinels (and empty/Unknown) as unattributed", () => {
    expect(isLeakAttributed("<Call stack limit reached>")).toBe(false);
    expect(isLeakAttributed("")).toBe(false);
    expect(isLeakAttributed("Unknown")).toBe(false);
  });

  it("treats the (null) frame of a template without the Allocations instrument as unattributed", () => {
    expect(isLeakAttributed("(null)")).toBe(false);
  });

  it("treats a real responsible frame as attributed", () => {
    expect(isLeakAttributed("-[MyViewController loadData]")).toBe(true);
    expect(isLeakAttributed("MyApp`closure #1")).toBe(true);
  });
});

describe("leaks of a template without the Allocations instrument", () => {
  // Rows of a real Leaks export: the Mac fixture app recorded with `Time Profiler` plus
  // `--instrument Leaks` (Xcode 27.2), after it made 200 retain cycles of
  // ProfLeakNodeA <-> ProfLeakNodeB. Each of the 817 rows had this frame and library.
  const LEAKS_XML = `<?xml version="1.0"?>
<trace-query-result>
<node xpath='//trace-toc[1]/run[1]/tracks[1]/track[1]/details[1]/detail[1]'><row leaked-object="Malloc 32 Bytes" size="32" responsible-frame="(null)" count="1" responsible-library="(null)" address="0x7212404060"/>
<row leaked-object="ProfLeakNodeA" size="32" responsible-frame="(null)" count="1" responsible-library="(null)" address="0x769e518000"/>
<row leaked-object="ProfLeakNodeB" size="32" responsible-frame="(null)" count="1" responsible-library="(null)" address="0x769f02c040"/>
<row leaked-object="NSSet" size="80" responsible-frame="(null)" count="1" responsible-library="(null)" address="0x769e43c140"/>
<row leaked-object="xpc_connection_t" size="320" responsible-frame="(null)" count="1" responsible-library="(null)" address="0x769e819040"/>
</node></trace-query-result>`;

  it("rates every leak as an unattributed YELLOW, not as a leak of the app", () => {
    const leaks = aggregateLeaks(parseLeaksXml(LEAKS_XML));
    expect(leaks).toHaveLength(5);
    for (const leak of leaks) {
      expect(leak.attributed).toBe(false);
      expect(leak.severity).toBe("YELLOW");
    }
  });
});

describe("leaks of system libraries", () => {
  // Rows of a real Leaks export: the Mac fixture app with malloc stack logging, after it
  // made 200 retain cycles of ProfLeakNodeA <-> ProfLeakNodeB (Xcode 27.2, macOS 27).
  // macOS leaks the XPC objects by itself, before any action of the app.
  const LEAKS_XML = `<?xml version="1.0"?>
<trace-query-result>
<node xpath='//trace-toc[1]/run[1]/tracks[1]/track[2]/details[1]/detail[1]'><row leaked-object="Malloc 80 Bytes" size="80" responsible-frame="-[LNProcessInstanceRegistryClient makeXPCConnection]" count="1" responsible-library="AppIntents" address="0x7308810230"/>
<row leaked-object="Malloc 48 Bytes" size="48" responsible-frame="-[NSXPCConnection initWithMachServiceName:options:]" count="1" responsible-library="Foundation" address="0x7308818360"/>
<row leaked-object="ProfLeakNodeA" size="48" responsible-frame="swift::swift_slowAllocTyped(unsigned long, unsigned long, unsigned long long)" count="1" responsible-library="libswiftCore.dylib" address="0x7a8a95aeb0"/>
<row leaked-object="ProfLeakNodeB" size="48" responsible-frame="swift::swift_slowAllocTyped(unsigned long, unsigned long, unsigned long long)" count="1" responsible-library="libswiftCore.dylib" address="0x7a8b1f41e0"/>
<row leaked-object="NSSet" size="96" responsible-frame="LNDaemonApplicationXPCInterface" count="1" responsible-library="LinkServices" address="0x7a8b0287e0"/>
<row leaked-object="MyModel" size="128" responsible-frame="-[MyViewController loadData]" count="1" responsible-library="PM-leaks-dbg" address="0x7a8b0287f0"/>
<row leaked-object="Malloc 32 Bytes" size="32" responsible-frame="&lt;Call stack limit reached&gt;" count="1" responsible-library="" address="0x7a8b028800"/>
</node></trace-query-result>`;

  // The binaries of the CPU export of the same trace: AppIntents and LinkServices are not in it.
  const LIBRARY_PATHS = new Map([
    ["Foundation", "/System/Library/Frameworks/Foundation.framework/Versions/C/Foundation"],
    ["libswiftCore.dylib", "/usr/lib/swift/libswiftCore.dylib"],
    ["PM-leaks-dbg", "/Users/me/apps/PM-leaks-dbg.app/Contents/MacOS/PM-leaks-dbg"],
  ]);

  function bySeverity(leaks: ReturnType<typeof aggregateLeaks>) {
    return leaks.map((l) => [
      l.objectType,
      l.responsibleLibrary,
      l.severity,
      l.systemLibrary ?? false,
    ]);
  }

  it("keeps the app's leaks RED and rates a leak from a system library YELLOW, after them", () => {
    const leaks = aggregateLeaks(parseLeaksXml(LEAKS_XML), LIBRARY_PATHS);
    // RED by size first, then the system libraries' leaks, then the unattributed ones.
    expect(bySeverity(leaks)).toEqual([
      ["MyModel", "PM-leaks-dbg", "RED", false],
      // Not in the paths, so not known as a system library.
      ["NSSet", "LinkServices", "RED", false],
      ["Malloc 80 Bytes", "AppIntents", "RED", false],
      // The Swift runtime's allocator stands for whoever made the object: the app here.
      ["ProfLeakNodeA", "libswiftCore.dylib", "RED", false],
      ["ProfLeakNodeB", "libswiftCore.dylib", "RED", false],
      ["Malloc 48 Bytes", "Foundation", "YELLOW", true],
      ["Malloc 32 Bytes", "", "YELLOW", false],
    ]);
  });

  it("keeps every attributed leak RED without the binaries' paths", () => {
    const leaks = aggregateLeaks(parseLeaksXml(LEAKS_XML));
    expect(leaks.filter((l) => l.attributed).every((l) => l.severity === "RED")).toBe(true);
    expect(leaks.some((l) => l.systemLibrary)).toBe(false);
  });
});

describe("the pipeline's leak libraries", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "argent-leak-libraries-"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds the paths in the CPU export, and an OS framework that the trace did not sample", async () => {
    const cpu = join(dir, "cpu.xml");
    const leaks = join(dir, "leaks.xml");
    writeFileSync(
      cpu,
      `<trace-query-result><node><row><sample-time>1</sample-time><thread fmt="Main Thread"></thread>` +
        `<weight>1000000</weight><backtrace id="1">` +
        `<frame id="2" name="-[NSRunLoop runMode:beforeDate:]" addr="0x2"><binary id="3" name="Foundation" path="/System/Library/Frameworks/Foundation.framework/Versions/C/Foundation"/></frame>` +
        `<frame id="4" name="main" addr="0x4"><binary id="5" name="PM-leaks-dbg" path="/Users/me/apps/PM-leaks-dbg.app/Contents/MacOS/PM-leaks-dbg"/></frame>` +
        `</backtrace></row></node></trace-query-result>`
    );
    writeFileSync(
      leaks,
      `<trace-query-result><node>` +
        `<row leaked-object="NSSet" size="96" responsible-frame="LNDaemonApplicationXPCInterface" count="1" responsible-library="LinkServices" address="0x1"/>` +
        `<row leaked-object="Malloc 48 Bytes" size="48" responsible-frame="-[NSXPCConnection initWithMachServiceName:options:]" count="1" responsible-library="Foundation" address="0x2"/>` +
        `<row leaked-object="MyModel" size="128" responsible-frame="-[MyViewController loadData]" count="1" responsible-library="PM-leaks-dbg" address="0x3"/>` +
        `<row leaked-object="Other" size="16" responsible-frame="-[Other make]" count="1" responsible-library="SomeAppKit" address="0x4"/>` +
        `</node></trace-query-result>`
    );
    // Only LinkServices is an OS framework on this "Mac", whatever runs the test.
    const access = vi.spyOn(fsPromises, "access").mockImplementation(async (p) => {
      if (String(p) === "/System/Library/PrivateFrameworks/LinkServices.framework") return;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const { memoryLeaks } = await runIosProfilerPipeline({ cpu, hangs: null, leaks });

    expect(memoryLeaks.map((l) => [l.objectType, l.severity, l.systemLibrary ?? false])).toEqual([
      ["MyModel", "RED", false],
      ["Other", "RED", false],
      ["NSSet", "YELLOW", true],
      ["Malloc 48 Bytes", "YELLOW", true],
    ]);
    // Only the names that the CPU export lacks are looked for, in the app's bundle first.
    expect(access.mock.calls.map(([p]) => String(p))).toEqual([
      "/Users/me/apps/PM-leaks-dbg.app/Contents/Frameworks/LinkServices.framework",
      "/Users/me/apps/PM-leaks-dbg.app/Frameworks/LinkServices.framework",
      "/System/Library/Frameworks/LinkServices.framework",
      "/System/Library/PrivateFrameworks/LinkServices.framework",
      "/Users/me/apps/PM-leaks-dbg.app/Contents/Frameworks/SomeAppKit.framework",
      "/Users/me/apps/PM-leaks-dbg.app/Frameworks/SomeAppKit.framework",
      "/System/Library/Frameworks/SomeAppKit.framework",
      "/System/Library/PrivateFrameworks/SomeAppKit.framework",
    ]);
  });

  /** A CPU export with one sample, whose frames are in these binaries. */
  function cpuExport(binaries: Array<[name: string, path: string]>): string {
    const frames = binaries
      .map(
        ([name, binaryPath], i) =>
          `<frame id="${2 * i + 2}" name="f${i}" addr="0x${i}"><binary id="${2 * i + 3}" name="${name}" path="${binaryPath}"/></frame>`
      )
      .join("");
    return (
      `<trace-query-result><node><row><sample-time>1</sample-time><thread fmt="Main Thread"></thread>` +
      `<weight>1000000</weight><backtrace id="1">${frames}</backtrace></row></node></trace-query-result>`
    );
  }

  function leaksExport(libraries: string[]): string {
    const rows = libraries.map(
      (library, i) =>
        `<row leaked-object="${library}Object" size="16" responsible-frame="-[${library}Object make]" count="1" responsible-library="${library}" address="0x${i}"/>`
    );
    return `<trace-query-result><node>${rows.join("")}</node></trace-query-result>`;
  }

  /** Each of these frameworks is on this "Mac", whatever runs the test; other paths stay real. */
  function onThisMac(...names: string[]): void {
    const access = fsPromises.access.bind(fsPromises);
    vi.spyOn(fsPromises, "access").mockImplementation(async (p, mode) => {
      const path = String(p);
      if (!path.startsWith("/System/Library/")) return access(path, mode);
      if (names.some((name) => path.endsWith(`Frameworks/${name}.framework`))) return;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
  }

  async function severities(cpuXml: string, libraries: string[]) {
    const cpu = join(dir, "cpu.xml");
    const leaks = join(dir, "leaks.xml");
    writeFileSync(cpu, cpuXml);
    writeFileSync(leaks, leaksExport(libraries));
    const { memoryLeaks } = await runIosProfilerPipeline({ cpu, hangs: null, leaks });
    return Object.fromEntries(
      memoryLeaks.map((l) => [l.responsibleLibrary, l.systemLibrary ? "system" : l.severity])
    );
  }

  it("takes a framework in the bundle of a Mac app for the app's, also with the name of a macOS framework", async () => {
    // The app embeds Sentry.framework (sentry-cocoa); macOS has a private framework of that name.
    const app = join(dir, "Demo.app");
    mkdirSync(join(app, "Contents/Frameworks/Sentry.framework"), { recursive: true });
    onThisMac("Sentry", "LinkServices");

    const cpuXml = cpuExport([
      ["Foundation", "/System/Library/Frameworks/Foundation.framework/Versions/C/Foundation"],
      ["Demo", join(app, "Contents/MacOS/Demo")],
    ]);
    expect(await severities(cpuXml, ["Sentry", "LinkServices"])).toEqual({
      Sentry: "RED",
      LinkServices: "system",
    });
  });

  it("looks for the frameworks of an iOS app in its bundle and its simulator runtime, not on this Mac", async () => {
    const app = join(dir, "Devices/X/data/Containers/Bundle/Application/Y/Shop.app");
    const runtime = join(
      dir,
      "mnt/iOS_24A434/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 27.0.simruntime/Contents/Resources/RuntimeRoot"
    );
    // The app embeds a Charts.framework (danielgindi/Charts); the runtime has Swift Charts.
    mkdirSync(join(app, "Frameworks/Charts.framework"), { recursive: true });
    mkdirSync(join(runtime, "System/Library/Frameworks/Charts.framework"), { recursive: true });
    mkdirSync(join(runtime, "System/Library/PrivateFrameworks/LinkServices.framework"), {
      recursive: true,
    });
    // macOS has frameworks of all three names; iOS has no Sentry framework.
    onThisMac("Sentry", "Charts", "LinkServices");

    const cpuXml = cpuExport([
      ["Foundation", join(runtime, "System/Library/Frameworks/Foundation.framework/Foundation")],
      ["Shop", join(app, "Shop")],
    ]);
    expect(await severities(cpuXml, ["Shop", "Sentry", "Charts", "LinkServices"])).toEqual({
      Shop: "RED",
      Sentry: "RED",
      Charts: "RED",
      LinkServices: "system",
    });
  });

  it("does not look for an OS framework when the trace sampled no library of the OS", async () => {
    onThisMac("Sentry");
    const cpuXml = cpuExport([
      ["Shop", "/Users/me/Library/Developer/CoreSimulator/Devices/X/Shop.app/Shop"],
    ]);
    expect(await severities(cpuXml, ["Sentry"])).toEqual({ Sentry: "RED" });
  });

  it("looks on this Mac for the frameworks of a Mac app also with no CPU sample", async () => {
    // A template without Time Profiler, or a CPU export that failed: no binary path is known.
    onThisMac("Foundation");
    const leaks = join(dir, "leaks.xml");
    writeFileSync(leaks, leaksExport(["Foundation"]));
    const emptyCpu = join(dir, "cpu.xml");
    writeFileSync(emptyCpu, "");
    for (const cpu of [null, emptyCpu]) {
      const mac = await runIosProfilerPipeline({ cpu, hangs: null, leaks }, { macApp: true });
      expect(mac.memoryLeaks[0]).toMatchObject({ severity: "YELLOW", systemLibrary: true });
      // The frameworks of this Mac are not those of an iOS app.
      const ios = await runIosProfilerPipeline({ cpu, hangs: null, leaks });
      expect(ios.memoryLeaks[0]).toMatchObject({ severity: "RED", attributed: true });
      expect(ios.memoryLeaks[0]!.systemLibrary).toBeUndefined();
    }
  });
});
