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
