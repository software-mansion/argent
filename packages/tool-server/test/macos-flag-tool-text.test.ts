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

describe("the native profiler tools' Mac app text", () => {
  const definitions = definitionsById(createRegistry());

  function advertised(id: string, flagOn: boolean) {
    const def = definitions.get(id)!;
    const text = renderFlagGated(
      { description: def.description, inputSchema: advertisedSchema(def) },
      (f) => flagOn && f === MACOS_APPS_FLAG
    );
    const schema = text.inputSchema as { properties: Record<string, { description: string }> };
    return { description: text.description, properties: schema.properties };
  }

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

  it("native-profiler-start says what app_process, malloc_stack_logging and its warning do on a Mac app", () => {
    const on = advertised("native-profiler-start", true);
    expect(on.properties.app_process!.description).toMatch(/Not used for a Mac app/);
    expect(on.properties.malloc_stack_logging!.description).toMatch(
      /On a Mac app, argent restarts the app with MallocStackLogging=1 and then attaches/
    );
    expect(on.properties.template_path!.description).toMatch(/^iOS and Mac apps only\./);
    expect(on.description).toMatch(/On a Mac app, a warning says when the app runs with malloc/);

    const off = advertised("native-profiler-start", false);
    expect(off.properties.app_process!.description).toMatch(/picks the wrong app\.$/);
    expect(off.properties.malloc_stack_logging!.description).toMatch(/^iOS only\..*no leaks\.$/s);
    expect(off.properties.template_path!.description).toMatch(/^iOS only\./);
  });

  it("profiler-stack-query names Mac apps for leak_stacks only with the flag on", () => {
    expect(advertised("profiler-stack-query", true).description).toMatch(
      /leak_stacks: Memory leak details \(iOS and Mac apps only\)/
    );
    expect(advertised("profiler-stack-query", false).description).toMatch(
      /leak_stacks: Memory leak details \(iOS only\)/
    );
  });

  it("profiler-load names Mac apps for load_native only with the flag on", () => {
    expect(advertised("profiler-load", true).description).toMatch(
      /load_native: .*\(xctrace XML on iOS and Mac apps, \.pftrace on Android\)/
    );
    const off = advertised("profiler-load", false);
    expect(off.description).toMatch(/load_native: .*\(xctrace XML on iOS, \.pftrace on Android\)/);
    expect(JSON.stringify(off)).not.toMatch(MAC_TEXT);
  });
});
