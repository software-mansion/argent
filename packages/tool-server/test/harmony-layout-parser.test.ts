import { describe, it, expect } from "vitest";
import {
  harmonyLabel,
  parseHarmonyBounds,
  parseHarmonyLayout,
} from "../src/tools/describe/platforms/harmony/layout-parser";
import { findAll } from "../src/utils/ui-tree-match";
import type { HarmonyLayoutNode } from "../src/utils/harmony-uitest";
import type { DescribeNode } from "../src/tools/describe/contract";

const SCREEN = { width: 1216, height: 2688 };

/** Build a dump node with `uitest`'s string-valued attributes. */
function node(
  attrs: Record<string, string>,
  children: HarmonyLayoutNode[] = []
): HarmonyLayoutNode {
  return { attributes: attrs, children };
}

/** The synthetic root `uitest` emits: no attributes but the display bounds. */
function root(windows: HarmonyLayoutNode[]): HarmonyLayoutNode {
  return node({ bounds: "[0,0][1216,2688]" }, windows);
}

function flatten(n: { role: string; children: { role: string }[] }): string[] {
  return [n.role, ...n.children.flatMap((c) => flatten(c as never))];
}

describe("parseHarmonyBounds", () => {
  it("reads the [l,t][r,b] pixel form", () => {
    expect(parseHarmonyBounds("[55,1387][292,1624]")).toEqual({ x: 55, y: 1387, w: 237, h: 237 });
  });

  it("reads negative coordinates, which a list emits for items scrolled off", () => {
    expect(parseHarmonyBounds("[-40,-10][60,90]")).toEqual({ x: -40, y: -10, w: 100, h: 100 });
  });

  it("returns null for anything else", () => {
    expect(parseHarmonyBounds("")).toBeNull();
    expect(parseHarmonyBounds("55,1387")).toBeNull();
  });
});

describe("harmonyLabel", () => {
  it("prefers the accessibility description over the visible text", () => {
    expect(harmonyLabel({ description: "Delete", text: "x" })).toBe("Delete");
  });

  it("treats a whitespace-only description as absent", () => {
    expect(harmonyLabel({ description: " ", text: "7" })).toBe("7");
  });

  it("falls back to the placeholder of an empty field", () => {
    expect(harmonyLabel({ description: "", text: "", hint: "Search" })).toBe("Search");
  });

  it("returns empty when the node carries nothing", () => {
    expect(harmonyLabel({})).toBe("");
  });
});

describe("parseHarmonyLayout", () => {
  it("tags each window with the app that owns it, as an identifier not a label", () => {
    const tree = parseHarmonyLayout(
      root([
        node({ type: "root", bundleName: "com.app", bounds: "[0,107][1216,2688]" }, [
          node({ type: "Text", text: "Hi", bounds: "[0,107][100,207]" }),
        ]),
      ]),
      SCREEN
    ).tree;
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].role).toBe("Window");
    // `identifier`, not `label`: a label would match text searches on every screen.
    expect(tree.children[0].identifier).toBe("com.app");
    expect(tree.children[0].label).toBeUndefined();
  });

  it.each([
    ["Text", "StaticText"],
    ["Span", "StaticText"],
    ["TextClock", "StaticText"],
    ["TextInput", "TextField"],
    ["TextArea", "TextField"],
    ["SearchField", "TextField"],
    ["Search", "TextField"],
    ["Image", "Image"],
    ["SymbolGlyph", "Image"],
    ["Checkbox", "Checkbox"],
    ["Slider", "Slider"],
    ["List", "ScrollView"],
    ["Grid", "ScrollView"],
    ["Scroll", "ScrollView"],
    ["WaterFlow", "ScrollView"],
    ["ListItem", "Cell"],
    ["GridItem", "Cell"],
    ["Swiper", "Pager"],
    ["Dialog", "Dialog"],
    ["Button", "Button"],
    // Unmapped: the author's own component name beats a generic label.
    ["CustomWidget", "CustomWidget"],
  ])("maps the ArkUI %s onto %s", (type, role) => {
    const tree = parseHarmonyLayout(
      root([
        node({ type: "root", bundleName: "com.app", bounds: "[0,0][1216,2688]" }, [
          node({ type, text: "x", bounds: "[10,10][210,110]" }),
        ]),
      ]),
      SCREEN
    ).tree;
    expect(flatten(tree)).toEqual(["Screen", "Window", role]);
  });

  it("reads a Toggle's role off what it can actually do", () => {
    const build = (checkable: string) =>
      parseHarmonyLayout(
        root([
          node({ type: "root", bundleName: "com.app", bounds: "[0,0][1216,2688]" }, [
            node({ type: "Toggle", checkable, text: "Wi-Fi", bounds: "[10,10][210,110]" }),
          ]),
        ]),
        SCREEN
      ).tree;
    expect(flatten(build("true"))).toEqual(["Screen", "Window", "Switch"]);
    expect(flatten(build("false"))).toEqual(["Screen", "Window", "Button"]);
  });

  it("walks through ArkUI layout scaffolding instead of emitting it", () => {
    const tree = parseHarmonyLayout(
      root([
        node({ type: "root", bundleName: "com.app", bounds: "[0,0][1216,2688]" }, [
          node({ type: "Column", bounds: "[0,0][1216,2688]" }, [
            node({ type: "Row", bounds: "[0,0][1216,2688]" }, [
              node({ type: "Stack", bounds: "[0,0][1216,2688]" }, [
                node({ type: "Text", text: "Deep", bounds: "[10,10][110,110]" }),
              ]),
            ]),
          ]),
        ]),
      ]),
      SCREEN
    ).tree;
    expect(flatten(tree)).toEqual(["Screen", "Window", "StaticText"]);
  });

  it("keeps a layout type that is itself clickable", () => {
    const tree = parseHarmonyLayout(
      root([
        node({ type: "root", bundleName: "com.app", bounds: "[0,0][1216,2688]" }, [
          node({ type: "Stack", clickable: "true", id: "tap-me", bounds: "[0,0][100,100]" }),
        ]),
      ]),
      SCREEN
    ).tree;
    const target = tree.children[0].children[0];
    expect(target.identifier).toBe("tap-me");
    expect(target.clickable).toBe(true);
  });

  describe("layout containers that know something themselves", () => {
    const wrapping = (attrs: Record<string, string>): DescribeNode =>
      parseHarmonyLayout(
        root([
          node({ type: "root", bundleName: "com.app", bounds: "[0,0][1216,2688]" }, [
            node({ ...attrs, bounds: "[0,300][1216,440]" }, [
              node({ type: "Text", text: "Wi-Fi", bounds: "[40,340][400,400]" }),
            ]),
          ]),
        ]),
        SCREEN
      ).tree;

    it("keeps a container carrying the identifier an agent selects on", () => {
      const tree = wrapping({ type: "Column", id: "wifi_entry", key: "wifi_entry" });
      expect(findAll(tree, { identifier: "wifi_entry" })).toHaveLength(1);
      const target = tree.children[0].children[0];
      expect(target.identifier).toBe("wifi_entry");
      // The row's own text stays reachable underneath it.
      expect(target.children[0].label).toBe("Wi-Fi");
    });

    it("takes `key` when there is no `id`, and prefers `id` when there is", () => {
      // A component may carry only `.key()`, or both with `id` winning.
      const identifierOf = (attrs: Record<string, string>): string | undefined =>
        wrapping(attrs).children[0].children[0].identifier;

      expect(identifierOf({ type: "Column", key: "wifi_key" })).toBe("wifi_key");
      expect(identifierOf({ type: "Column", id: "wifi_id", key: "wifi_key" })).toBe("wifi_id");
    });

    it("costs one attribute, not the whole tree, when a dump value is not a string", () => {
      const odd: Record<string, string> = {
        type: "Text",
        description: 0 as unknown as string,
        text: "Submit",
        id: false as unknown as string,
        bounds: "[0,300][1216,440]",
      };
      const target = wrapping(odd).children[0].children[0];

      expect(target.label).toBe("Submit");
      expect(target.identifier).toBeUndefined();
    });

    it("keeps a container carrying the label an agent selects on", () => {
      // One label per source attribute, each its own branch.
      const cases: Record<string, string>[] = [
        { type: "Column", description: "Wi-Fi, connected" },
        { type: "Row", hint: "Wi-Fi, connected" },
      ];
      for (const attrs of cases) {
        const target = wrapping(attrs).children[0].children[0];
        expect(target.label).toBe("Wi-Fi, connected");
        // Hoisted, this position would hold the `Text` instead.
        expect(target.children[0].label).toBe("Wi-Fi");
      }
    });

    it("keeps a container that knows it is disabled, selected or focused", () => {
      // One flag per case, without an `id` that would keep the node anyway.
      const own = (attrs: Record<string, string>) => wrapping(attrs).children[0].children[0];
      expect(own({ type: "Row", enabled: "false" }).disabled).toBe(true);
      expect(own({ type: "Column", selected: "true" }).selected).toBe(true);
      expect(own({ type: "Stack", focused: "true" }).focused).toBe(true);
    });
  });

  describe("same-rect duplicate layers", () => {
    const wrap = (attrs: Record<string, string>, child: Record<string, string>) =>
      parseHarmonyLayout(
        root([
          node({ type: "root", bundleName: "com.app", bounds: "[0,0][1216,2688]" }, [
            node(attrs, [node(child)]),
          ]),
        ]),
        SCREEN
      ).tree.children[0].children[0];

    it("collapses a wrapper that knows nothing its child does not", () => {
      const B = "[0,0][200,100]";
      const target = wrap(
        { type: "Stack", clickable: "true", bounds: B },
        {
          type: "Text",
          text: "Submit",
          bounds: B,
        }
      );
      expect(target.role).toBe("StaticText");
      expect(target.label).toBe("Submit");
      expect(target.clickable).toBe(true);
      expect(target.children).toHaveLength(0);
    });

    it("reads a non-checkable Toggle as the button it behaves like", () => {
      const B = "[0,0][200,100]";
      const asSwitch = wrap(
        { type: "Toggle", checkable: "true", clickable: "true", id: "wifi", bounds: B },
        { type: "Text", text: "Wi-Fi", bounds: B }
      );
      const asButton = wrap(
        { type: "Toggle", checkable: "false", clickable: "true", id: "play", bounds: B },
        { type: "Text", text: "Play", bounds: B }
      );

      expect(asSwitch.role).toBe("Switch");
      expect(asButton.role).toBe("Button");
    });

    it("keeps a wrapper that carries the only label in the pair", () => {
      const B = "[0,0][200,100]";
      const target = wrap(
        { type: "Button", clickable: "true", description: "Submit", bounds: B },
        { type: "Image", bounds: B }
      );

      expect(target.label).toBe("Submit");
      expect(target.role).toBe("Button");
    });

    it("does not collapse a multi-child wrapper onto its first child", () => {
      const B = "[0,0][400,200]";
      const tree = parseHarmonyLayout(
        root([
          node({ type: "root", bundleName: "com.app", bounds: "[0,0][1216,2688]" }, [
            node({ type: "Stack", clickable: "true", bounds: B }, [
              node({ type: "Image", bounds: B }),
              node({ type: "Text", text: "Buy now", bounds: "[10,10][200,60]" }),
              node({ type: "Text", text: "$4.99", bounds: "[10,70][200,120]" }),
            ]),
          ]),
        ]),
        SCREEN
      ).tree;

      expect(findAll(tree, { text: "Buy now" })).toHaveLength(1);
      expect(findAll(tree, { text: "$4.99" })).toHaveLength(1);
    });

    it("does not collapse onto a child that merely shares an origin", () => {
      const target = wrap(
        { type: "Stack", clickable: "true", bounds: "[0,0][400,200]" },
        { type: "Image", bounds: "[0,0][40,40]" }
      );

      expect(target.role).toBe("Stack");
      expect(target.children).toHaveLength(1);
      expect(target.children[0].role).toBe("Image");
    });

    it("keeps a mapped wrapper role through the collapse", () => {
      const B = "[0,0][1216,160]";
      const target = wrap(
        { type: "ListItem", bounds: B },
        { type: "Row", id: "Setting.Display.dark_mode", clickable: "true", bounds: B }
      );
      expect(target.role).toBe("Cell");
    });

    it("keeps a wrapper that carries the identifier an agent selects on", () => {
      const B = "[0,0][200,100]";
      const target = wrap(
        { type: "Stack", clickable: "true", id: "tap-me", bounds: B },
        {
          type: "Text",
          text: "Submit",
          bounds: B,
        }
      );
      expect(target.identifier).toBe("tap-me");
      // The child's label stays reachable rather than being traded for the id.
      expect(target.children[0].label).toBe("Submit");
    });

    // Each case carries only the state under test, no `id`, so it pins that flag.
    it("does not report a disabled control as a plain tappable one", () => {
      const B = "[0,0][200,100]";
      const target = wrap(
        { type: "Button", clickable: "true", enabled: "false", bounds: B },
        { type: "Text", text: "Submit", bounds: B }
      );
      expect(target.disabled).toBe(true);
      expect(target.role).toBe("Button");
    });

    it("keeps a scroll container that holds a single full-height row", () => {
      const B = "[0,0][1216,1000]";
      const target = wrap(
        { type: "List", bounds: B },
        {
          type: "ListItem",
          text: "only row",
          bounds: B,
        }
      );
      // Without this the agent sees no scrollable region and never swipes.
      expect(target.role).toBe("ScrollView");
      expect(target.scrollable).toBe(true);
    });

    it("keeps a switch's checked state when its image fills the same rect", () => {
      const B = "[0,0][200,100]";
      const target = wrap(
        { type: "Toggle", clickable: "true", checkable: "true", checked: "true", bounds: B },
        { type: "Image", bounds: B }
      );
      expect(target.role).toBe("Switch");
      expect(target.checkable).toBe(true);
      expect(target.checked).toBe(true);
    });

    it("keeps a long-pressable wrapper", () => {
      const B = "[0,0][200,100]";
      const target = wrap(
        { type: "Stack", longClickable: "true", bounds: B },
        { type: "Image", bounds: B }
      );
      expect(target.longClickable).toBe(true);
    });

    it("keeps a switch that is off, not only one that is on", () => {
      // The off case pins `checkable` alone.
      const B = "[0,0][200,100]";
      const target = wrap(
        { type: "Toggle", clickable: "true", checkable: "true", bounds: B },
        { type: "Image", bounds: B }
      );
      expect(target.checkable).toBe(true);
      expect(target.checked).toBeUndefined();
    });

    it("keeps a selected wrapper, and a focused one", () => {
      // Not a `Stack`: a bare layout container is hoisted before the collapse.
      const B = "[0,0][200,100]";
      expect(
        wrap({ type: "ListItem", selected: "true", bounds: B }, { type: "Image", bounds: B })
          .selected
      ).toBe(true);
      expect(
        wrap({ type: "ListItem", focused: "true", bounds: B }, { type: "Image", bounds: B }).focused
      ).toBe(true);
    });
  });

  it("drops decoration that can never be a target", () => {
    const tree = parseHarmonyLayout(
      root([
        node({ type: "root", bundleName: "com.app", bounds: "[0,0][1216,2688]" }, [
          node({ type: "Divider", bounds: "[0,0][1216,2]" }),
          node({ type: "ScrollBar", bounds: "[1164,0][1216,2688]" }),
          node({ type: "Text", text: "Real", bounds: "[0,10][100,110]" }),
        ]),
      ]),
      SCREEN
    ).tree;
    expect(flatten(tree)).toEqual(["Screen", "Window", "StaticText"]);
  });

  it("normalizes bounds into the [0,1] frame contract", () => {
    const tree = parseHarmonyLayout(
      root([
        node({ type: "root", bundleName: "com.app", bounds: "[0,0][1216,2688]" }, [
          node({ type: "Button", id: "b", bounds: "[608,1344][1216,2688]" }),
        ]),
      ]),
      SCREEN
    ).tree;
    expect(tree.children[0].children[0].frame).toEqual({
      x: 0.5,
      y: 0.5,
      width: 0.5,
      height: 0.5,
    });
  });

  it("clamps a frame for content scrolled off the top", () => {
    const tree = parseHarmonyLayout(
      root([
        node({ type: "root", bundleName: "com.app", bounds: "[0,0][1216,2688]" }, [
          node({ type: "Button", id: "b", bounds: "[-100,-200][100,200]" }),
        ]),
      ]),
      SCREEN
    ).tree;
    const f = tree.children[0].children[0].frame;
    expect(f.x).toBe(0);
    expect(f.y).toBe(0);
  });

  it("surfaces interactivity and state flags", () => {
    const tree = parseHarmonyLayout(
      root([
        node({ type: "root", bundleName: "com.app", bounds: "[0,0][1216,2688]" }, [
          node({
            type: "Button",
            id: "b",
            bounds: "[0,0][100,100]",
            clickable: "true",
            longClickable: "true",
            checkable: "true",
            checked: "true",
            enabled: "false",
            focused: "true",
            selected: "true",
          }),
        ]),
      ]),
      SCREEN
    ).tree;
    expect(tree.children[0].children[0]).toMatchObject({
      clickable: true,
      longClickable: true,
      checkable: true,
      checked: true,
      disabled: true,
      focused: true,
      selected: true,
    });
  });

  it("treats a node as enabled when `enabled` is absent", () => {
    const tree = parseHarmonyLayout(
      root([
        node({ type: "root", bundleName: "com.app", bounds: "[0,0][1216,2688]" }, [
          node({ type: "Button", id: "b", bounds: "[0,0][100,100]" }),
        ]),
      ]),
      SCREEN
    ).tree;
    expect(tree.children[0].children[0].disabled).toBeUndefined();
  });

  it("marks a List as scrollable by type even without the flag", () => {
    const tree = parseHarmonyLayout(
      root([
        node({ type: "root", bundleName: "com.app", bounds: "[0,0][1216,2688]" }, [
          node({ type: "List", bounds: "[0,0][1216,2688]" }, [
            node({ type: "Text", text: "row", bounds: "[0,0][100,100]" }),
          ]),
        ]),
      ]),
      SCREEN
    ).tree;
    expect(tree.children[0].children[0]).toMatchObject({ role: "ScrollView", scrollable: true });
  });

  it("says so when a system overlay hides its own contents", () => {
    const tree = parseHarmonyLayout(
      root([
        node({ type: "root", bundleName: "com.ohos.sceneboard", bounds: "[0,0][1216,2688]" }, [
          node({ type: "UIExtensionComponent", id: "AppSelector", bounds: "[0,0][1216,2688]" }),
        ]),
      ]),
      SCREEN
    ).tree;
    const overlay = tree.children[0].children[0];
    expect(overlay.role).toBe("SystemOverlay");
    expect(overlay.identifier).toBe("AppSelector");
  });

  it("keeps the overlay explanation out of the label slot", () => {
    const tree = parseHarmonyLayout(
      root([
        node({ type: "root", bundleName: "com.ohos.sceneboard", bounds: "[0,0][1216,2688]" }, [
          node({ type: "UIExtensionComponent", bounds: "[0,0][1216,2688]" }),
        ]),
      ]),
      SCREEN
    ).tree;
    const overlay = tree.children[0].children[0];
    for (const word of ["system", "process", "contents", "screenshot", "layout", "dump"]) {
      expect(overlay.label?.includes(word) ?? false, `label contains "${word}"`).toBe(false);
    }
    // An id-less placeholder still answers for itself.
    expect(overlay.identifier).toBeTruthy();
  });

  it("parses a UIExtensionComponent's own subtree when the dump carries one", () => {
    const tree = parseHarmonyLayout(
      root([
        node(
          {
            type: "WindowScene",
            bundleName: "com.huawei.hmos.settings",
            bounds: "[0,0][1216,2688]",
          },
          [
            node({ type: "UIExtensionComponent", bounds: "[0,0][1216,2688]" }, [
              node({ type: "Text", text: "HUAWEI ID", bounds: "[400,200][860,280]" }),
              node({ type: "TextInput", hint: "Phone number", bounds: "[200,400][1060,520]" }),
              node({
                type: "Button",
                text: "Back",
                clickable: "true",
                bounds: "[56,164][196,304]",
              }),
              node({
                type: "Button",
                text: "Log in/Register",
                clickable: "true",
                bounds: "[200,2400][1060,2520]",
              }),
            ]),
          ]
        ),
      ]),
      SCREEN
    ).tree;
    const text = JSON.stringify(tree);
    expect(text).toContain("HUAWEI ID");
    expect(text).toContain("Back");
    expect(text).toContain("Log in/Register");
    const back = tree.children[0].children[0].children.find((c) => c.label === "Back");
    expect(back).toMatchObject({ role: "Button", clickable: true });
  });

  it("does not let a window's bundle id read as visible text on the screen", () => {
    const tree = parseHarmonyLayout(
      root([
        node(
          {
            type: "WindowScene",
            bundleName: "com.huawei.hmos.settings",
            bounds: "[0,0][1216,2688]",
          },
          [node({ type: "Text", text: "Settings", bounds: "[40,120][500,200]" })]
        ),
        node(
          { type: "WindowScene", bundleName: "com.ohos.sceneboard", bounds: "[0,0][1216,120]" },
          [node({ type: "Text", text: "12:30", bounds: "[1100,20][1220,100]" })]
        ),
      ]),
      SCREEN
    ).tree;
    const labels: string[] = [];
    const walk = (n: DescribeNode): void => {
      if (n.label) labels.push(n.label);
      n.children.forEach(walk);
    };
    tree.children.forEach(walk);
    expect(labels).toContain("Settings");
    expect(labels).not.toContain("com.huawei.hmos.settings");
    expect(labels).not.toContain("com.ohos.sceneboard");
  });

  it("takes the screen size from the dump's own root, not the caller's", () => {
    const { screen } = parseHarmonyLayout(node({ bounds: "[0,0][2200,2480]" }, []), SCREEN);
    expect(screen).toEqual({ width: 2200, height: 2480 });
  });

  it("falls back to the queried size when the root reports no bounds", () => {
    const { screen } = parseHarmonyLayout(node({}, []), SCREEN);
    expect(screen).toEqual(SCREEN);
  });

  describe("off-screen rows", () => {
    const rows = (items: Array<[string, string]>) =>
      parseHarmonyLayout(
        root([
          node({ type: "WindowScene", bundleName: "com.demo.app", bounds: "[0,0][1216,2688]" }, [
            node(
              { type: "List", bounds: "[0,0][1216,2688]", scrollable: "true" },
              items.map(([text, bounds]) =>
                node({ type: "ListItem", text, bounds, clickable: "true" })
              )
            ),
          ]),
        ]),
        SCREEN
      ).tree.children[0].children[0].children;

    it("drops a row scrolled fully off the screen, on every edge", () => {
      const kept = rows([
        ["ABOVE", "[0,-400][1216,-260]"],
        ["BELOW", "[0,2888][1216,3028]"],
        ["RIGHT", "[1266,400][1456,540]"],
        ["VISIBLE", "[0,1000][1216,1140]"],
      ]);
      expect(kept.map((r) => r.label)).toEqual(["VISIBLE"]);
    });

    it("keeps only the visible slice of a row straddling an edge", () => {
      // 140px tall, 80px on screen.
      const kept = rows([
        ["ABOVE", "[0,-400][1216,-260]"],
        ["STRADDLE", "[0,-60][1216,80]"],
      ]);
      expect(kept.map((r) => r.label)).toEqual(["STRADDLE"]);
      expect(kept[0].frame.y).toBe(0);
      expect(kept[0].frame.height).toBeCloseTo(80 / 2688, 6);
    });

    it("never lets a frame run past the screen, so a tap centre stays on it", () => {
      const kept = rows([
        ["ABOVE", "[0,-400][1216,-260]"],
        ["BELOW", "[0,2888][1216,3028]"],
        ["RIGHT", "[1266,400][1456,540]"],
        ["PART-RIGHT", "[1100,400][1456,540]"],
        ["VISIBLE", "[0,1000][1216,1140]"],
      ]);
      // Guards against the loop below passing vacuously.
      expect(kept.length, "rows kept after pruning").toBeGreaterThan(0);
      for (const row of kept) {
        const { x, y, width, height } = row.frame;
        expect(x + width, `${row.label}: x+width`).toBeLessThanOrEqual(1);
        expect(y + height, `${row.label}: y+height`).toBeLessThanOrEqual(1);
      }
    });

    it("drops an off-screen node sitting directly under a window", () => {
      const tree = parseHarmonyLayout(
        root([
          node({ type: "root", bundleName: "com.app", bounds: "[0,0][1216,2688]" }, [
            node({
              type: "Button",
              text: "GONE",
              bounds: "[0,-400][1216,-260]",
              clickable: "true",
            }),
            node({ type: "Button", text: "HERE", bounds: "[0,100][1216,240]", clickable: "true" }),
          ]),
        ]),
        SCREEN
      ).tree;
      expect(tree.children[0].children.map((c) => c.label)).toEqual(["HERE"]);
    });

    it("does not drop a zero-size container that still holds a visible child", () => {
      const tree = parseHarmonyLayout(
        root([
          node({ type: "root", bundleName: "com.app", bounds: "[0,0][1216,2688]" }, [
            node({ type: "Dialog", bounds: "[0,0][0,0]" }, [
              node({ type: "Text", text: "Inside", bounds: "[0,1000][1216,1140]" }),
            ]),
          ]),
        ]),
        SCREEN
      ).tree;
      const labels: string[] = [];
      const walk = (n: DescribeNode) => {
        if (n.label) labels.push(n.label);
        n.children.forEach(walk);
      };
      walk(tree);
      expect(labels).toContain("Inside");
    });

    it("leaves a fully on-screen row exactly as measured", () => {
      const [visible] = rows([["VISIBLE", "[0,1000][1216,1140]"]]);
      expect(visible.frame.y).toBeCloseTo(1000 / 2688, 6);
      expect(visible.frame.height).toBeCloseTo(140 / 2688, 6);
      expect(visible.frame.width).toBe(1);
    });
  });
});
