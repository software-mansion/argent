import { describe, expect, it } from "vitest";
import { compactPhysicalTouchEvents } from "../src/blueprints/physical-ios-automation";
import { adaptWdaSourceToDescribeResult } from "../src/tools/describe/platforms/ios/ios-wda-ax-adapter";
import { formatDescribeTree } from "../src/tools/describe/format-tree";
import { physicalAllProcessesStrategy } from "../src/utils/ios-profiler/capture-strategy/physical-all-processes";

describe("physical iOS touch compaction", () => {
  it("collapses interpolated straight-line points and preserves total duration", () => {
    const compacted = compactPhysicalTouchEvents([
      { type: "Down", x: 0.2, y: 0.5, delayMs: 0 },
      { type: "Move", x: 0.4, y: 0.5, delayMs: 100 },
      { type: "Move", x: 0.6, y: 0.5, delayMs: 100 },
      { type: "Up", x: 0.8, y: 0.5, delayMs: 100 },
    ]);

    expect(compacted).toHaveLength(2);
    expect(compacted[1]).toMatchObject({ type: "Up", x: 0.8, delayMs: 300 });
  });

  it("retains vertices needed to represent a curved rotation path", () => {
    const compacted = compactPhysicalTouchEvents([
      { type: "Down", x: 0.7, y: 0.5, delayMs: 0 },
      { type: "Move", x: 0.64, y: 0.64, delayMs: 100 },
      { type: "Move", x: 0.5, y: 0.7, delayMs: 100 },
      { type: "Up", x: 0.36, y: 0.64, delayMs: 100 },
    ]);

    expect(compacted.length).toBeGreaterThan(2);
    expect(compacted.reduce((sum, event) => sum + (event.delayMs ?? 0), 0)).toBe(300);
  });

  it("does not compact across multiple contact sequences", () => {
    const events = [
      { type: "Down" as const, x: 0.2, y: 0.2 },
      { type: "Up" as const, x: 0.2, y: 0.2 },
      { type: "Down" as const, x: 0.8, y: 0.8 },
      { type: "Up" as const, x: 0.8, y: 0.8 },
    ];
    expect(compactPhysicalTouchEvents(events)).toEqual(events);
  });
});

describe("physical iOS WDA describe adapter", () => {
  it("keeps nested descendants and renders their normalized frames", () => {
    const xml = `
      <AppiumAUT>
        <XCUIElementTypeApplication x="0" y="0" width="400" height="800">
          <XCUIElementTypeWindow x="0" y="0" width="400" height="800">
            <XCUIElementTypeOther x="0" y="80" width="400" height="200">
              <XCUIElementTypeSearchField label="Apple Maps" value="Bangalore" x="40" y="100" width="320" height="48"/>
              <XCUIElementTypeButton label="Directions" x="200" y="200" width="100" height="40"/>
            </XCUIElementTypeOther>
          </XCUIElementTypeWindow>
        </XCUIElementTypeApplication>
      </AppiumAUT>`;
    const tree = adaptWdaSourceToDescribeResult(xml, { width: 400, height: 800 });
    const rendered = formatDescribeTree(tree, { source: "wda-ax" });

    expect(rendered).toContain("Mode: nested");
    expect(rendered).toContain('AXSearchField "Apple Maps" value="Bangalore"');
    expect(rendered).toContain("(0.100, 0.125, 0.800, 0.060)");
    expect(rendered).toContain('AXButton "Directions"');
  });
});

describe("physical iOS profiling strategy", () => {
  it("records all physical-device processes and filters analysis to the app pid", () => {
    const target = { executable: "Maps", pid: 1835 };
    const args = physicalAllProcessesStrategy.buildRecordArgs({
      templatePath: "Time Profiler",
      deviceId: "00008130-0018544622E1001C",
      target,
      outputFile: "/tmp/maps.trace",
    });

    expect(args).toEqual([
      "record",
      "--template",
      "Time Profiler",
      "--device",
      "00008130-0018544622E1001C",
      "--all-processes",
      "--output",
      "/tmp/maps.trace",
      "--no-prompt",
    ]);
    expect(physicalAllProcessesStrategy.cpuFilterPid(target)).toBe(1835);
  });
});
