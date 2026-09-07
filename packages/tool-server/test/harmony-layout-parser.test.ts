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
    // The calculator labels every keypad Button `" "`. Without the trim each one
    // becomes a blank-labelled node that reads like a real, empty label.
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
    // A tree spanning an app and the status bar (always a separate sceneboard
    // window) is unreadable if both are anonymous stacks. The bundle rides as
    // `identifier`, NOT `label`: the shared matcher reads `label` as visible
    // text, and a full-screen node "named" `com.app` would poison every text
    // wait (`exists: {text:"app"}` true on every screen, a `text` wait for the
    // app's own name matching the window instead of its title).
    expect(tree.children[0].identifier).toBe("com.app");
    expect(tree.children[0].label).toBeUndefined();
  });

  // `role` is half of what an agent selects on (`await-ui-element {role}`, the
  // flow matchers), and it is derived from a type name the app author chose —
  // so a mapping quietly reverting to the `type || "Group"` default is invisible
  // in a rendered tree yet breaks every selector aimed at it. One row per arm.
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
    // The one arm that is not a lookup: the same ArkUI component is a switch or
    // a plain button depending on `checkable`, and only the switch has a state
    // an agent can assert.
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
    // ArkUI builds real buttons out of Stack/Row, so walking through every
    // container by type would delete tap targets.
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

  // ArkUI puts `.id()` and the state flags on whatever component the author
  // wrote, and that is routinely a plain `Column`/`Row`. Hoisting one away for
  // wearing a layout type takes the only copy of that id with it.
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
      // ArkUI has two automation strings, `.id()` and `.key()`, and a component
      // routinely carries only the second. The fixture above sets both to the
      // same value, so the `id` half alone satisfies it — dropping the `key`
      // fallback loses every such component's identifier silently, and swapping
      // the two makes `key` win a component that declares both.
      const identifierOf = (attrs: Record<string, string>): string | undefined =>
        wrapping(attrs).children[0].children[0].identifier;

      expect(identifierOf({ type: "Column", key: "wifi_key" })).toBe("wifi_key");
      expect(identifierOf({ type: "Column", id: "wifi_id", key: "wifi_key" })).toBe("wifi_id");
    });

    it("costs one attribute, not the whole tree, when a dump value is not a string", () => {
      // The dump is `JSON.parse`d and asserted to be all-strings — measured on
      // 6.1.1, promised by nothing. Unguarded, one numeric `description` threw a
      // bare TypeError out of the parser and took `describe` down with it.
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
      // `.accessibilityText()` on a composite row is the idiomatic way to name
      // one, and it lands on the `Column`/`Row` the author wrote. Hoisted away
      // for wearing a layout type, the row's name is gone from the tree
      // entirely — `await-ui-element {text}` and tap-by-label stop finding an
      // element that is plainly on screen. One label per source attribute,
      // since each reaches `label` by its own branch.
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
      // One flag per case, so each is pinned on its own rather than by an `id`
      // that would have kept the node regardless.
      const own = (attrs: Record<string, string>) => wrapping(attrs).children[0].children[0];
      expect(own({ type: "Row", enabled: "false" }).disabled).toBe(true);
      expect(own({ type: "Column", selected: "true" }).selected).toBe(true);
      expect(own({ type: "Stack", focused: "true" }).focused).toBe(true);
    });
  });

  // ArkUI sets `.id()` and the state flags on the OUTER component, so the
  // wrapper of a same-rect pair is often the only node that knows it. Collapsing
  // it away kept `clickable` and dropped the rest.
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
      // ArkUI's `Toggle` covers switches AND push-style buttons; only the
      // checkable ones are switches. Reporting both as `Switch` puts a plain
      // button beyond `await-ui-element {role:"Button"}`, and tells the agent a
      // control has an on/off state it does not have.
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
      // ArkUI labels the outer component and leaves the child a bare graphic —
      // `Button().accessibilityText("Submit")` over a full-bleed `Image`.
      // Collapsing onto the child drops the label entirely, so `describe` shows
      // an unnamed image and `await-ui-element {text:"Submit"}` can never match.
      const B = "[0,0][200,100]";
      const target = wrap(
        { type: "Button", clickable: "true", description: "Submit", bounds: B },
        { type: "Image", bounds: B }
      );

      expect(target.label).toBe("Submit");
      expect(target.role).toBe("Button");
    });

    it("does not collapse a multi-child wrapper onto its first child", () => {
      // A full-bleed background as child[0] is idiomatic ArkUI. Collapsing on it
      // returns the background alone and every sibling — here both price and
      // caption — disappears from the tree the agent reads.
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
      // Same x/y, a tenth of the area: an icon pinned to the top-left of its
      // row. Collapsing moves the reported frame — and with it the tap centre
      // the description tells the agent to compute — from (200,100) to (20,20).
      const target = wrap(
        { type: "Stack", clickable: "true", bounds: "[0,0][400,200]" },
        { type: "Image", bounds: "[0,0][40,40]" }
      );

      expect(target.role).toBe("Stack");
      expect(target.children).toHaveLength(1);
      expect(target.children[0].role).toBe("Image");
    });

    it("keeps a mapped wrapper role through the collapse", () => {
      // ArkUI puts the meaningful widget on the OUTER node (`ListItem` -> Cell)
      // and fills it with a bare layout child at identical bounds. Collapsing
      // onto the child's role reports the same row as `Row` or `Cell` depending
      // on where focus happens to sit.
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

    // Each case below carries ONLY the state under test - no `id` - so it pins
    // that flag specifically. With an identifier present too, any one of these
    // could be dropped from the guard and the case would still pass on the
    // identifier alone.
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
      // `checked` and `checkable` cover for each other on an on-switch, so the
      // off case is what pins `checkable` by itself.
      const B = "[0,0][200,100]";
      const target = wrap(
        { type: "Toggle", clickable: "true", checkable: "true", bounds: B },
        { type: "Image", bounds: B }
      );
      expect(target.checkable).toBe(true);
      expect(target.checked).toBeUndefined();
    });

    it("keeps a selected wrapper, and a focused one", () => {
      // Not a `Stack`: a layout container carrying neither a label nor one of
      // the interactive flags is hoisted away as scaffolding before the collapse
      // is ever reached, so it cannot exercise this guard.
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
    // A List reports negative bounds for rows above the viewport, and the
    // describe frame contract is closed over [0,1].
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
    // Every node carries `enabled`; a missing one means the dump shape changed,
    // and defaulting the other way would grey out the whole screen.
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
    // The app-selector / share sheet renders in another process and the dump
    // carries the node with no children. Emitting an empty container would tell
    // an agent the screen is empty when a dialog is covering it.
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
    // The matcher reads `label` as visible text, and a full-screen node whose
    // label is a sentence containing "system", "contents" or "screenshot" makes
    // `exists: {text: ...}` true on every screen a share sheet or app selector
    // covers - the same phantom-text problem that keeps the window bundle name
    // in `identifier`.
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
    // On HarmonyOS 6.1.1 the same node arrives WITH the full subtree — the
    // HUAWEI ID login sheet carries its TextInput and both Buttons (45 nodes
    // measured), and those targets are live (their geometry taps). Replacing it
    // with the placeholder discards the only controls that dismiss the sheet,
    // and `uitest screenCap` does not capture the surface either.
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
    // The subtree's own back Button is a real, tappable target — not swallowed
    // into a placeholder that says the screen is opaque.
    const back = tree.children[0].children[0].children.find((c) => c.label === "Back");
    expect(back).toMatchObject({ role: "Button", clickable: true });
  });

  it("does not let a window's bundle id read as visible text on the screen", () => {
    // Regression for the matcher poisoning: with the bundle on `label`, every
    // screen matched `exists: {text:"sceneboard"}` and a `text` wait for the
    // app's own name tied with its real title in reading order and lost.
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
    // The two are read at different instants; on a foldable that gap is enough
    // for an unfold to normalize every frame against the wrong axis.
    const { screen } = parseHarmonyLayout(node({ bounds: "[0,0][2200,2480]" }, []), SCREEN);
    expect(screen).toEqual({ width: 2200, height: 2480 });
  });

  it("falls back to the queried size when the root reports no bounds", () => {
    const { screen } = parseHarmonyLayout(node({}, []), SCREEN);
    expect(screen).toEqual(SCREEN);
  });

  // A List reports real off-screen bounds for its scrolled rows, so the frame
  // has to be clipped to the screen before it is normalized. Normalizing each
  // component on its own and clamping into [0,1] gave a row at [0,-400][1216,-260]
  // the frame y=0 height=0.052 — a full-width tap target at the top of the
  // screen, with the same frame as the row genuinely straddling that edge.
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
      // Clipping alone left these as zero-area `[clickable]` lines whose
      // documented tap centre is the status bar or the nav bar.
      const kept = rows([
        ["ABOVE", "[0,-400][1216,-260]"],
        ["BELOW", "[0,2888][1216,3028]"],
        ["RIGHT", "[1266,400][1456,540]"],
        ["VISIBLE", "[0,1000][1216,1140]"],
      ]);
      expect(kept.map((r) => r.label)).toEqual(["VISIBLE"]);
    });

    it("keeps only the visible slice of a row straddling an edge", () => {
      // 140px tall, 80px of it on screen. It must survive - it IS reachable -
      // and must not share the fully-off-screen row's fate or its old frame.
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
      // Every assertion below lives inside the loop, so an empty `kept` would
      // otherwise pass vacuously — and this is the only case pinning
      // `x + width <= 1` for a partially off-screen row.
      expect(kept.length, "rows kept after pruning").toBeGreaterThan(0);
      for (const row of kept) {
        const { x, y, width, height } = row.frame;
        expect(x + width, `${row.label}: x+width`).toBeLessThanOrEqual(1);
        expect(y + height, `${row.label}: y+height`).toBeLessThanOrEqual(1);
      }
    });

    it("drops an off-screen node sitting directly under a window", () => {
      // Windows are assembled separately from the recursive walk, so the same
      // pruning has to be applied there or it holds only below depth 1.
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
      // A degenerate wrapper survives `build` because it has children; pruning
      // it on its own frame would take the reachable child with it.
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
      // Assert the child survives ANYWHERE in the tree: pruning a zero-area
      // ancestor takes its whole subtree with it, wherever it sits.
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
