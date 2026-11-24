import { describe, expect, it, vi } from "vitest";
import { createRegistry } from "../src/utils/setup-registry";
import { renderFlagGated } from "../src/utils/flag-gated-text";
import { MACOS_APPS_FLAG } from "../src/utils/capability";
import { gestureTapTool } from "../src/tools/gesture-tap";
import { directiveCommandHint } from "../src/tools/flows/flow-add-step";
import { advertisedSchema, definitionsById } from "./helpers/catalog";

vi.mock("@argent/configuration-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@argent/configuration-core")>();
  return { ...actual, isFlagEnabled: vi.fn(() => false), isFeatureEnabled: vi.fn(() => false) };
});

// "macOS host" is the Android emulator's host, and stop-metro's "On macOS
// another user's listener" is the host's netstat: neither is a Mac app.
const MAC_TEXT = /\bmac\b|\bmacos\b(?! host| another user's)|macosapp|appkit/i;

// Asserted over the whole catalog, so Mac app text added to any tool without
// its flag span fails here.
describe("Mac app text with the macos-apps flag off", () => {
  const rendered = [...definitionsById(createRegistry())]
    .filter(([, def]) => def.featureFlag !== MACOS_APPS_FLAG)
    .map(([id, def]) => ({
      id,
      text: renderFlagGated(
        {
          description: def.description,
          inputSchema: advertisedSchema(def),
          outputHint: def.outputHint,
          searchHint: def.searchHint,
        },
        () => false
      ),
    }));

  it("is absent from the advertised catalog", () => {
    const leaking = rendered
      .filter(({ text }) => MAC_TEXT.test(JSON.stringify(text)))
      .map(({ id }) => id);
    expect(leaking).toEqual([]);
  });

  it("is absent from the right-click refusal and the directive hints", async () => {
    const refusal = await gestureTapTool
      .execute({} as never, { udid: "emulator-5554", x: 0.5, y: 0.5, button: "right" })
      .catch((e: Error) => e.message);
    expect(refusal).toMatch(/right-click/);
    for (const text of [
      refusal,
      directiveCommandHint("swipe"),
      directiveCommandHint("scroll-to"),
    ]) {
      expect(text).not.toMatch(MAC_TEXT);
    }
  });
});

describe("Mac app text with the macos-apps flag on", () => {
  const definitions = definitionsById(createRegistry());

  // e2e recording on a Mac app records restart-app as the launch step, so its
  // description must say what the Mac branch does and returns.
  it.each(["launch-app", "restart-app"])("%s names Mac apps and their result fields", (id) => {
    const text = renderFlagGated(definitions.get(id)!.description, (f) => f === MACOS_APPS_FLAG);
    expect(text).toMatch(/Mac app/);
    expect(text).toMatch(/appPath\?, args\?/);
  });
});

const catalog = definitionsById(createRegistry());

/** A tool's description and input properties as GET /tools renders them. */
function advertised(id: string, flagOn: boolean) {
  const def = catalog.get(id)!;
  const text = renderFlagGated(
    { description: def.description, inputSchema: advertisedSchema(def) },
    (f) => flagOn && f === MACOS_APPS_FLAG
  );
  const schema = text.inputSchema as {
    properties: Record<string, { description: string; enum?: string[] }>;
  };
  return { description: text.description, properties: schema.properties };
}

describe("the native profiler tools' Mac app text", () => {
  it.each([
    "native-profiler-start",
    "native-profiler-stop",
    "native-profiler-analyze",
    "profiler-stack-query",
  ])("%s takes a Mac app id only with the flag on", (id) => {
    expect(advertised(id, true).properties.device_id!.description).toMatch(
      /UDID, Mac app id or Android serial/
    );
    const off = advertised(id, false);
    // The sentence still reads without the span.
    expect(off.properties.device_id!.description).toMatch(/UDID or Android serial/);
    expect(JSON.stringify(off)).not.toMatch(MAC_TEXT);
  });

  it.each(["native-profiler-start", "native-profiler-stop", "native-profiler-analyze"])(
    "%s names Mac apps as an xctrace platform only with the flag on",
    (id) => {
      expect(advertised(id, true).description).toMatch(/iOS and Mac apps/);
      expect(advertised(id, false).description).not.toMatch(/Mac app/);
    }
  );
});

describe("the JS debugger and network tools' Mac app text", () => {
  it.each([
    "debugger-connect",
    "debugger-status",
    "debugger-evaluate",
    "debugger-log-registry",
    "debugger-component-tree",
    "debugger-inspect-element",
    "debugger-reload-metro",
    "view-network-logs",
    "view-network-request-details",
  ])("%s names the Mac app ID only with the flag on", (id) => {
    expect(advertised(id, true).properties.device_id!.description).toMatch(/Mac app id/);
    expect(JSON.stringify(advertised(id, false))).not.toMatch(MAC_TEXT);
  });

  it("debugger-inspect-element says where a Mac app's points start only with the flag on", () => {
    for (const axis of ["x", "y"]) {
      expect(advertised("debugger-inspect-element", true).properties[axis]!.description).toMatch(
        /title bar included/
      );
    }
  });
});

describe("the React profiler tools' Mac app text", () => {
  it.each([
    "react-profiler-start",
    "react-profiler-stop",
    "react-profiler-status",
    "react-profiler-analyze",
    "react-profiler-fiber-tree",
    "react-profiler-renders",
    "react-profiler-cpu-summary",
    "profiler-cpu-query",
    "profiler-commit-query",
    "profiler-combined-report",
  ])("%s documents the Mac app ID only with the flag on", (id) => {
    const on = advertised(id, true).properties.device_id!.description;
    expect(on).toMatch(/Mac app/);
    expect(on).toContain("list-devices");
    expect(on).not.toContain("debugger-connect");
    expect(JSON.stringify(advertised(id, false))).not.toMatch(MAC_TEXT);
  });

  it("includes Mac Catalyst setup guidance only when Mac apps are enabled", () => {
    expect(advertised("react-profiler-start", true).description).toContain("Mac Catalyst");
    expect(advertised("react-profiler-start", false).description).not.toContain("Mac Catalyst");
  });

  it("react-profiler-analyze offers the macos platform only with the flag on", () => {
    expect(advertised("react-profiler-analyze", true).properties.platform).toMatchObject({
      type: "string",
      enum: ["ios", "android", "macos"],
    });
    expect(advertised("react-profiler-analyze", false).properties.platform).toMatchObject({
      type: "string",
      enum: ["ios", "android"],
    });
  });
});
