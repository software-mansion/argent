import { describe, it, expect } from "vitest";
import {
  convertUiAutomatorNode,
  parseUiAutomatorDump,
  parseUiAutomatorXml,
} from "../src/utils/uiautomator-parser";

describe("uiautomator numeric entities (review #5)", () => {
  it("decodes &#N; decimal character references in text / content-desc", () => {
    // `→` is U+2192, which can appear in uiautomator dumps encoded as &#8594;
    // Without numeric-ref handling these survived undecoded into labels.
    const xml = `<?xml version='1.0' ?>
<hierarchy rotation="0">
  <node class="android.widget.TextView" bounds="[0,0][100,50]"
        text="Next &#8594;" content-desc="" resource-id="" package="com.x" />
</hierarchy>`;
    const tree = parseUiAutomatorDump(xml, 1000, 1000);
    const node = tree.children[0]!;
    expect(node.label).toBe("Next →");
  });

  it("decodes &#xH; hex character references", () => {
    const xml = `<?xml version='1.0' ?>
<hierarchy rotation="0">
  <node class="android.widget.TextView" bounds="[0,0][100,50]"
        text="Done &#x2713;" content-desc="" resource-id="" package="com.x" />
</hierarchy>`;
    const tree = parseUiAutomatorDump(xml, 1000, 1000);
    expect(tree.children[0]!.label).toBe("Done ✓");
  });

  it("decodes multi-codepoint (supplementary plane) numeric refs", () => {
    // 😀 is U+1F600 — outside the BMP, needs String.fromCodePoint (not String.fromCharCode).
    const xml = `<?xml version='1.0' ?>
<hierarchy rotation="0">
  <node class="android.widget.TextView" bounds="[0,0][100,50]"
        text="Hi &#128512;" content-desc="" resource-id="" package="com.x" />
</hierarchy>`;
    const tree = parseUiAutomatorDump(xml, 1000, 1000);
    expect(tree.children[0]!.label).toBe("Hi 😀");
  });

  it("replaces out-of-range / surrogate references with empty instead of throwing", () => {
    // U+D800 is a lone surrogate high-half; 0x110001 is past Unicode max.
    // String.fromCodePoint would throw for the latter — the decoder has to
    // swallow it so the rest of the tree is still usable.
    const xml = `<?xml version='1.0' ?>
<hierarchy rotation="0">
  <node class="android.widget.TextView" bounds="[0,0][100,50]"
        text="X&#xD800;Y&#1114113;Z" content-desc="" resource-id="" package="com.x" />
</hierarchy>`;
    const tree = parseUiAutomatorDump(xml, 1000, 1000);
    expect(tree.children[0]!.label).toBe("XYZ");
  });

  it("still decodes the five named entities alongside numeric ones", () => {
    const xml = `<?xml version='1.0' ?>
<hierarchy rotation="0">
  <node class="android.widget.TextView" bounds="[0,0][100,50]"
        text="A &amp; B &lt;c&gt; &#33;" content-desc="" resource-id="" package="com.x" />
</hierarchy>`;
    const tree = parseUiAutomatorDump(xml, 1000, 1000);
    expect(tree.children[0]!.label).toBe("A & B <c> !");
  });
});

describe("uiautomator deeply-nested tree (review #6)", () => {
  it("parses a 15k-deep hierarchy without blowing the JS stack", () => {
    // The review claimed 15k-deep was realistic on a misconfigured
    // RecyclerView + overlays. Build a dump that deep and confirm the new
    // iterative converter handles it.
    const depth = 15_000;
    let xml = `<?xml version='1.0' ?>\n<hierarchy rotation="0">\n`;
    for (let i = 0; i < depth; i++) {
      xml += `<node index="${i}" text="" resource-id="" class="android.view.View" package="com.x" content-desc="" bounds="[${i},${i}][${depth},${depth}]">\n`;
    }
    for (let i = 0; i < depth; i++) xml += `</node>\n`;
    xml += `</hierarchy>\n`;

    // This is the assertion that caught the recursion bug: recursive
    // convertUiAutomatorNode throws `Maximum call stack size exceeded`.
    expect(() => parseUiAutomatorDump(xml, depth, depth)).not.toThrow();
  });

  it("parseUiAutomatorXml + convertUiAutomatorNode together handle 10k deep trees", () => {
    const depth = 10_000;
    let xml = `<?xml version='1.0' ?>\n<hierarchy rotation="0">\n`;
    for (let i = 0; i < depth; i++) {
      xml += `<node index="${i}" class="android.view.View" bounds="[0,0][100,100]" text="" resource-id="" content-desc="" package="com.x">\n`;
    }
    for (let i = 0; i < depth; i++) xml += `</node>\n`;
    xml += `</hierarchy>\n`;

    const parsed = parseUiAutomatorXml(xml)!;
    // Navigate down to the single `<node>` child of the root and convert it.
    const topNode = parsed.children[0]!;
    expect(() => convertUiAutomatorNode(topNode, 100, 100)).not.toThrow();
  });
});
