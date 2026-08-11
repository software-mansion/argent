import { describe, expect, it, vi, beforeEach } from "vitest";
import type { DeviceInfo, Registry } from "@argent/registry";
import { UnsupportedOperationError } from "../src/utils/capability";

// The only collaborator: resolving the focus-driven TV control backend. Stub it
// so the `key` rejection can be observed as "never reached the service".
const { resolveTvApi } = vi.hoisted(() => ({ resolveTvApi: vi.fn() }));
vi.mock("../src/tools/tv/tv-service", () => ({ resolveTvApi }));

import { typeTv } from "../src/tools/keyboard/platforms/tv";

const APPLE_TV: DeviceInfo = { id: "TV-UDID", platform: "ios", kind: "simulator" };
const ANDROID_TV: DeviceInfo = { id: "emulator-5554", platform: "android", kind: "emulator" };

const registry = {} as Registry;

// `typeTv` was reachable only through `vi.mock` stubs — `keyboard-android.test.ts`
// replaces the whole module — so nothing exercised the real one. Deleting its
// `key` rejection outright (plus the now-unused import) typechecked and left the
// whole suite byte-identical at 296 files / 3088 tests.
//
// That guard is load-bearing beyond its own file: `flow-actions.ts`'s `runType`
// splits "type, then submit" into two keyboard calls precisely BECAUSE a TV
// target rejects `key` before typing, so a combined `{ text, key }` would throw
// with the field still empty. If the guard degraded to ignoring `key` instead of
// throwing, `keyboard { udid: <Apple TV / Android TV>, key: "enter" }` would
// answer `{ typed: "", keys: 0 }` — a success that pressed nothing — and that
// directive's submit would silently no-op on a still-filled field.
describe("typeTv — the TV keyboard backend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["Apple TV", APPLE_TV],
    ["Android TV", ANDROID_TV],
  ])("rejects a named key on %s, before resolving the TV service", async (_label, device) => {
    await expect(
      typeTv(registry, device, { udid: device.id, key: "enter" })
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    await expect(typeTv(registry, device, { udid: device.id, key: "enter" })).rejects.toThrow(
      /named keys are not supported on a TV target/
    );
    // Rejected outright, not after doing something: no backend was resolved.
    expect(resolveTvApi).not.toHaveBeenCalled();
  });

  it("rejects a COMBINED text+key call with nothing typed", async () => {
    // The exact shape `runType`'s two-call split exists to avoid: the rejection
    // must come before the text, or the flow comment's reasoning is wrong.
    await expect(
      typeTv(registry, ANDROID_TV, { udid: ANDROID_TV.id, text: "hello", key: "enter" })
    ).rejects.toThrow(/named keys are not supported on a TV target/);
    expect(resolveTvApi).not.toHaveBeenCalled();
  });

  it("types text alone through the TV service (positive control)", async () => {
    // Without this the rejection tests above could pass against a backend that
    // does nothing at all.
    const type = vi.fn(async () => {});
    resolveTvApi.mockResolvedValue({ type });

    const result = await typeTv(registry, ANDROID_TV, { udid: ANDROID_TV.id, text: "hi there" });

    expect(type).toHaveBeenCalledWith("hi there");
    expect(result).toEqual({ typed: "hi there", keys: 8 });
  });

  it("counts `keys` by codepoint, not UTF-16 unit", async () => {
    // Matches the vega and simulator-server backends: a non-BMP char is one key.
    const type = vi.fn(async () => {});
    resolveTvApi.mockResolvedValue({ type });

    const result = await typeTv(registry, ANDROID_TV, { udid: ANDROID_TV.id, text: "a😀" });

    expect(result).toEqual({ typed: "a😀", keys: 2 });
  });

  it("no-ops on an empty request without resolving the service", async () => {
    const result = await typeTv(registry, ANDROID_TV, { udid: ANDROID_TV.id });

    expect(result).toEqual({ typed: "", keys: 0 });
    expect(resolveTvApi).not.toHaveBeenCalled();
  });
});
