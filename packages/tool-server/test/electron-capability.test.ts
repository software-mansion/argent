import { describe, it, expect } from "vitest";
import { assertSupported, UnsupportedOperationError } from "../src/utils/capability";
import { resolveDevice } from "../src/utils/device-info";
import type { ToolCapability } from "@argent/registry";

const electronDevice = resolveDevice("electron-cdp-19222");
const iosDevice = resolveDevice("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA");

describe("assertSupported (electron)", () => {
  it("accepts an electron device when capability declares electron.app", () => {
    const cap: ToolCapability = { electron: { app: true } };
    expect(() => assertSupported("test", cap, electronDevice)).not.toThrow();
  });

  it("rejects an electron device when capability omits electron", () => {
    const cap: ToolCapability = { apple: { simulator: true } };
    expect(() => assertSupported("test", cap, electronDevice)).toThrow(UnsupportedOperationError);
  });

  it("rejects an iOS device when capability declares only electron", () => {
    const cap: ToolCapability = { electron: { app: true } };
    expect(() => assertSupported("test", cap, iosDevice)).toThrow(UnsupportedOperationError);
  });

  it("rejects an electron device when electron block is empty (kind 'app' not enabled)", () => {
    const cap: ToolCapability = { electron: {} };
    expect(() => assertSupported("test", cap, electronDevice)).toThrow(UnsupportedOperationError);
  });
});
