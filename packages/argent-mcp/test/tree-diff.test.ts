import { describe, it, expect } from "vitest";
import { AUTO_DESCRIBE_HEADER } from "../src/auto-capture.js";
import { renderTreeChange, TREE_DIFF_HEADER, TREE_UNCHANGED_TEXT } from "../src/tree-diff.js";

const ROWS = Array.from(
  { length: 8 },
  (_, i) => `AXButton "Row ${i}" (0.000,0.${i}00,1.000,0.100)`
).join("\n");

describe("renderTreeChange", () => {
  it("renders the full tree when there is no previous tree", () => {
    expect(renderTreeChange(undefined, ROWS)).toEqual({
      mode: "full",
      text: `${AUTO_DESCRIBE_HEADER}\n${ROWS}`,
    });
  });

  it("renders one line for a tree that did not change", () => {
    expect(renderTreeChange(ROWS, ROWS)).toEqual({ mode: "unchanged", text: TREE_UNCHANGED_TEXT });
  });

  it("lists the lines that went, then the lines that came, in tree order", () => {
    const after = ROWS.replace('"Row 2"', '"Row 2" value="on"') + '\nAXStaticText "Saved"';

    expect(renderTreeChange(ROWS, after)).toEqual({
      mode: "diff",
      text: [
        TREE_DIFF_HEADER,
        '- AXButton "Row 2" (0.000,0.200,1.000,0.100)',
        '+ AXButton "Row 2" value="on" (0.000,0.200,1.000,0.100)',
        '+ AXStaticText "Saved"',
      ].join("\n"),
    });
  });

  it("counts a repeated line as often as it occurs", () => {
    const before = `${ROWS}\nAXImage (0,0,1,1)\nAXImage (0,0,1,1)`;
    const after = `${ROWS}\nAXImage (0,0,1,1)`;

    expect(renderTreeChange(before, after).text).toBe(`${TREE_DIFF_HEADER}\n- AXImage (0,0,1,1)`);
    expect(renderTreeChange(after, before).text).toBe(`${TREE_DIFF_HEADER}\n+ AXImage (0,0,1,1)`);
  });

  it("ignores blank lines", () => {
    expect(renderTreeChange(ROWS, `${ROWS}\n\n`).mode).toBe("unchanged");
  });

  it("renders the full tree when the diff is not shorter, as on a new screen", () => {
    const other = ROWS.replaceAll("Row", "Item");

    expect(renderTreeChange(ROWS, other)).toEqual({
      mode: "full",
      text: `${AUTO_DESCRIBE_HEADER}\n${other}`,
    });
  });
});
