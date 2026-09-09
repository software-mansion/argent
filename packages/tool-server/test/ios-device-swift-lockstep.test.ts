import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  RUNNER_TYPE_TO_ROLE,
  SCROLL_CONTAINER_TYPES,
} from "../src/tools/describe/platforms/ios-device";

// T53: the TS describe adapter and the Swift runner each hold half of the same
// agreement. The runner decides WHICH element types ship in a snapshot
// (interactiveTypes, scrollContainerTypes); the adapter decides what those
// types mean once they arrive (RUNNER_TYPE_TO_ROLE, SCROLL_CONTAINER_TYPES).
// The compiler cannot see across the language boundary, so this suite reads
// the Swift source from disk and pins the two sides against each other: edit
// either list alone and a test here names the side that has to follow.

const SWIFT_SNAPSHOT_SOURCE = path.resolve(
  __dirname,
  "../../ios-device-runner/ArgentRunner/ArgentRunnerUITests/ArgentRunnerSession+Snapshot.swift"
);

const swiftSource = readFileSync(SWIFT_SNAPSHOT_SOURCE, "utf8");

/**
 * `case .button: return "Button"` pairs from the Swift `elementTypeName`
 * switch: the authoritative member-name to wire-name mapping, so the list
 * extraction below never guesses at capitalization.
 */
function extractElementTypeNames(source: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of source.matchAll(/case\s+\.(\w+)\s*:\s*return\s+"(\w+)"/g)) {
    map.set(match[1], match[2]);
  }
  return map;
}

function extractSwiftTypeList(source: string, name: string): string[] {
  const list = source.match(
    new RegExp(`let\\s+${name}\\s*:\\s*Set<XCUIElement\\.ElementType>\\s*=\\s*\\[([^\\]]*)\\]`)
  );
  expect(list, `Swift list '${name}' not found in ${SWIFT_SNAPSHOT_SOURCE}`).not.toBeNull();
  const body = list![1].replace(/\/\/[^\n]*/g, "");
  const members = [...body.matchAll(/\.(\w+)/g)].map((match) => match[1]);
  expect(
    members.length,
    `Swift list '${name}' parsed empty; the extraction regex rotted`
  ).toBeGreaterThan(0);

  const typeNames = extractElementTypeNames(source);
  return members.map((member) => {
    const typeName = typeNames.get(member);
    expect(
      typeName,
      `Swift list '${name}' member '.${member}' has no case in elementTypeName; ` +
        "the wire name for it is unknown"
    ).toBeDefined();
    return typeName!;
  });
}

const swiftInteractive = new Set(extractSwiftTypeList(swiftSource, "interactiveTypes"));
const swiftScroll = new Set(extractSwiftTypeList(swiftSource, "scrollContainerTypes"));

// Swift interactive types deliberately absent from RUNNER_TYPE_TO_ROLE, one
// justification per line. Each entry is itself pinned below so it cannot
// outlive the condition it describes.
const ROLE_MAP_EXEMPT: Record<string, string> = {
  // Covered by SCROLL_CONTAINER_TYPES instead: the scrollable flag keeps it
  // emitted even unlabeled, and a content role would defeat that design.
  CollectionView: "scroll container; the scrollable flag is its rendering contract",
  // Same as CollectionView.
  WebView: "scroll container; the scrollable flag is its rendering contract",
  // Unmapped on purpose: its Button children carry the interaction and the
  // nested renderer's container rule emits the control whenever it has
  // children (see the RUNNER_TYPE_TO_ROLE doc comment).
  SegmentedControl: "children carry the interaction; container rule emits it",
};

// Role-map keys that are NOT on the Swift interactive allowlist, one
// justification per line. These are the always-shipped labeled types: the
// runner's shouldInclude ships ANY node with a label / identifier / value, and
// these two only matter when labeled, so they need a content role without
// being interactive types.
const LABELED_ONLY_ROLE_KEYS: Record<string, string> = {
  StaticText: "ships via the label fallback; AXStaticText renders it as content",
  Image: "ships via the label fallback; AXImage renders it as content",
};

describe("ios-device Swift lockstep", () => {
  it("SCROLL_CONTAINER_TYPES equals the Swift scrollContainerTypes exactly", () => {
    expect([...SCROLL_CONTAINER_TYPES].sort()).toEqual([...swiftScroll].sort());
  });

  it("every Swift interactive type is role-mapped or exempt with a reason", () => {
    for (const type of swiftInteractive) {
      const covered = type in RUNNER_TYPE_TO_ROLE || type in ROLE_MAP_EXEMPT;
      expect(
        covered,
        `Swift interactiveTypes ships '${type}' but RUNNER_TYPE_TO_ROLE does not map it: ` +
          "an unmapped type keeps its raw XCTest name and the formatter's content gate drops " +
          "it when unlabeled. Map it in describe/platforms/ios-device.ts, or add it to " +
          "ROLE_MAP_EXEMPT here with the reason it needs no content role."
      ).toBe(true);
    }
  });

  it("every role-map key is a Swift interactive type or a documented labeled-only type", () => {
    for (const key of Object.keys(RUNNER_TYPE_TO_ROLE)) {
      const covered = swiftInteractive.has(key) || key in LABELED_ONLY_ROLE_KEYS;
      expect(
        covered,
        `RUNNER_TYPE_TO_ROLE maps '${key}' but the Swift interactiveTypes allowlist does not ` +
          "ship it, so the mapping is dead unless the node carries a label / identifier / " +
          "value. Add it to interactiveTypes in ArgentRunnerSession+Snapshot.swift (and " +
          "rebuild the runner), or add it to LABELED_ONLY_ROLE_KEYS here with a reason."
      ).toBe(true);
    }
  });

  it("no exemption entry is stale", () => {
    for (const type of Object.keys(ROLE_MAP_EXEMPT)) {
      expect(
        swiftInteractive.has(type),
        `ROLE_MAP_EXEMPT lists '${type}' but Swift interactiveTypes no longer ships it; ` +
          "delete the exemption"
      ).toBe(true);
      expect(
        type in RUNNER_TYPE_TO_ROLE,
        `ROLE_MAP_EXEMPT lists '${type}' but RUNNER_TYPE_TO_ROLE now maps it; ` +
          "delete the exemption"
      ).toBe(false);
    }
    // The scroll-container justification holds only while the type is in the
    // scroll set; SegmentedControl is the one exemption standing on its own.
    for (const type of ["CollectionView", "WebView"]) {
      expect(
        SCROLL_CONTAINER_TYPES.has(type),
        `ROLE_MAP_EXEMPT justifies '${type}' via SCROLL_CONTAINER_TYPES, which no longer ` +
          "contains it; re-justify or map it"
      ).toBe(true);
    }
    for (const key of Object.keys(LABELED_ONLY_ROLE_KEYS)) {
      expect(
        key in RUNNER_TYPE_TO_ROLE,
        `LABELED_ONLY_ROLE_KEYS lists '${key}' but RUNNER_TYPE_TO_ROLE no longer maps it; ` +
          "delete the entry"
      ).toBe(true);
      expect(
        swiftInteractive.has(key),
        `LABELED_ONLY_ROLE_KEYS lists '${key}' but Swift interactiveTypes now ships it; ` +
          "delete the entry (it is a plain interactive mapping now)"
      ).toBe(false);
    }
  });
});
