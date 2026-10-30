import { describe, expect, it, vi } from "vitest";
import type { Registry } from "@argent/registry";
import { isFlagEnabled } from "@argent/configuration-core";
import { createBootDeviceTool } from "../src/tools/devices/boot-device";
import { createRegistry } from "../src/utils/setup-registry";
import { renderFlagGated } from "../src/utils/flag-gated-text";
import { HARMONY_FLAG } from "../src/utils/harmony-flag";
import { advertisedSchema, definitionsById } from "./helpers/catalog";

vi.mock("@argent/configuration-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@argent/configuration-core")>();
  return { ...actual, isFlagEnabled: vi.fn(() => false) };
});

const HARMONY_TEXT = /harmony|\bhdc\b|uitest|deveco/i;

// Asserted over the whole catalog, so HarmonyOS text added to any tool without
// its flag span fails here.
describe("HarmonyOS text in the advertised tool catalog", () => {
  const advertised = [...definitionsById(createRegistry())].map(([id, def]) => ({
    id,
    text: {
      description: def.description,
      inputSchema: advertisedSchema(def),
      outputHint: def.outputHint,
      searchHint: def.searchHint,
    },
  }));
  const render = (on: boolean) =>
    advertised.map(({ id, text }) => ({
      id,
      text: renderFlagGated(text, (flag) => on && flag === HARMONY_FLAG),
    }));

  it("is absent with the flag off", () => {
    const leaking = render(false)
      .filter(({ text }) => HARMONY_TEXT.test(JSON.stringify(text)))
      .map(({ id }) => id);
    expect(leaking).toEqual([]);
  });

  it("is present with the flag on, without leftover tags", () => {
    const rendered = render(true);
    const mentioning = rendered
      .filter(({ text }) => HARMONY_TEXT.test(JSON.stringify(text)))
      .map(({ id }) => id);
    expect(mentioning).toEqual(expect.arrayContaining(["list-devices", "boot-device", "describe"]));
    const tagged = rendered
      .filter(({ text }) => /<\/?flag:/.test(JSON.stringify(text)))
      .map(({ id }) => id);
    expect(tagged).toEqual([]);
  });

  it("gates boot-device's harmonyInstance property", () => {
    const props = (on: boolean) =>
      Object.keys(
        (
          render(on).find(({ id }) => id === "boot-device")!.text.inputSchema as {
            properties: Record<string, unknown>;
          }
        ).properties
      );
    expect(props(false)).not.toContain("harmonyInstance");
    expect(props(true)).toContain("harmonyInstance");
    expect(props(false)).toEqual(props(true).filter((name) => name !== "harmonyInstance"));
  });
});

describe("boot-device target-selection error", () => {
  const message = async (on: boolean) => {
    vi.mocked(isFlagEnabled).mockImplementation((flag) => on && flag === HARMONY_FLAG);
    const tool = createBootDeviceTool({} as Registry);
    const error = await tool.execute!({}, {}).catch((e: Error) => e);
    return (error as Error).message;
  };

  it("names harmonyInstance only with the flag on", async () => {
    expect(await message(false)).toBe(
      "Provide exactly one of `udid` (iOS), `avdName` (Android), `vvdImage` (Vega VVD), or `electronAppPath` (Electron)."
    );
    expect(await message(true)).toBe(
      "Provide exactly one of `udid` (iOS), `avdName` (Android), `vvdImage` (Vega VVD), `harmonyInstance` (HarmonyOS), or `electronAppPath` (Electron)."
    );
  });
});
