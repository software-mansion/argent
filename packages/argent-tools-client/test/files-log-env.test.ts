import { afterEach, describe, expect, it, vi } from "vitest";
import { filesLogEnabled } from "../src/flow-files.js";

describe("filesLogEnabled", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is off when neither variable is set", () => {
    vi.stubEnv("ARGENT_E2E_FILES_LOG", undefined);
    vi.stubEnv("ARGENT_FLOW_FILES_LOG", undefined);
    expect(filesLogEnabled()).toBe(false);
  });

  it("is on with ARGENT_E2E_FILES_LOG=1", () => {
    vi.stubEnv("ARGENT_E2E_FILES_LOG", "1");
    vi.stubEnv("ARGENT_FLOW_FILES_LOG", undefined);
    expect(filesLogEnabled()).toBe(true);
  });

  it("is on with the old name ARGENT_FLOW_FILES_LOG=1", () => {
    vi.stubEnv("ARGENT_E2E_FILES_LOG", undefined);
    vi.stubEnv("ARGENT_FLOW_FILES_LOG", "1");
    expect(filesLogEnabled()).toBe(true);
  });

  it("reads the new name first when both are set", () => {
    vi.stubEnv("ARGENT_E2E_FILES_LOG", "0");
    vi.stubEnv("ARGENT_FLOW_FILES_LOG", "1");
    expect(filesLogEnabled()).toBe(false);
  });
});
