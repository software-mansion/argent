import { describe, expect, it } from "vitest";
import {
  cpuTableXpath,
  earliestDyldStartNs,
  launchEndNs,
  parseFirstFrameSignpostNs,
  parseLifecyclePhases,
  truncateCpuXml,
} from "../../src/utils/ios-launch-time/trace-exports";
import { parseCpuXml } from "../../src/utils/ios-profiler/pipeline/xml-parser";

// Shape of a real App Launch `life-cycle-period` export: later rows reference
// earlier values, and each narrative repeats the duration as a ref.
const LIFECYCLE = `<?xml version="1.0"?>
<trace-query-result>
<node><schema name="life-cycle-period"/>
<row><start-time id="1" fmt="00:00.100.000">100000000</start-time><duration id="2" fmt="50.00 ms">50000000</duration><app-period id="3" fmt="Initializing - Static Runtime Initialization">Initializing - Static Runtime Initialization</app-period><narrative id="4"><duration ref="2"/></narrative></row>
<row><start-time id="5" fmt="00:00.300.000">300000000</start-time><duration id="6" fmt="5.00 ms">5000000</duration><app-period id="7" fmt="Launching - Initial Frame Rendering">Launching - Initial Frame Rendering</app-period><narrative id="8"><app-period id="9" fmt="Launching">Launching</app-period></narrative></row>
<row><start-time id="10" fmt="00:00.150.000">150000000</start-time><duration ref="2"/><app-period id="11" fmt="Launching - didFinishLaunchingWithOptions()">Launching - didFinishLaunchingWithOptions()</app-period></row>
<row><start-time id="12" fmt="00:00.310.000">310000000</start-time><duration id="13" fmt="1.00 s">1000000000</duration><app-period id="14" fmt="Foreground - Active">Foreground - Active</app-period></row>
</node></trace-query-result>`;

describe("parseLifecyclePhases", () => {
  it("resolves refs, reads the column value before the narrative, and sorts by start", () => {
    expect(parseLifecyclePhases(LIFECYCLE)).toEqual([
      {
        startNs: 100_000_000,
        durationNs: 50_000_000,
        period: "Initializing - Static Runtime Initialization",
      },
      {
        startNs: 150_000_000,
        durationNs: 50_000_000,
        period: "Launching - didFinishLaunchingWithOptions()",
      },
      {
        startNs: 300_000_000,
        durationNs: 5_000_000,
        period: "Launching - Initial Frame Rendering",
      },
      { startNs: 310_000_000, durationNs: 1_000_000_000, period: "Foreground - Active" },
    ]);
  });
});

describe("launchEndNs", () => {
  it("ends launch at the end of initial frame rendering", () => {
    expect(launchEndNs(parseLifecyclePhases(LIFECYCLE))).toBe(305_000_000);
  });

  it("falls back to the Foreground - Active start", () => {
    const phases = parseLifecyclePhases(LIFECYCLE).filter(
      (phase) => phase.period !== "Launching - Initial Frame Rendering"
    );
    expect(launchEndNs(phases)).toBe(310_000_000);
  });

  it("returns null without either phase", () => {
    expect(launchEndNs([])).toBeNull();
  });
});

const CPU = `<?xml version="1.0"?>
<trace-query-result>
<node><schema name="time-profile"/>
<row><sample-time id="1">100000000</sample-time><thread id="2" fmt="Main Thread"/><weight id="3">1000000</weight><tagged-backtrace id="4"><frame id="5" name="AppDelegate.setUp()"/><frame id="6" name="main"/></tagged-backtrace></row>
<row><sample-time id="7">200000000</sample-time><thread ref="2"/><weight ref="3"/><tagged-backtrace ref="4"/></row>
<row><sample-time id="8">400000000</sample-time><thread ref="2"/><weight ref="3"/><tagged-backtrace id="9"><frame id="10" name="AfterFirstFrame()"/><frame ref="6"/></tagged-backtrace></row>
</node></trace-query-result>`;

describe("truncateCpuXml", () => {
  it("keeps rows up to the launch end as XML the CPU parser still reads", () => {
    const { xml, keptRows, laterRows } = truncateCpuXml(CPU, 305_000_000);
    expect(keptRows).toBe(2);
    expect(laterRows).toBe(0);
    expect(xml).not.toContain("AfterFirstFrame");
    expect(xml.endsWith("</node></trace-query-result>")).toBe(true);
    const samples = parseCpuXml(xml);
    expect(samples.map((s) => s.stack.map((f) => f.name))).toEqual([
      ["AppDelegate.setUp()", "main"],
      ["AppDelegate.setUp()", "main"],
    ]);
  });

  it("returns the input unchanged when every row is inside the window", () => {
    expect(truncateCpuXml(CPU, 500_000_000)).toEqual({ xml: CPU, keptRows: 3, laterRows: 0 });
  });

  it("drops no launch sample when rows are out of time order", () => {
    // A late in-window row after a post-launch row: cutting at the first
    // post-launch row would lose it, so the cut moves past it instead.
    const unsorted = CPU.replace(
      "</node>",
      `<row><sample-time id="11">250000000</sample-time><thread ref="2"/><weight ref="3"/><tagged-backtrace ref="4"/></row>\n` +
        `<row><sample-time id="12">500000000</sample-time><thread ref="2"/><weight ref="3"/><tagged-backtrace ref="9"/></row>\n</node>`
    );
    const { xml, keptRows, laterRows } = truncateCpuXml(unsorted, 305_000_000);
    expect(keptRows).toBe(3);
    expect(laterRows).toBe(1);
    expect(parseCpuXml(xml).map((s) => s.timestampNs)).toEqual([
      100_000_000, 200_000_000, 400_000_000, 250_000_000,
    ]);
  });

  it("keeps no rows when every sample is after the launch", () => {
    const { xml, keptRows } = truncateCpuXml(CPU, 50_000_000);
    expect(keptRows).toBe(0);
    expect(parseCpuXml(xml)).toEqual([]);
  });
});

describe("cpuTableXpath", () => {
  it("selects the running-only table when the TOC marks it", () => {
    const toc =
      '<table target-pid="SINGLE" schema="time-profile" record-waiting-threads="0"/>' +
      '<table target-pid="SINGLE" schema="time-profile" record-waiting-threads="1"/>';
    expect(cpuTableXpath(toc)).toBe(
      '/trace-toc/run[@number="1"]/data/table[@schema="time-profile" and @record-waiting-threads="0"]'
    );
  });

  it("falls back to the first time-profile table without the attribute", () => {
    expect(cpuTableXpath('<table schema="time-profile" target-pid="SINGLE"/>')).toBe(
      '/trace-toc/run[@number="1"]/data/table[@schema="time-profile"][1]'
    );
  });

  it("returns null without a time-profile table", () => {
    expect(cpuTableXpath('<table schema="time-sample"/>')).toBeNull();
  });
});

// Shape of a real simulator `os-signpost` export: the process cell is
// "<name> (<pid>)" with a nested pid, first defined inside the thread cell and
// then referenced; only End rows exist; there are sentinel cells.
const SIGNPOST = `<?xml version="1.0"?>
<trace-query-result>
<node><schema name="os-signpost"/>
<row><event-time id="1" fmt="00:00.100.000">100000000</event-time><thread id="2" fmt="Main Thread 0x1a2b (AppleSpell, pid: 123)"><tid id="3" fmt="0x1a2b">6699</tid><process id="4" fmt="AppleSpell (123)"><pid id="5" fmt="123">123</pid></process></thread><process ref="4"/><event-type id="6" fmt="End">End</event-type><sentinel/><subsystem id="7" fmt="com.apple.app_launch_measurement">com.apple.app_launch_measurement</subsystem><category id="8" fmt="ApplicationLaunch">ApplicationLaunch</category><signpost-name id="9" fmt="ApplicationFirstFramePresentation">ApplicationFirstFramePresentation</signpost-name><sentinel/></row>
<row><event-time id="10" fmt="00:00.350.000">350000000</event-time><thread id="11" fmt="Main Thread 0x3c4d (Ledger, pid: 14775)"><tid id="12" fmt="0x3c4d">7788</tid><process id="13" fmt="Ledger (14775)"><pid id="14" fmt="14775">14775</pid></process></thread><process ref="13"/><event-type ref="6"/><sentinel/><subsystem ref="7"/><category ref="8"/><signpost-name id="15" fmt="ApplicationFirstFramePresentationResponsive">ApplicationFirstFramePresentationResponsive</signpost-name><sentinel/></row>
<row><event-time id="16" fmt="00:00.400.000">400000000</event-time><thread ref="11"/><process ref="13"/><event-type ref="6"/><sentinel/><subsystem ref="7"/><category ref="8"/><signpost-name ref="9"/><sentinel/></row>
</node></trace-query-result>`;

describe("parseFirstFrameSignpostNs", () => {
  it("takes the first-frame End row of the launched process, resolving refs", () => {
    expect(parseFirstFrameSignpostNs(SIGNPOST, "Ledger")).toBe(400_000_000);
  });

  it("matches the process name, not a prefix of another process", () => {
    // "App" is a prefix of "AppleSpell (123)" but not that process's name.
    expect(parseFirstFrameSignpostNs(SIGNPOST, "App")).toBeNull();
    expect(parseFirstFrameSignpostNs(SIGNPOST, "AppleSpell")).toBe(100_000_000);
    expect(parseFirstFrameSignpostNs(SIGNPOST, "Ledg")).toBeNull();
  });

  it("escapes regex characters in the process name", () => {
    const dotted = SIGNPOST.replace(/Ledger \(14775\)/, "My.App (14775)");
    expect(parseFirstFrameSignpostNs(dotted, "My.App")).toBe(400_000_000);
    expect(parseFirstFrameSignpostNs(dotted, "My.Ap")).toBeNull();
    expect(
      parseFirstFrameSignpostNs(SIGNPOST.replace(/Ledger \(14775\)/, "MyXApp (14775)"), "My.App")
    ).toBeNull();
  });

  it("ignores the ApplicationFirstFramePresentationResponsive signpost", () => {
    // The Responsive row of Ledger (350 ms) is earlier than its first frame.
    expect(parseFirstFrameSignpostNs(SIGNPOST, "Ledger")).not.toBe(350_000_000);
    const responsiveOnly = SIGNPOST.replace(/<row><event-time id="16".*?<\/row>/s, "");
    expect(parseFirstFrameSignpostNs(responsiveOnly, "Ledger")).toBeNull();
  });

  it("takes the earliest matching row when no process is given", () => {
    expect(parseFirstFrameSignpostNs(SIGNPOST)).toBe(100_000_000);
  });

  it("keeps rows that have no process cell", () => {
    const noProcess = `<node><row><event-time id="1">250000000</event-time><event-type id="2" fmt="End">End</event-type><subsystem id="3">com.apple.app_launch_measurement</subsystem><signpost-name id="4">ApplicationFirstFramePresentation</signpost-name></row></node>`;
    expect(parseFirstFrameSignpostNs(noProcess, "Ledger")).toBe(250_000_000);
  });

  it("returns null without a matching End signpost", () => {
    expect(parseFirstFrameSignpostNs(SIGNPOST, "Missing")).toBeNull();
    expect(parseFirstFrameSignpostNs("<trace-query-result></trace-query-result>")).toBeNull();
  });
});

describe("earliestDyldStartNs", () => {
  it("returns the smallest start across rows, resolving refs", () => {
    const xml = `<node><row><start-time id="1">250000000</start-time></row><row><start-time id="2">120000000</start-time></row><row><start-time ref="1"/></row></node>`;
    expect(earliestDyldStartNs(xml)).toBe(120_000_000);
    expect(earliestDyldStartNs("<node/>")).toBeNull();
  });
});
