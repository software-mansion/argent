import { describe, expect, it } from "vitest";
import { parseTesseractTsv } from "../src/tools/screenshot-diff/screenshot-diff-ocr";

describe("Tesseract TSV parsing", () => {
  it("normalizes block and word confidence to a 0-1 scale", () => {
    const blocks = parseTesseractTsv(
      tsv([
        row({ wordNum: 1, left: 10, top: 20, width: 40, height: 10, conf: 95, text: "Hello" }),
        row({ wordNum: 2, left: 56, top: 20, width: 50, height: 10, conf: 93, text: "World" }),
      ])
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe("Hello World");
    expect(blocks[0]?.confidence).toBe(0.94);
    expect(blocks[0]?.words.map((word) => word.confidence)).toEqual([0.95, 0.93]);
  });

  it("throws a clear error for malformed non-empty TSV headers", () => {
    expect(() =>
      parseTesseractTsv("level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\ttext\n")
    ).toThrow(
      /Invalid Tesseract TSV: missing required column\(s\): left, top, width, height, conf/
    );
  });

  it("parses valid TSV with a UTF-8 BOM-prefixed header", () => {
    const blocks = parseTesseractTsv(
      `\uFEFF${tsv([row({ left: 10, top: 20, width: 44, height: 12, conf: 91, text: "Ready" })])}`
    );

    expect(blocks.map((block) => block.text)).toEqual(["Ready"]);
  });

  it("parses headerless TSV from tesseract.js", () => {
    const blocks = parseTesseractTsv(
      [
        "1\t1\t0\t0\t0\t0\t0\t0\t1206\t2622\t-1\t",
        "2\t1\t1\t0\t0\t0\t76\t244\t151\t34\t-1\t",
        "3\t1\t1\t1\t0\t0\t76\t244\t151\t34\t-1\t",
        "4\t1\t1\t1\t1\t0\t76\t244\t151\t34\t-1\t",
        "5\t1\t1\t1\t1\t1\t76\t248\t33\t27\t69.401016\t<",
        "5\t1\t1\t1\t1\t2\t128\t244\t99\t34\t96.929596\tBack",
      ].join("\n")
    );

    expect(blocks.map((block) => block.text)).toEqual(["< Back"]);
  });

  it("returns no blocks for empty input", () => {
    expect(parseTesseractTsv("")).toEqual([]);
  });

  it("preserves meaningful symbol-only OCR tokens", () => {
    const blocks = parseTesseractTsv(
      tsv([
        row({ wordNum: 1, left: 10, top: 20, width: 8, text: "$" }),
        row({ wordNum: 2, left: 24, top: 20, width: 46, text: "19.99" }),
        row({ lineNum: 2, wordNum: 1, left: 10, top: 38, width: 24, text: "50" }),
        row({ lineNum: 2, wordNum: 2, left: 40, top: 38, width: 10, text: "%" }),
        row({ lineNum: 3, wordNum: 1, left: 10, top: 56, width: 10, text: "A" }),
        row({ lineNum: 3, wordNum: 2, left: 26, top: 56, width: 10, text: "+" }),
        row({ lineNum: 3, wordNum: 3, left: 42, top: 56, width: 10, text: "B" }),
        row({ lineNum: 3, wordNum: 4, left: 58, top: 56, width: 10, text: "=" }),
        row({ lineNum: 3, wordNum: 5, left: 74, top: 56, width: 10, text: "C" }),
        row({ lineNum: 4, wordNum: 1, left: 10, top: 74, width: 120, text: "user@example.com" }),
      ])
    );

    expect(blocks.map((block) => block.text)).toEqual(["$ 19.99 50 % A + B = C user@example.com"]);
  });

  it("orders merged words visually by x position before word number", () => {
    const blocks = parseTesseractTsv(
      tsv([
        row({ wordNum: 2, left: 10, top: 20, width: 34, text: "Left" }),
        row({ wordNum: 1, left: 52, top: 20, width: 42, text: "Right" }),
      ])
    );

    expect(blocks[0]?.text).toBe("Left Right");
  });

  it("merges wrapped lines in the same OCR block and paragraph", () => {
    const blocks = parseTesseractTsv(
      tsv([
        row({ lineNum: 1, wordNum: 1, left: 10, top: 20, width: 42, text: "Apple" }),
        row({ lineNum: 1, wordNum: 2, left: 58, top: 20, width: 64, text: "Account" }),
        row({ lineNum: 2, wordNum: 1, left: 10, top: 38, width: 48, text: "iCloud" }),
        row({ lineNum: 2, wordNum: 2, left: 64, top: 38, width: 30, text: "and" }),
        row({ lineNum: 2, wordNum: 3, left: 100, top: 38, width: 36, text: "more" }),
      ])
    );

    expect(blocks.map((block) => block.text)).toEqual(["Apple Account iCloud and more"]);
  });

  it("keeps same-block wrapped lines in different OCR paragraphs separate", () => {
    const blocks = parseTesseractTsv(
      tsv([
        row({ parNum: 1, lineNum: 1, wordNum: 1, left: 10, top: 20, width: 40, text: "First" }),
        row({ parNum: 1, lineNum: 1, wordNum: 2, left: 56, top: 20, width: 32, text: "line" }),
        row({ parNum: 2, lineNum: 2, wordNum: 1, left: 10, top: 37, width: 48, text: "Second" }),
        row({ parNum: 2, lineNum: 2, wordNum: 2, left: 64, top: 37, width: 30, text: "line" }),
      ])
    );

    expect(blocks.map((block) => block.text)).toEqual(["First line", "Second line"]);
  });

  it("keeps two-column text split into separate blocks", () => {
    const blocks = parseTesseractTsv(
      tsv([
        row({ lineNum: 1, wordNum: 1, left: 10, top: 20, width: 32, text: "Left" }),
        row({ lineNum: 1, wordNum: 2, left: 48, top: 20, width: 46, text: "column" }),
        row({ lineNum: 1, wordNum: 3, left: 180, top: 20, width: 40, text: "Right" }),
        row({ lineNum: 1, wordNum: 4, left: 226, top: 20, width: 24, text: "rail" }),
        row({ lineNum: 2, wordNum: 1, left: 10, top: 38, width: 66, text: "Continued" }),
        row({ lineNum: 2, wordNum: 2, left: 82, top: 38, width: 34, text: "copy" }),
        row({ lineNum: 2, wordNum: 3, left: 180, top: 38, width: 38, text: "More" }),
        row({ lineNum: 2, wordNum: 4, left: 224, top: 38, width: 30, text: "data" }),
      ])
    );

    expect(blocks.map((block) => block.text)).toEqual([
      "Left column Continued copy",
      "Right rail More data",
    ]);
  });

  it("keeps all-caps labels separate from nearby cross-block content", () => {
    const blocks = parseTesseractTsv(
      tsv([
        row({
          blockNum: 1,
          lineNum: 1,
          wordNum: 1,
          left: 74,
          top: 1790,
          width: 139,
          height: 23,
          conf: 97,
          text: "ALBUM",
        }),
        row({
          blockNum: 2,
          lineNum: 1,
          wordNum: 1,
          left: 74,
          top: 1842,
          width: 72,
          height: 29,
          conf: 96,
          text: "The",
        }),
        row({
          blockNum: 2,
          lineNum: 1,
          wordNum: 2,
          left: 160,
          top: 1842,
          width: 103,
          height: 29,
          conf: 96,
          text: "Venue",
        }),
      ])
    );

    expect(blocks.map((block) => block.text)).toEqual(["ALBUM", "The Venue"]);
  });
});

interface RowOptions {
  level?: number;
  pageNum?: number;
  blockNum?: number;
  parNum?: number;
  lineNum?: number;
  wordNum?: number;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  conf?: number;
  text: string;
}

function row(options: RowOptions): string {
  const {
    level = 5,
    pageNum = 1,
    blockNum = 1,
    parNum = 1,
    lineNum = 1,
    wordNum = 1,
    left = 10,
    top = 20,
    width = 40,
    height = 12,
    conf = 90,
    text,
  } = options;
  return [
    level,
    pageNum,
    blockNum,
    parNum,
    lineNum,
    wordNum,
    left,
    top,
    width,
    height,
    conf,
    text,
  ].join("\t");
}

function tsv(rows: string[]): string {
  return [
    "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
    ...rows,
  ].join("\n");
}
