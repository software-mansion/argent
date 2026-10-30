import { describe, expect, it, vi } from "vitest";
import { createRegistry } from "../src/utils/setup-registry";
import { renderFlagGated } from "../src/utils/flag-gated-text";
import { MACOS_APPS_FLAG } from "../src/utils/capability";
import { gestureTapTool } from "../src/tools/gesture-tap";
import { directiveCommandHint } from "../src/tools/flows/flow-add-step";
import { advertisedSchema, definitionsById } from "./helpers/catalog";

vi.mock("@argent/configuration-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@argent/configuration-core")>();
  return { ...actual, isFlagEnabled: vi.fn(() => false) };
});

const MAC_TEXT = /mac app|macos-app|macosapp|"macos"|appkit/i;

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
