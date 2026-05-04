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

  it("does NOT double-decode — &amp;lt; stays as literal '&lt;' (XML §4.6)", () => {
    // Per XML 1.0 §4.6, `&amp;lt;` represents the five literal characters
    // `&lt;`, not `<`. A chained decoder (numeric refs, then each named ref
    // as its own .replace pass) feeds the ampersand produced by the first
    // step into the second step, collapsing `&amp;lt;` → `&lt;` → `<`.
    // The single-pass alternation scans left-to-right and consumes each
    // match once, so decoded output never re-feeds the decoder.
    const xml = `<?xml version='1.0' ?>
<hierarchy rotation="0">
  <node class="android.widget.TextView" bounds="[0,0][100,50]"
        text="&amp;lt;" content-desc="" resource-id="" package="com.x" />
</hierarchy>`;
    const tree = parseUiAutomatorDump(xml, 1000, 1000);
    expect(tree.children[0]!.label).toBe("&lt;");
  });

  it("does NOT double-decode — &#38;lt; (numeric ampersand + 'lt;') also stays literal", () => {
    // Same bug surface via a numeric reference. `&#38;` decodes to `&` in a
    // chained implementation, and the second pass then sees `&lt;` and
    // collapses it to `<`. Single-pass keeps the decoded `&` distinct.
    const xml = `<?xml version='1.0' ?>
<hierarchy rotation="0">
  <node class="android.widget.TextView" bounds="[0,0][100,50]"
        text="&#38;lt;" content-desc="" resource-id="" package="com.x" />
</hierarchy>`;
    const tree = parseUiAutomatorDump(xml, 1000, 1000);
    expect(tree.children[0]!.label).toBe("&lt;");
  });

  it("does NOT double-decode — &#x26;amp; stays literal '&amp;'", () => {
    const xml = `<?xml version='1.0' ?>
<hierarchy rotation="0">
  <node class="android.widget.TextView" bounds="[0,0][100,50]"
        text="&#x26;amp;" content-desc="" resource-id="" package="com.x" />
</hierarchy>`;
    const tree = parseUiAutomatorDump(xml, 1000, 1000);
    expect(tree.children[0]!.label).toBe("&amp;");
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

describe("parseUiAutomatorXml — tolerates raw `>` inside attribute values", () => {
  // XML §2.4: only `<` and `&` MUST be escaped. `>` MAY appear unescaped, and
  // real Android dumps do emit it that way (e.g. text="A > B" comparison
  // strings, breadcrumb dividers). The previous tag regex used `[^<>]*?` for
  // the attribute block, so any node with a raw `>` got dropped entirely and
  // its subtree silently reparented onto the document root.
  it("preserves a node whose `text` attribute contains a raw `>`", () => {
    const xml = `<?xml version='1.0' ?>
<hierarchy rotation="0">
  <node class="android.widget.TextView" bounds="[0,0][100,50]"
        text="A > B" content-desc="" resource-id="" package="com.x" />
</hierarchy>`;
    const tree = parseUiAutomatorDump(xml, 1000, 1000);
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]!.label).toBe("A > B");
  });
});

describe("parseUiAutomatorXml — robust against malformed structure", () => {
  it("ignores a stray closing tag without dropping subsequent siblings", () => {
    // A leftover `</node>` with no matching opener used to pop a real parent
    // off the stack; the next opening tag then became a second `root`,
    // overwriting the first. Now: pop is guarded, and root is set only once.
    const xml = `<?xml version='1.0' ?>
<hierarchy rotation="0">
  <node class="android.widget.LinearLayout" bounds="[0,0][1000,1000]"
        text="" resource-id="" content-desc="" package="com.x">
    <node class="android.widget.TextView" bounds="[0,0][100,50]"
          text="first" resource-id="" content-desc="" package="com.x" />
  </node>
  </node>
  <node class="android.widget.TextView" bounds="[0,200][100,250]"
        text="second" resource-id="" content-desc="" package="com.x" />
</hierarchy>`;
    const tree = parseUiAutomatorDump(xml, 1000, 1000);
    // Both top-level child nodes should survive under the synthetic Screen root.
    const labels = tree.children.flatMap((c) => collectLabels(c));
    expect(labels).toContain("first");
    expect(labels).toContain("second");
  });
});

function collectLabels(n: { label?: string; children: { label?: string; children: unknown[] }[] }): string[] {
  const out: string[] = [];
  if (n.label) out.push(n.label);
  for (const c of n.children) out.push(...collectLabels(c as Parameters<typeof collectLabels>[0]));
  return out;
}

describe("convertUiAutomatorNode — preserves siblings under a bounds-less wrapper", () => {
  it("does not drop multiple children when the parent has no bounds", () => {
    // Compose hierarchies emit bounds-less wrappers with multiple children
    // routinely. The previous "collapse to sole child or drop" rule silently
    // dropped every child whenever there were 2+, so the agent never saw
    // them. Now the wrapper is replaced with a synthetic node whose frame is
    // the union of the children, and the children remain reachable.
    const xml = `<?xml version='1.0' ?>
<hierarchy rotation="0">
  <node class="androidx.compose.ui.platform.ComposeView">
    <node class="android.widget.Button" bounds="[0,0][100,50]"
          text="left" content-desc="" resource-id="" package="com.x" />
    <node class="android.widget.Button" bounds="[200,0][300,50]"
          text="right" content-desc="" resource-id="" package="com.x" />
  </node>
</hierarchy>`;
    const tree = parseUiAutomatorDump(xml, 1000, 1000);
    const labels = tree.children.flatMap((c) => collectLabels(c));
    expect(labels).toContain("left");
    expect(labels).toContain("right");
  });
});

describe("convertUiAutomatorNode — clips off-screen rects to the screen", () => {
  it("never produces a frame whose x + width exceeds 1", () => {
    // Rail/badge at the right edge that uiautomator reports past the screen
    // edge (real on tablets / foldables / drawer-overlay states). Without
    // clipping, x clamped to 1 and width=190/1080≈0.176 made the tap centre
    // land at 1.088 — off-screen.
    const xml = `<?xml version='1.0' ?>
<hierarchy rotation="0">
  <node class="android.widget.Button" bounds="[1090,0][1280,200]"
        text="X" content-desc="" resource-id="" package="com.x" />
  <node class="android.widget.Button" bounds="[-100,0][50,100]"
        text="Y" content-desc="" resource-id="" package="com.x" />
</hierarchy>`;
    const tree = parseUiAutomatorDump(xml, 1080, 1920);
    for (const child of tree.children) {
      expect(child.frame.x + child.frame.width).toBeLessThanOrEqual(1);
      expect(child.frame.y + child.frame.height).toBeLessThanOrEqual(1);
      expect(child.frame.x).toBeGreaterThanOrEqual(0);
      expect(child.frame.y).toBeGreaterThanOrEqual(0);
    }
  });
});
