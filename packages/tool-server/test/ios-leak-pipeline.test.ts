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
import { describe, it, expect } from "vitest";
import { parseLeaksXml } from "../src/utils/ios-profiler/pipeline/xml-parser";
import { aggregateLeaks, isLeakAttributed } from "../src/utils/ios-profiler/pipeline/01-correlate";

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

  it("treats a real responsible frame as attributed", () => {
    expect(isLeakAttributed("-[MyViewController loadData]")).toBe(true);
    expect(isLeakAttributed("MyApp`closure #1")).toBe(true);
  });
});
