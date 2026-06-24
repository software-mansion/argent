import { describe, it, expect } from "vitest";
import { filterVvdShadowsFromAndroid } from "../src/utils/vega-devices";

describe("filterVvdShadowsFromAndroid", () => {
  const android = [
    { serial: "emulator-5554" }, // the VVD shadow
    { serial: "emulator-5556" }, // a genuine standalone Android emulator
  ];

  it("drops only the rows whose adb serial was resolved to a VVD", () => {
    const out = filterVvdShadowsFromAndroid(android, new Set(["emulator-5554"]));
    expect(out).toEqual([{ serial: "emulator-5556" }]);
  });

  it("leaves the list untouched when no VVD shadows were resolved", () => {
    expect(filterVvdShadowsFromAndroid(android, new Set())).toEqual(android);
  });
});
