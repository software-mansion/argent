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

describe("sample-time refs", () => {
  it("keeps a row whose sample-time is a ref, and the backtrace it defines", () => {
    // Two threads sampled at the same instant: the second row references the first
    // row's sample-time and defines a backtrace that a later row reuses.
    const xml = `
<row><sample-time id="1">1000</sample-time><thread id="2" fmt="Main Thread"/><weight id="3">1000000</weight><tagged-backtrace id="4"><frame id="5" name="mainWork"/></tagged-backtrace></row>
<row><sample-time ref="1"/><thread id="6" fmt="Worker"/><weight ref="3"/><tagged-backtrace id="7"><frame id="8" name="workerWork"/></tagged-backtrace></row>
<row><sample-time id="9">2000</sample-time><thread ref="6"/><weight ref="3"/><tagged-backtrace ref="7"/></row>`;
    const samples = parseCpuXml(xml);
    expect(samples.map((s) => [s.timestampNs, s.threadFmt, s.stack[0]?.name])).toEqual([
      [1000, "Main Thread", "mainWork"],
      [1000, "Worker", "workerWork"],
      [2000, "Worker", "workerWork"],
    ]);
  });
});
