import { describe, expect, it, vi } from "vitest";
import type { DeviceInfo, Registry } from "@argent/registry";
import { FAILURE_CODES, FailureError, getFailureSignal } from "@argent/registry";
import type { AXTreeNode, AXTreeResponse } from "../../src/blueprints/ax-service";
import type { DescribeNode } from "../../src/tools/describe/contract";
import { adaptAxTree } from "../../src/tools/ui-tree/ios";
import {
  adaptIosUiTreeForFlows,
  queryIosSimulatorFlowTree,
  readIosSimulatorUiTree,
} from "../../src/tools/flows/flow-ios-tree";
import { evaluateCondition, findAll, selectorToFrame } from "../../src/utils/ui-tree-match";

const UDID = "00000000-0000-0000-0000-0000000000AB";
const device = { platform: "ios", id: UDID, udid: UDID, kind: "simulator" } as DeviceInfo;

function reply(nodes: AXTreeNode[], extra: Partial<AXTreeResponse> = {}): AXTreeResponse {
  return {
    alertVisible: false,
    screenFrame: { width: 402, height: 874 },
    nodes,
    truncated: false,
    foregroundApp: "com.example.app",
    interfaceOrientation: "portrait",
    treeVersion: 3,
    ...extra,
  };
}

function frame(x: number, y: number, width: number, height: number) {
  return { x, y, width, height };
}

/** A registry whose ax-service answers `tree` with `response` (or throws it). */
function registryWith(response: AXTreeResponse | Error, degraded = false): Registry {
  return {
    resolveService: vi.fn(async () => ({
      degraded,
      tree: async () => {
        if (response instanceof Error) throw response;
        return response;
      },
    })),
  } as unknown as Registry;
}

const leaves = (tree: DescribeNode) => tree.children.map((c) => c.label ?? c.identifier ?? c.role);

describe("iOS simulator flow tree projection", () => {
  const app: AXTreeNode = { index: 0, label: "App", bundleId: "com.example.app" };

  it("emits every element describe prints, flat under one root, with hoisted text", () => {
    const tree = adaptIosUiTreeForFlows(
      adaptAxTree(
        reply([
          app,
          { index: 1, parentIndex: 0, identifier: "card-grace", frame: frame(0, 0.1, 1, 0.2) },
          {
            index: 2,
            parentIndex: 1,
            label: "Grace",
            traits: ["staticText"],
            frame: frame(0.05, 0.12, 0.3, 0.05),
          },
          {
            index: 3,
            parentIndex: 1,
            label: "Edit",
            traits: ["button"],
            frame: frame(0.7, 0.12, 0.2, 0.05),
          },
          // An unlabelled group with no id is not addressable: no leaf, but its text hoists.
          { index: 4, parentIndex: 0, frame: frame(0, 0.4, 1, 0.1) },
          { index: 5, parentIndex: 4, label: "Footer", frame: frame(0.1, 0.42, 0.5, 0.05) },
        ])
      )
    );
    expect(tree.role).toBe("AXGroup");
    expect(tree.children.every((c) => c.children.length === 0)).toBe(true);
    expect(leaves(tree)).toEqual(["Grace", "Edit", "card-grace", "Footer"]);
    const card = tree.children.find((c) => c.identifier === "card-grace")!;
    expect(card.subtreeText).toBe("Grace Edit");
    expect(card.role).toBe("AXGroup");
    expect(tree.children[0]).toMatchObject({ role: "AXStaticText", label: "Grace" });
    expect(tree.children[1]).toMatchObject({ role: "AXButton", label: "Edit" });
  });

  it("keeps a button hanging outside a non-scrolling container's frame", () => {
    // A UIKit stack view reports a frame smaller than its children.
    const tree = adaptIosUiTreeForFlows(
      adaptAxTree(
        reply([
          app,
          { index: 1, parentIndex: 0, frame: frame(0.15, 0.48, 0.7, 0.13) },
          {
            index: 2,
            parentIndex: 1,
            label: "Fruits",
            identifier: "home-list-button",
            traits: ["button"],
            frame: frame(0.15, 0.655, 0.7, 0.058),
          },
        ])
      )
    );
    expect(leaves(tree)).toEqual(["Fruits"]);
  });

  it("drops covered subtrees and the app under an alert", () => {
    const tree = adaptIosUiTreeForFlows(
      adaptAxTree(
        reply(
          [
            { index: 0, label: "SpringBoard", bundleId: "com.apple.springboard" },
            {
              index: 1,
              parentIndex: 0,
              label: "Allow",
              traits: ["button"],
              frame: frame(0.2, 0.5, 0.6, 0.05),
            },
            { ...app, index: 2, covered: true },
            {
              index: 3,
              parentIndex: 2,
              label: "Login",
              traits: ["button"],
              frame: frame(0.2, 0.8, 0.6, 0.05),
              covered: true,
            },
            // A list whose second row is scrolled out of its frame.
            { index: 4, parentIndex: 2, identifier: "list", frame: frame(0, 0.2, 1, 0.2) },
            { index: 5, parentIndex: 4, label: "Row 1", frame: frame(0, 0.2, 1, 0.1) },
            { index: 6, parentIndex: 4, label: "Row 2", frame: frame(0, 0.5, 1, 0.1) },
          ],
          { alertVisible: true }
        )
      )
    );
    expect(leaves(tree)).toEqual(["Allow"]);
  });

  it("clips hidden rows but keeps the rest of the list", () => {
    const tree = adaptIosUiTreeForFlows(
      adaptAxTree(
        reply([
          app,
          {
            index: 1,
            parentIndex: 0,
            identifier: "list",
            elementType: 26,
            frame: frame(0, 0.2, 1, 0.2),
          },
          { index: 2, parentIndex: 1, label: "Row 1", frame: frame(0, 0.2, 1, 0.1) },
          { index: 3, parentIndex: 1, label: "Row 2", frame: frame(0, 0.5, 1, 0.1) },
        ])
      )
    );
    expect(leaves(tree)).toEqual(["Row 1", "list"]);
    const list = tree.children[1]!;
    expect(list.scrollable).toBe(true);
    // Scrolled-out text must not hoist.
    expect(list.subtreeText).toBe("Row 1");
  });

  it("clamps frames to the screen, drops the value of a password and keeps states", () => {
    const tree = adaptIosUiTreeForFlows(
      adaptAxTree(
        reply([
          app,
          {
            index: 1,
            parentIndex: 0,
            label: "Password",
            value: "•••",
            traits: ["textEntry", "secureTextEntry", "isEditing"],
            frame: frame(-0.1, 0.3, 1.2, 0.05),
          },
          {
            index: 2,
            parentIndex: 0,
            label: "Wi-Fi",
            value: "1",
            traits: ["toggleButton", "notEnabled", "selected"],
            frame: frame(0.8, 0.4, 0.15, 0.05),
          },
          // Entirely off screen: no leaf.
          { index: 3, parentIndex: 0, label: "Gone", frame: frame(1.2, 0.4, 0.5, 0.05) },
          // An empty input shows its placeholder as its value, as describe prints it.
          {
            index: 4,
            parentIndex: 0,
            label: "Display name",
            value: "e.g. Alice Lastname",
            placeholder: "e.g. Alice Lastname",
            hintShowing: true,
            traits: ["textEntry"],
            frame: frame(0.1, 0.6, 0.8, 0.05),
          },
        ])
      )
    );
    const [password, toggle, empty] = tree.children;
    expect(tree.children).toHaveLength(3);
    expect(empty).toMatchObject({ label: "Display name", value: "e.g. Alice Lastname" });
    expect(password).toMatchObject({
      role: "AXTextField",
      label: "Password",
      password: true,
      focused: true,
      frame: frame(0, 0.3, 1, 0.05),
    });
    expect(password!.value).toBeUndefined();
    expect(toggle).toMatchObject({
      role: "AXSwitch",
      checked: true,
      disabled: true,
      selected: true,
    });
  });

  it("keeps an empty secure field's placeholder as its text, never a typed secret", () => {
    const tree = adaptIosUiTreeForFlows(
      adaptAxTree(
        reply([
          app,
          {
            index: 1,
            parentIndex: 0,
            value: "Email",
            placeholder: "Email",
            hintShowing: true,
            traits: ["textEntry"],
            elementType: 49,
            frame: frame(0.1, 0.3, 0.8, 0.05),
          },
          {
            index: 2,
            parentIndex: 0,
            value: "Password",
            placeholder: "Password",
            hintShowing: true,
            traits: ["textEntry", "secureTextEntry"],
            elementType: 50,
            frame: frame(0.1, 0.4, 0.8, 0.05),
          },
          {
            index: 3,
            parentIndex: 0,
            value: "••••",
            placeholder: "PIN",
            traits: ["textEntry", "secureTextEntry"],
            elementType: 50,
            frame: frame(0.1, 0.5, 0.8, 0.05),
          },
        ])
      )
    );
    expect(selectorToFrame(tree, { text: "Email" })).toEqual(frame(0.1, 0.3, 0.8, 0.05));
    expect(selectorToFrame(tree, { text: "Password" })).toEqual(frame(0.1, 0.4, 0.8, 0.05));
    const filled = tree.children[2]!;
    expect(filled.password).toBe(true);
    expect(filled.value).toBeUndefined();
  });

  it("drops a scroll indicator from the leaves and the hoisted text, but keeps sliders", () => {
    const tree = adaptIosUiTreeForFlows(
      adaptAxTree(
        reply([
          app,
          { index: 1, parentIndex: 0, elementType: 26, frame: frame(0, 0.1, 1, 0.8) },
          {
            index: 2,
            parentIndex: 1,
            label: "Haptic Feedback",
            traits: ["staticText"],
            elementType: 48,
            frame: frame(0.09, 0.2, 0.3, 0.03),
          },
          // UIKit's indicator: an unnamed adjustable element in the scroller.
          {
            index: 3,
            parentIndex: 1,
            label: "Vertical scroll bar, 3 pages",
            value: "0%",
            traits: ["adjustable"],
            elementType: 0,
            frame: frame(0.918, 0.133, 0.075, 0.7),
          },
          { index: 4, parentIndex: 3, elementType: 0, frame: frame(0.985, 0.136, 0.007, 0.4) },
          // A slider in a row of the list.
          { index: 5, parentIndex: 1, elementType: 75, frame: frame(0.05, 0.3, 0.9, 0.06) },
          {
            index: 6,
            parentIndex: 5,
            label: "Volume",
            value: "50%",
            traits: ["adjustable"],
            elementType: 0,
            frame: frame(0.1, 0.31, 0.8, 0.04),
          },
          // Sliders placed in the scroller itself: a UISlider, and a custom
          // control with a second trait.
          {
            index: 7,
            parentIndex: 1,
            label: "Brightness",
            value: "20%",
            traits: ["adjustable"],
            elementType: 33,
            frame: frame(0.1, 0.4, 0.8, 0.04),
          },
          {
            index: 8,
            parentIndex: 1,
            label: "Contrast",
            value: "70%",
            traits: ["adjustable", "notEnabled"],
            elementType: 0,
            frame: frame(0.1, 0.5, 0.8, 0.04),
          },
          // An app's own adjustable view with an id, of the indicator's shape.
          {
            index: 9,
            parentIndex: 1,
            identifier: "rating",
            label: "Rating",
            value: "3 stars",
            traits: ["adjustable"],
            elementType: 0,
            frame: frame(0.1, 0.6, 0.8, 0.04),
          },
        ])
      )
    );
    expect(leaves(tree)).toEqual([
      "Haptic Feedback",
      "Volume",
      "Brightness",
      "Contrast",
      "Rating",
      "AXGroup",
    ]);
    expect(tree.children.filter((c) => c.role === "AXAdjustable").map((c) => c.label)).toEqual([
      "Volume",
      "Brightness",
      "Contrast",
      "Rating",
    ]);
    const list = tree.children.find((c) => c.scrollable)!;
    // The rating's id shields its text from the scroller.
    expect(list.subtreeText).toBe("Haptic Feedback Volume 50% Brightness 20% Contrast 70%");
  });

  it("reads a switch row's text without the switch's 0/1 state", () => {
    // Settings > Keyboards: a toggle row (id, label, value) over a title and
    // the switch itself, which carries only the value.
    const settings = (value: "0" | "1") =>
      adaptIosUiTreeForFlows(
        adaptAxTree(
          reply([
            app,
            {
              index: 1,
              parentIndex: 0,
              identifier: "KeyboardVisceral",
              label: "Haptic Feedback",
              value,
              traits: ["button", "staticText", "toggleButton"],
              elementType: 40,
              frame: frame(0.05, 0.4, 0.9, 0.06),
            },
            {
              index: 2,
              parentIndex: 1,
              identifier: "KeyboardVisceral",
              label: "Haptic Feedback",
              traits: ["button", "staticText"],
              elementType: 9,
              frame: frame(0.09, 0.41, 0.3, 0.04),
            },
            {
              index: 3,
              parentIndex: 1,
              value,
              traits: ["button", "toggleButton"],
              elementType: 40,
              frame: frame(0.76, 0.41, 0.16, 0.04),
            },
          ])
        )
      );
    for (const value of ["0", "1"] as const) {
      const tree = settings(value);
      const row = findAll(tree, { identifier: "KeyboardVisceral", role: "AXSwitch" });
      expect(row).toHaveLength(1);
      expect(row[0]!.subtreeText).toBe("Haptic Feedback");
      expect(evaluateCondition("text", "Haptic Feedback", row, "equals")).toBe(true);
      // The state stays readable on the row and on the bare switch.
      expect(evaluateCondition("text", `Haptic Feedback ${value}`, row, "equals")).toBe(true);
      const bare = tree.children.filter((c) => c.role === "AXSwitch" && !c.identifier);
      expect(evaluateCondition("text", value, bare, "equals")).toBe(true);
    }
  });

  it("keeps the system keyboard's key text, so a describe-copied key selector hits the key", () => {
    const tree = adaptIosUiTreeForFlows(
      adaptAxTree(
        reply([
          app,
          {
            index: 1,
            parentIndex: 0,
            label: "Continue to next step",
            traits: ["button"],
            elementType: 9,
            frame: frame(0.05, 0.5, 0.9, 0.06),
          },
          {
            index: 2,
            parentIndex: 0,
            // The system keyboard (XCUIElementTypeKeyboard), as iOS 26 reports it.
            identifier: "UIKeyboardLayoutStar Preview",
            elementType: 19,
            frame: frame(0, 0.6, 1, 0.4),
          },
          {
            index: 3,
            parentIndex: 2,
            label: "Typing Predictions",
            elementType: 0,
            frame: frame(0, 0.6, 1, 0.05),
          },
          {
            index: 4,
            parentIndex: 2,
            label: "next",
            identifier: "Next:",
            traits: ["button", "keyboardKey"],
            elementType: 20,
            frame: frame(0.75, 0.9, 0.24, 0.05),
          },
          {
            index: 5,
            parentIndex: 2,
            label: "e",
            traits: ["keyboardKey"],
            elementType: 20,
            frame: frame(0.21, 0.7, 0.1, 0.05),
          },
        ])
      )
    );
    // Dropping the keys' text sent `text: e` to "Typing Predictions" by substring.
    expect(selectorToFrame(tree, { text: "e" })).toEqual(frame(0.21, 0.7, 0.1, 0.05));
    // The exact-text ranking picks the return key over a button containing the word.
    expect(selectorToFrame(tree, { text: "next" })).toEqual(frame(0.75, 0.9, 0.24, 0.05));
    expect(selectorToFrame(tree, { text: "Continue to next step" })).toEqual(
      frame(0.05, 0.5, 0.9, 0.06)
    );
  });
});

describe("queryIosSimulatorFlowTree", () => {
  const screen = (extra: Partial<AXTreeResponse> = {}) =>
    reply(
      [
        { index: 0, label: "App", bundleId: "com.example.app" },
        {
          index: 1,
          parentIndex: 0,
          label: "Continue",
          traits: ["button"],
          frame: frame(0, 0.5, 1, 0.1),
        },
      ],
      extra
    );

  it("reads the ax-service tree as source ax-service with the screen size", async () => {
    const data = await queryIosSimulatorFlowTree(registryWith(screen()), device);
    expect(data.source).toBe("ax-service");
    expect(data.screen).toEqual({ width: 402, height: 874 });
    expect(data.uiOrientation).toBe("portrait");
    expect(data.tree.children.map((c) => c.label)).toEqual(["Continue"]);
  });

  it("reports the interface orientation and leaves the frames in the portrait-native space", async () => {
    const data = await queryIosSimulatorFlowTree(
      registryWith(screen({ interfaceOrientation: "landscapeRight" })),
      device
    );
    expect(data.uiOrientation).toBe("landscapeRight");
    expect(data.tree.children[0]!.frame).toEqual(frame(0, 0.5, 1, 0.1));
  });

  it("fails a pinned read when another app is in the foreground", async () => {
    await expect(
      queryIosSimulatorFlowTree(
        registryWith(screen({ foregroundApp: "com.apple.springboard" })),
        device,
        {
          bundleId: "com.example.app",
          pinned: true,
        }
      )
    ).rejects.toThrow(
      /com\.example\.app is not the foreground app .*com\.apple\.springboard is.*crashed/
    );
    // A read that names no foreground app cannot show the pinned app is in front.
    await expect(
      queryIosSimulatorFlowTree(registryWith(screen({ foregroundApp: undefined })), device, {
        bundleId: "com.example.app",
        pinned: true,
      })
    ).rejects.toThrow(/com\.example\.app is not the foreground app .*\(no app is\)/);
    // Unpinned, the id is only a hint.
    await expect(
      queryIosSimulatorFlowTree(
        registryWith(screen({ foregroundApp: "com.apple.springboard" })),
        device,
        {
          bundleId: "com.example.app",
          pinned: false,
        }
      )
    ).resolves.toBeDefined();
  });

  it("names the update remedy when the daemon predates tree, the foreground app or the orientation", async () => {
    const old = new FailureError("ax-service predates `tree`; update argent", {
      error_code: FAILURE_CODES.AX_TREE_UNSUPPORTED,
      failure_stage: "ax_service_tree",
      failure_area: "tool_server",
      error_kind: "unknown",
    });
    await expect(queryIosSimulatorFlowTree(registryWith(old), device)).rejects.toThrow(
      /predates `tree`.*update argent.*argent server stop/
    );
    await expect(
      readIosSimulatorUiTree(
        registryWith(screen({ treeVersion: 1, foregroundApp: undefined })),
        device
      )
    ).rejects.toThrow(/names no foreground app.*update argent/);
    // treeVersion 2 names the foreground app but not the interface orientation.
    const err = await queryIosSimulatorFlowTree(
      registryWith(screen({ treeVersion: 2, interfaceOrientation: undefined })),
      device
    ).catch((e: unknown) => e);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.AX_TREE_UNSUPPORTED);
    expect((err as Error).message).toMatch(
      /names no foreground app or interface orientation\. .*update argent.*argent server stop/
    );
  });

  it("names boot-device when the service cannot be reached and the settle remedy on a timeout", async () => {
    const dead = {
      resolveService: vi.fn(async () => {
        throw new Error("simulator not booted");
      }),
    };
    await expect(queryIosSimulatorFlowTree(dead as unknown as Registry, device)).rejects.toThrow(
      /could not be read: simulator not booted\. Boot the simulator with `boot-device`/
    );
    const slow = new FailureError("ax-service query timed out: tree", {
      error_code: FAILURE_CODES.AX_QUERY_TIMEOUT,
      failure_stage: "ax_service_query",
      failure_area: "tool_server",
      error_kind: "timeout",
    });
    await expect(queryIosSimulatorFlowTree(registryWith(slow), device)).rejects.toThrow(
      /timed out.*took too long to read/
    );
  });

  it("returns a walk the service cut short, flagged truncated", async () => {
    const data = await queryIosSimulatorFlowTree(registryWith(screen({ truncated: true })), device);
    expect(data.truncated).toBe(true);
    expect(leaves(data.tree)).toEqual(["Continue"]);
    expect((await queryIosSimulatorFlowTree(registryWith(screen()), device)).truncated).toBe(
      undefined
    );
  });

  it("refuses a blind read, naming the boot remedy on a simulator argent did not boot", async () => {
    const empty = reply([{ index: 0, label: "App", bundleId: "com.example.app" }]);
    await expect(queryIosSimulatorFlowTree(registryWith(empty, true), device)).rejects.toThrow(
      /is empty: argent did not boot this simulator.*boot-device/
    );
    await expect(queryIosSimulatorFlowTree(registryWith(empty), device)).rejects.toThrow(
      /is empty: the foreground app \(com\.example\.app\) exposes no accessible elements.*restart-app/
    );
  });
});
