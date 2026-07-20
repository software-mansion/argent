import { describe, it, expect } from "vitest";
import { tvServiceRef } from "../src/tools/tv/tv-service";

const TVOS_UDID = "DDDDDDDD-DDDD-DDDD-DDDD-DDDDDDDDDDDD";
const ANDROID_SERIAL = "emulator-5556";

describe("tvServiceRef — platform routing", () => {
  it("routes an iOS-shaped UDID to the TvControl (Apple TV) service", () => {
    const ref = tvServiceRef(TVOS_UDID) as { urn: string };
    expect(ref.urn).toBe(`TvControl:${TVOS_UDID}`);
  });

  it("routes an Android serial to the AndroidTvControl service", () => {
    const ref = tvServiceRef(ANDROID_SERIAL) as { urn: string };
    expect(ref.urn).toBe(`AndroidTvControl:${ANDROID_SERIAL}`);
  });
});
