import { describe, it, expect } from "vitest";
import {
  classifyDevice,
  electronIdFromPort,
  parseElectronCdpPort,
  resolveDevice,
} from "../src/utils/device-info";

describe("classifyDevice (electron)", () => {
  it("classifies electron-cdp-<port> ids as electron", () => {
    expect(classifyDevice("electron-cdp-9222")).toBe("electron");
    expect(classifyDevice("electron-cdp-1024")).toBe("electron");
  });

  it("does not confuse electron with android adb serials", () => {
    expect(classifyDevice("emulator-5554")).toBe("android");
    expect(classifyDevice("electron-cdp-9222")).not.toBe("android");
  });

  it("does not confuse electron with iOS UDIDs", () => {
    expect(classifyDevice("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")).toBe("ios");
  });
});

describe("resolveDevice (electron)", () => {
  it("returns electron+app for a CDP id", () => {
    const d = resolveDevice("electron-cdp-19222");
    expect(d.platform).toBe("electron");
    expect(d.kind).toBe("app");
    expect(d.id).toBe("electron-cdp-19222");
  });
});

describe("parseElectronCdpPort", () => {
  it("extracts the numeric port", () => {
    expect(parseElectronCdpPort("electron-cdp-9222")).toBe(9222);
    expect(parseElectronCdpPort("electron-cdp-65000")).toBe(65000);
  });
  it("returns null for non-electron ids", () => {
    expect(parseElectronCdpPort("emulator-5554")).toBeNull();
    expect(parseElectronCdpPort("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")).toBeNull();
  });
  it("returns null for malformed electron ids", () => {
    expect(parseElectronCdpPort("electron-cdp-")).toBeNull();
    expect(parseElectronCdpPort("electron-cdp-abc")).toBeNull();
    expect(parseElectronCdpPort("electron-cdp-99999")).toBeNull();
    expect(parseElectronCdpPort("electron-cdp-0")).toBeNull();
  });
});

describe("electronIdFromPort", () => {
  it("round-trips through parseElectronCdpPort", () => {
    const id = electronIdFromPort(19222);
    expect(id).toBe("electron-cdp-19222");
    expect(parseElectronCdpPort(id)).toBe(19222);
  });
});
