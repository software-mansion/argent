import { describe, expect, it, vi } from "vitest";
import { Registry } from "@argent/registry";
import { DependencyMissingError } from "../src/utils/check-deps";
import { vegaImpl } from "../src/tools/keyboard/platforms/vega";

/**
 * Vega injects every shape over `adb` — text through `inputd-cli send_text`, a
 * named key and the `clear` burst through `button_press` — so a missing adb must
 * fail with a 424 install hint rather than a spawn ENOENT.
 *
 * `clear` used to be the exception: it was refused whatever the host had
 * installed, so declaring `requires: ["adb"]` had `dispatchByPlatform` preflight
 * the check BEFORE the handler ran and told the caller to install a binary for a
 * capability that would never exist. Now that the burst is real, the
 * declaration is right for all three, and this file pins that it is back — and
 * that it fires for the clear.
 *
 * Its own file because the whole point is an adb that is NOT there, which means
 * mocking the dependency check for every test in the file.
 */
vi.mock("../src/utils/check-deps", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/check-deps")>();
  return {
    ...actual,
    ensureDeps: vi.fn(async (deps: readonly string[]) => {
      throw new actual.DependencyMissingError(
        deps as never,
        "Install the Android SDK platform-tools."
      );
    }),
  };
});

// A `amazon-`-prefixed serial is what `resolveDevice` classifies as vega, so the
// tool's own dispatch reaches the Vega branch — and its `requires` preflight —
// without a device being present.
const VEGA_SERIAL = "amazon-f0d5886551561990";

describe("keyboard on Vega — every shape reaches the device over adb", () => {
  it("declares adb, so the preflight runs above the handler", () => {
    // The declaration is what makes `dispatchByPlatform` check first. Asserted
    // structurally as well as behaviourally below, because a handler that
    // happened to call `ensureDep` itself would pass the rejections while
    // leaving the dispatcher's preflight off — which is the shape that
    // regressed here before.
    expect(vegaImpl.requires ?? []).toContain("adb");
  });

  it.each([
    ["text", { text: "hello" }],
    ["key", { key: "enter" }],
    ["clear", { clear: true }],
  ])("reports the missing adb for a `%s` request", async (_label, params) => {
    // Through the real tool, so what runs is the real dispatch: the preflight,
    // then the handler. Nothing reaches the device — a `clear` that slipped past
    // would try to spawn adb against a VVD that is not there.
    const { createKeyboardTool } = await import("../src/tools/keyboard");
    const tool = createKeyboardTool(new Registry());
    await expect(tool.execute({}, { udid: VEGA_SERIAL, ...params })).rejects.toBeInstanceOf(
      DependencyMissingError
    );
  });
});
