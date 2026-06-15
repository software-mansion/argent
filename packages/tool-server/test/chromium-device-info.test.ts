import { describe, it, expect } from "vitest";
import {
  classifyDevice,
  chromiumIdFromPort,
  parseChromiumCdpPort,
  resolveDevice,
} from "../src/utils/device-info";

describe("classifyDevice (chromium)", () => {
  it("classifies chromium-cdp-<port> ids as chromium", () => {
    expect(classifyDevice("chromium-cdp-9222")).toBe("chromium");
    expect(classifyDevice("chromium-cdp-1024")).toBe("chromium");
  });

  it("does not confuse chromium with android adb serials", () => {
    expect(classifyDevice("emulator-5554")).toBe("android");
    expect(classifyDevice("chromium-cdp-9222")).not.toBe("android");
  });

  it("does not confuse chromium with iOS UDIDs", () => {
    expect(classifyDevice("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")).toBe("ios");
  });
});

describe("resolveDevice (chromium)", () => {
  it("returns chromium+app for a CDP id", () => {
    const d = resolveDevice("chromium-cdp-19222");
    expect(d.platform).toBe("chromium");
    expect(d.kind).toBe("app");
    expect(d.id).toBe("chromium-cdp-19222");
  });
});

describe("parseChromiumCdpPort", () => {
  it("extracts the numeric port", () => {
    expect(parseChromiumCdpPort("chromium-cdp-9222")).toBe(9222);
    expect(parseChromiumCdpPort("chromium-cdp-65000")).toBe(65000);
  });
  it("returns null for non-chromium ids", () => {
    expect(parseChromiumCdpPort("emulator-5554")).toBeNull();
    expect(parseChromiumCdpPort("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")).toBeNull();
  });
  it("returns null for malformed chromium ids", () => {
    expect(parseChromiumCdpPort("chromium-cdp-")).toBeNull();
    expect(parseChromiumCdpPort("chromium-cdp-abc")).toBeNull();
    expect(parseChromiumCdpPort("chromium-cdp-99999")).toBeNull();
    expect(parseChromiumCdpPort("chromium-cdp-0")).toBeNull();
  });
});

describe("chromiumIdFromPort", () => {
  it("round-trips through parseChromiumCdpPort", () => {
    const id = chromiumIdFromPort(19222);
    expect(id).toBe("chromium-cdp-19222");
    expect(parseChromiumCdpPort(id)).toBe(19222);
  });
});
