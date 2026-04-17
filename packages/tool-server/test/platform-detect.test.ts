import { describe, it, expect } from "vitest";
import { detectPlatform } from "../src/utils/platform-detect";

describe("detectPlatform", () => {
  it("recognizes the classic iOS UDID (8-4-4-4-12 hex)", () => {
    expect(detectPlatform("A1B2C3D4-E5F6-7890-ABCD-EF1234567890")).toBe("ios");
    expect(detectPlatform("00000000-0000-0000-0000-000000000000")).toBe("ios");
    // Any case works.
    expect(detectPlatform("abcdef12-3456-7890-abcd-ef1234567890")).toBe("ios");
  });

  it("recognizes the iOS 17+ short UDID (8-16 hex)", () => {
    expect(detectPlatform("00008030-001C25120C22802E")).toBe("ios");
    expect(detectPlatform("ffffffff-0000000000000000")).toBe("ios");
  });

  it("treats Android emulator serials as android", () => {
    expect(detectPlatform("emulator-5554")).toBe("android");
    expect(detectPlatform("emulator-5556")).toBe("android");
  });

  it("treats physical Android serials as android", () => {
    expect(detectPlatform("R5CT12345678")).toBe("android");
    expect(detectPlatform("HT7901A01234")).toBe("android");
  });

  it("treats Android network serials (host:port) as android", () => {
    expect(detectPlatform("192.168.1.50:5555")).toBe("android");
  });

  it("treats malformed or short ids as android (safe default — iOS simctl would reject them immediately anyway)", () => {
    expect(detectPlatform("ABC")).toBe("android");
    expect(detectPlatform("")).toBe("android");
    expect(detectPlatform("12345")).toBe("android");
  });

  it("does not misclassify a UDID with non-hex characters as iOS", () => {
    // Shape matches 8-4-4-4-12 but contains a non-hex char (G)
    expect(detectPlatform("GGGGGGGG-1111-2222-3333-444444444444")).toBe("android");
  });
});
