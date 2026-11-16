import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect } from "vitest";
import { parseCpuXml } from "../../src/utils/ios-profiler/pipeline/xml-parser";

function makeXml(frameName: string): string {
  return `<row>
  <sample-time>1000</sample-time>
  <thread fmt="main"></thread>
  <weight>1000000</weight>
  <backtrace id="1">
    <frame id="1" name="${frameName}"/>
  </backtrace>
</row>`;
}

function getFirstFrameName(xml: string): string {
  const samples = parseCpuXml(xml);
  return samples[0]?.stack[0]?.name ?? "";
}

describe("decodeXml (via parseCpuXml)", () => {
  it("double-encoded entity decodes only once — &amp;lt; becomes &lt;, not <", () => {
    const result = getFirstFrameName(makeXml("&amp;lt;tag&amp;gt;"));
    expect(result).toBe("&lt;tag&gt;");
  });

  it("decodes &lt; and &gt; to angle brackets", () => {
    const result = getFirstFrameName(makeXml("&lt;func&gt;"));
    expect(result).toBe("<func>");
  });

  it("decodes &amp; to &", () => {
    const result = getFirstFrameName(makeXml("&amp;"));
    expect(result).toBe("&");
  });

  it("decodes &quot; to double quote", () => {
    const result = getFirstFrameName(makeXml("&quot;hello&quot;"));
    expect(result).toBe('"hello"');
  });

  it("decodes &apos; to single quote", () => {
    const result = getFirstFrameName(makeXml("&apos;x&apos;"));
    expect(result).toBe("'x'");
  });
});

function row(sampleTime: string, stack: string): string {
  return `<row>${sampleTime}<thread fmt="main"></thread><weight>1000000</weight>${stack}</row>`;
}

function stackNames(xml: string): string[][] {
  return parseCpuXml(xml).map((s) => s.stack.map((f) => f.name));
}

describe("stack shapes", () => {
  it("reads a <backtrace> and a later <backtrace ref>", () => {
    const xml = [
      row(
        "<sample-time>1</sample-time>",
        '<backtrace id="10"><frame id="11" name="leaf"/><frame id="12" name="root"/></backtrace>'
      ),
      row("<sample-time>2</sample-time>", '<backtrace ref="10"/>'),
    ].join("");
    expect(stackNames(xml)).toEqual([
      ["leaf", "root"],
      ["leaf", "root"],
    ]);
  });

  it("reads a <backtrace> nested in a <tagged-backtrace> and a later <tagged-backtrace ref> (Xcode 26)", () => {
    const xml = [
      row(
        "<sample-time>1</sample-time>",
        '<tagged-backtrace id="10" fmt="leaf ← (1 other frames)"><backtrace id="11">' +
          '<frame id="12" name="leaf"/><frame id="13" name="root"/></backtrace>' +
          '<uint64 id="14" fmt="0x0">0</uint64></tagged-backtrace>'
      ),
      row("<sample-time>2</sample-time>", '<tagged-backtrace ref="10"/>'),
    ].join("");
    expect(stackNames(xml)).toEqual([
      ["leaf", "root"],
      ["leaf", "root"],
    ]);
  });

  it("reads frames inside a <tagged-backtrace> and a later <tagged-backtrace ref> (Xcode 27)", () => {
    const xml = [
      row(
        "<sample-time>1</sample-time>",
        '<tagged-backtrace id="10" truncated="YES"><frame id="11" name="leaf"/>' +
          '<frame id="12" name="root"/></tagged-backtrace>'
      ),
      row(
        "<sample-time>2</sample-time>",
        '<tagged-backtrace id="13"><frame id="14" name="other"/><frame ref="12"/></tagged-backtrace>'
      ),
      row("<sample-time>3</sample-time>", '<tagged-backtrace ref="10"/>'),
      row("<sample-time>4</sample-time>", "<sentinel/>"),
    ].join("");
    expect(stackNames(xml)).toEqual([["leaf", "root"], ["other", "root"], ["leaf", "root"], []]);
  });

  it("resolves a ref to a stack defined in a row skipped for its <sample-time ref>", () => {
    const xml = [
      row('<sample-time id="1">1</sample-time>', "<sentinel/>"),
      row(
        '<sample-time ref="1"/>',
        '<tagged-backtrace id="10"><frame id="11" name="leaf"/></tagged-backtrace>'
      ),
      row(
        "<sample-time>2</sample-time>",
        '<tagged-backtrace id="12"><frame ref="11"/><frame id="13" name="root"/></tagged-backtrace>'
      ),
      row("<sample-time>3</sample-time>", '<tagged-backtrace ref="10"/>'),
    ].join("");
    expect(stackNames(xml)).toEqual([[], ["leaf", "root"], ["leaf"]]);
  });
});

// Trimmed from real exports of a simulator app recorded with argent: its worker
// thread runs cpuProbeHashLoop(_:) and its main thread cpuProbeCountPrimes(_:).
describe("real xctrace time-profile exports", () => {
  const APP_PID = 92556;
  const load = (xcode: string) =>
    readFileSync(
      join(__dirname, "..", "fixtures", "xctrace", `time-profile-xcode-${xcode}.xml`),
      "utf8"
    );
  const appStacks = (xml: string) =>
    parseCpuXml(xml, APP_PID).map((s) => ({
      thread: s.threadFmt.split(" ")[0],
      stack: s.stack.map((f) => f.name),
    }));

  it("Xcode 27.2: every app sample has its stack", () => {
    const samples = appStacks(load("27.2"));
    expect(samples.map((s) => [s.thread, s.stack.length])).toEqual([
      ["CpuProbeWorker", 9],
      ["Main", 15],
      ["Main", 15],
      ["CpuProbeWorker", 9],
    ]);
    expect(samples[0]!.stack).toContain("cpuProbeHashLoop(_:)");
    expect(samples[1]!.stack[0]).toBe("cpuProbeCountPrimes(_:)");
    expect(samples[2]!.stack).toEqual(samples[1]!.stack);
    expect(samples[3]!.stack).toEqual(samples[0]!.stack);
  });

  it("Xcode 26.6: every app sample has its stack, including ones defined in a skipped row", () => {
    const samples = appStacks(load("26.6"));
    expect(samples.map((s) => [s.thread, s.stack.length])).toEqual([
      ["CpuProbeWorker", 9],
      ["Main", 15],
      ["CpuProbeWorker", 9],
      ["Main", 15],
      ["CpuProbeWorker", 9],
    ]);
    expect(samples[0]!.stack).toContain("cpuProbeHashLoop(_:)");
    expect(samples[1]!.stack[0]).toBe("cpuProbeCountPrimes(_:)");
    expect(samples[2]!.stack).toEqual(samples[0]!.stack);
    expect(samples[3]!.stack).toEqual(samples[1]!.stack);
    expect(samples[4]!.stack[0]).toBe("DYLD-STUB$$_platform_bzero");
    expect(samples[4]!.stack).toContain("cpuProbeHashLoop(_:)");
  });
});

describe("system libraries of a simulator runtime", () => {
  // Paths as an all-processes trace of iOS 27.0 and iOS 26.5 simulators gave them (Xcode 26.6).
  // macOS mounts the iOS 27 runtime under cryptexd, so its paths start with /private/var/run.
  const IOS_27_UIKIT =
    "/private/var/run/com.apple.security.cryptexd/mnt/iOS_24A434/Library/Developer/CoreSimulator/" +
    "Profiles/Runtimes/iOS 27.0.simruntime/Contents/Resources/RuntimeRoot/System/Library/" +
    "PrivateFrameworks/UIKitCore.framework/UIKitCore";
  const IOS_27_DISPATCH =
    "/private/var/run/com.apple.security.cryptexd/mnt/iOS_24A434/Library/Developer/CoreSimulator/" +
    "Profiles/Runtimes/iOS 27.0.simruntime/Contents/Resources/RuntimeRoot/usr/lib/system/libdispatch.dylib";
  const IOS_26_FOUNDATION =
    "/Library/Developer/CoreSimulator/Volumes/iOS_23F77/Library/Developer/CoreSimulator/Profiles/" +
    "Runtimes/iOS 26.5.simruntime/Contents/Resources/RuntimeRoot/System/Library/Frameworks/" +
    "Foundation.framework/Foundation";
  const APP =
    "/Users/me/Library/Developer/CoreSimulator/Devices/56AC385B-AF1F-467E-BB5D-972CEB9C9899/data/" +
    "Containers/Bundle/Application/DEBDAC26-75F6-4D5F-83D8-C5EF54F326BA/ProfProbe.app/ProfProbe";

  function frame(id: number, name: string, binaryId: number, path: string): string {
    const binary = path.split("/").pop();
    return `<frame id="${id}" name="${name}" addr="0x${id}"><binary id="${binaryId}" name="${binary}" path="${path}"/></frame>`;
  }

  it("marks the frames of the iOS 27 and iOS 26.5 runtimes as system, not the app's", () => {
    const xml = row(
      "<sample-time>1</sample-time>",
      `<backtrace id="1">` +
        frame(2, "-[UIView layoutSubviews]", 3, IOS_27_UIKIT) +
        frame(4, "_dispatch_main_queue_drain", 5, IOS_27_DISPATCH) +
        frame(6, "-[NSRunLoop runMode:beforeDate:]", 7, IOS_26_FOUNDATION) +
        frame(8, "closure #1 in ProbeViewController.watchCommandFile()", 9, APP) +
        `</backtrace>`
    );
    expect(parseCpuXml(xml)[0]!.stack.map((f) => [f.name, f.isSystemLibrary])).toEqual([
      ["-[UIView layoutSubviews]", true],
      ["_dispatch_main_queue_drain", true],
      ["-[NSRunLoop runMode:beforeDate:]", true],
      ["closure #1 in ProbeViewController.watchCommandFile()", false],
    ]);
  });
});
