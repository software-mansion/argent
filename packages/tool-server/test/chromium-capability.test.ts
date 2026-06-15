import { describe, it, expect } from "vitest";
import { assertSupported, UnsupportedOperationError } from "../src/utils/capability";
import { resolveDevice } from "../src/utils/device-info";
import type { ToolCapability } from "@argent/registry";

const chromiumDevice = resolveDevice("chromium-cdp-19222");
const iosDevice = resolveDevice("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA");

describe("assertSupported (chromium)", () => {
  it("accepts a chromium device when capability declares chromium.app", () => {
    const cap: ToolCapability = { chromium: { app: true } };
    expect(() => assertSupported("test", cap, chromiumDevice)).not.toThrow();
  });

  it("rejects a chromium device when capability omits chromium", () => {
    const cap: ToolCapability = { apple: { simulator: true } };
    expect(() => assertSupported("test", cap, chromiumDevice)).toThrow(UnsupportedOperationError);
  });

  it("rejects an iOS device when capability declares only chromium", () => {
    const cap: ToolCapability = { chromium: { app: true } };
    expect(() => assertSupported("test", cap, iosDevice)).toThrow(UnsupportedOperationError);
  });

  it("rejects a chromium device when chromium block is empty (kind 'app' not enabled)", () => {
    const cap: ToolCapability = { chromium: {} };
    expect(() => assertSupported("test", cap, chromiumDevice)).toThrow(UnsupportedOperationError);
  });
});
