import { describe, it, expect } from "vitest";
import { DISABLE_LOGBOX_SCRIPT } from "../../src/utils/debugger/scripts/disable-logbox";

describe("DISABLE_LOGBOX_SCRIPT", () => {
  it("calls LogBox.ignoreAllLogs(true) to gate the banner", () => {
    expect(DISABLE_LOGBOX_SCRIPT).toContain("ignoreAllLogs(true)");
  });

  it("does NOT call LBData.clear() — would dismiss an open fullscreen redbox", () => {
    expect(DISABLE_LOGBOX_SCRIPT).not.toContain(".clear()");
    expect(DISABLE_LOGBOX_SCRIPT).not.toContain("LBData.clear");
  });

  it("is wrapped in an IIFE", () => {
    expect(DISABLE_LOGBOX_SCRIPT.trim().startsWith("(function()")).toBe(true);
    expect(DISABLE_LOGBOX_SCRIPT.trim().endsWith("})()")).toBe(true);
  });
});
