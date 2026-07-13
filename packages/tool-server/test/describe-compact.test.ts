import { describe, expect, it } from "vitest";
import { Registry } from "@argent/registry";
import type { DescribeNode } from "../src/tools/describe/contract";
import {
  DESCRIBE_FIELDS,
  formatDescribeSelection,
  formatDescribeTree,
} from "../src/tools/describe/format-tree";
import { createDescribeTool } from "../src/tools/describe";
import {
  describeSelectorSchema,
  findDescribeMatches,
  matchesDescribeSelector,
} from "../src/tools/describe/selectors";

const frame = { x: 0, y: 0, width: 1, height: 1 };

function node(
  role: string,
  options: Partial<Omit<DescribeNode, "role" | "frame" | "children">> = {},
  children: DescribeNode[] = []
): DescribeNode {
  return { role, frame, children, ...options };
}

const tree = node("hierarchy", {}, [
  node("Panel", { identifier: "profile-panel" }, [
    node("TextView", { label: "Account" }),
    node("Button", { label: "Save profile", identifier: "save-button", clickable: true }),
  ]),
  node("Panel", {}, [node("Button", { label: "Cancel", identifier: "cancel-button" })]),
]);

describe("shared describe selector", () => {
  it("uses AND semantics with case-insensitive substring matching", () => {
    const selector = describeSelectorSchema.parse({
      text: "SAVE",
      identifier: "save-",
      role: "button",
    });
    expect(matchesDescribeSelector(tree.children[0]!.children[1]!, selector)).toBe(true);
    expect(matchesDescribeSelector(tree.children[1]!.children[0]!, selector)).toBe(false);
  });

  it("finds matching descendants but never the synthetic root", () => {
    expect(findDescribeMatches(tree, { role: "hierarchy" })).toEqual([]);
    expect(findDescribeMatches(tree, { role: "button" })).toHaveLength(2);
  });
});

describe("compact describe rendering", () => {
  it("renders matches as flat lines and defaults can include every field", () => {
    const result = formatDescribeSelection(tree, {
      source: "uiautomator",
      selector: { role: "button" },
      projection: "matches",
      fields: DESCRIBE_FIELDS,
      limit: 50,
      maxChars: 12_000,
    });

    expect(result).toMatchObject({ matched: 2, emitted: 2, truncated: false });
    expect(result.description).toContain(
      'Button "Save profile" id="save-button" [clickable] [match]'
    );
    expect(result.description).toContain('Button "Cancel" id="cancel-button" [match]');
    expect(result.description).not.toContain("Panel");
    expect(result.description).not.toMatch(/^ {2}Button/m);
  });

  it("keeps only paths to matches for matches-and-ancestors", () => {
    const result = formatDescribeSelection(tree, {
      source: "uiautomator",
      selector: { text: "Save" },
      projection: "matches-and-ancestors",
      fields: ["role", "label"],
      limit: 50,
      maxChars: 12_000,
    });

    expect(result.description).toContain("  Panel");
    expect(result.description).toContain('    Button "Save profile" [match]');
    expect(result.description).not.toContain("Account");
    expect(result.description).not.toContain("Cancel");
  });

  it("renders the full projection with matches highlighted and requested fields only", () => {
    const result = formatDescribeSelection(tree, {
      source: "uiautomator",
      selector: { identifier: "save-button" },
      projection: "full",
      fields: ["label"],
      limit: 50,
      maxChars: 12_000,
    });

    expect(result.matched).toBe(1);
    expect(result.description).toContain('"Save profile" [match]');
    expect(result.description).toContain('"Cancel"');
    expect(result.description).not.toContain("(0.000");
    expect(result.description).not.toContain("id=");
  });

  it("reports limit and character truncation explicitly", () => {
    const byLimit = formatDescribeSelection(tree, {
      source: "uiautomator",
      selector: { role: "button" },
      projection: "matches",
      fields: DESCRIBE_FIELDS,
      limit: 1,
      maxChars: 12_000,
    });
    expect(byLimit).toMatchObject({ matched: 2, emitted: 1, truncated: true });
    expect(byLimit.description).toContain("… truncated");

    const byChars = formatDescribeSelection(tree, {
      source: "uiautomator",
      selector: { role: "button" },
      projection: "full",
      fields: DESCRIBE_FIELDS,
      limit: 50,
      maxChars: 256,
    });
    expect(byChars.truncated).toBe(true);
    expect(byChars.description.length).toBeLessThanOrEqual(256);
    expect(byChars.description).toContain("… truncated");
  });
});

describe("describe compact schema compatibility", () => {
  const schema = createDescribeTool(new Registry()).zodSchema!;
  const udid = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";

  it("keeps the selector-less request valid and the legacy formatter unchanged", () => {
    expect(schema.safeParse({ udid }).success).toBe(true);
    const before = formatDescribeTree(tree, { source: "uiautomator" });
    const after = formatDescribeTree(tree, { source: "uiautomator" });
    expect(after).toBe(before);
  });

  it("accepts compact controls with a selector and validates their bounds", () => {
    expect(
      schema.safeParse({
        udid,
        selector: { text: "Save" },
        projection: "matches-and-ancestors",
        fields: ["role", "frame"],
        limit: 500,
        maxChars: 100_000,
      }).success
    ).toBe(true);
    expect(schema.safeParse({ udid, selector: {}, limit: 1 }).success).toBe(false);
    expect(schema.safeParse({ udid, selector: { text: "Save" }, limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ udid, selector: { text: "Save" }, maxChars: 255 }).success).toBe(
      false
    );
    expect(schema.safeParse({ udid, limit: 1 }).success).toBe(false);
  });
});
