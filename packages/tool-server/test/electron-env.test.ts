import { describe, it, expect, afterEach } from "vitest";
import { electronGuiChildEnv } from "../src/utils/electron-env";

describe("electronGuiChildEnv", () => {
  const prev = process.env.ELECTRON_RUN_AS_NODE;
  afterEach(() => {
    if (prev === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = prev;
  });

  it("removes ELECTRON_RUN_AS_NODE inherited from the parent env", () => {
    process.env.ELECTRON_RUN_AS_NODE = "1";
    expect(electronGuiChildEnv().ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it("is a no-op for that key when the parent never set it", () => {
    delete process.env.ELECTRON_RUN_AS_NODE;
    expect("ELECTRON_RUN_AS_NODE" in electronGuiChildEnv()).toBe(false);
  });

  it("layers overrides on top and never lets an override re-introduce Node mode", () => {
    process.env.ELECTRON_RUN_AS_NODE = "1";
    // The delete runs AFTER the overrides spread, so even an override that
    // explicitly re-sets the flag cannot bring Node mode back. This asserts the
    // ordering, not just the parent-env strip.
    const env = electronGuiChildEnv({
      ARGENT_PREVIEW_URL: "http://x/preview/",
      ELECTRON_RUN_AS_NODE: "1",
    });
    expect(env.ARGENT_PREVIEW_URL).toBe("http://x/preview/");
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it("preserves other inherited env vars", () => {
    process.env.__ARGENT_ENV_TEST__ = "keep-me";
    try {
      expect(electronGuiChildEnv().__ARGENT_ENV_TEST__).toBe("keep-me");
    } finally {
      delete process.env.__ARGENT_ENV_TEST__;
    }
  });
});
