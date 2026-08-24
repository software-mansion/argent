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
// `key` rejection outright (plus the now-unused import) typechecks and, with
// this file removed, leaves the rest of the suite byte-identical: same file and
// test counts, nothing red. Re-run it that way rather than trusting a recorded
// total — the count moves with every commit, so a stale figure reads as a
// failed reproduction.
//
// That guard is load-bearing beyond its own file. `flow-actions.ts`'s `runType`
// splits "type, then submit" into two keyboard calls, and on an Android TV the
// SECOND of them is the one that fails here — the text lands, the submit 400s.
// If the guard degraded to ignoring `key` instead of throwing, `keyboard
// { udid: <Apple TV / Android TV>, key: "enter" }` would answer
// `{ typed: "", keys: 0 }` — a success that pressed nothing — and that
// directive's submit would silently no-op on a still-filled field.
//
// The tool's own text/key exclusivity guard never reaches this backend, so it
// cannot stand in for this one: it runs above the platform dispatch and only
// sees requests carrying BOTH parameters, while what a TV rejects is `key` on
// its own. That is why the exclusivity message carries the TV caveat statically
// (keyboard-text-key-exclusive.test.ts) instead of relying on this rejection.
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

  it("rejects the key BEFORE typing any text it was also handed", async () => {
    // The tool rejects `{ text, key }` above the dispatch, so this shape does
    // not arrive from the tool — `blueprints/android-tv-control.ts` is the other
    // caller of this backend. What it pins is the ORDER inside `typeTv`: the
    // rejection comes first, so a request it refuses leaves the field untouched
    // rather than half-typed.
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

    // "Hi there", not "hi there": an all-lowercase fixture cannot separate
    // "hands the service the text it was given" from "hands it a case-folded
    // copy", and `typed` echoes the request rather than what `type` received.
    const result = await typeTv(registry, ANDROID_TV, { udid: ANDROID_TV.id, text: "Hi there" });

    expect(type).toHaveBeenCalledWith("Hi there");
    expect(result).toEqual({ typed: "Hi there", keys: 8 });
  });

  it("counts `keys` by codepoint, not UTF-16 unit", async () => {
    // Matches the vega and simulator-server backends: a non-BMP char is one key.
    //
    // APPLE_TV, not ANDROID_TV: the Android TV service runs
    // `assertTypeableAndroidText` (`blueprints/android-tv-control.ts:256`),
    // which 400s an emoji, so on a real Android TV this call cannot reach the
    // asserted result — the stubbed `resolveTvApi` is the only reason it does.
    // Apple TV rejects newlines alone (`blueprints/tv-control.ts:468-474`), so
    // the case is genuinely reachable there. The property itself is unaffected:
    // `typeTv` computes `[...text].length` before either service is involved.
    const type = vi.fn(async () => {});
    resolveTvApi.mockResolvedValue({ type });

    const result = await typeTv(registry, APPLE_TV, { udid: APPLE_TV.id, text: "A😀" });

    expect(type).toHaveBeenCalledWith("A😀");
    expect(result).toEqual({ typed: "A😀", keys: 2 });
  });

  it("no-ops on an empty request without resolving the service", async () => {
    const result = await typeTv(registry, ANDROID_TV, { udid: ANDROID_TV.id });

    expect(result).toEqual({ typed: "", keys: 0 });
    expect(resolveTvApi).not.toHaveBeenCalled();
  });
});
