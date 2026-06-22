import { describe, expect, it } from "vitest";
import { _CI_VENDOR_COUNT_FOR_TEST, isCi } from "../src/ci-detect.js";

describe("ci-detect", () => {
  it("returns false when no CI env var is set", () => {
    expect(isCi({})).toBe(false);
  });

  it.each(["CI", "CONTINUOUS_INTEGRATION", "BUILD_NUMBER", "RUN_ID"])(
    "detects generic %s",
    (name) => {
      expect(isCi({ [name]: "1" })).toBe(true);
    }
  );

  it.each(["GITHUB_ACTIONS", "GITLAB_CI", "CIRCLECI", "TF_BUILD", "CODEBUILD_BUILD_ARN"])(
    "detects provider %s",
    (name) => {
      expect(isCi({ [name]: "1" })).toBe(true);
    }
  );

  it("detects provider includes checks from ci-info's vendor table", () => {
    expect(isCi({ NODE: "/app/.heroku/node/bin/node" })).toBe(true);
  });

  it("does not detect incomplete provider includes checks", () => {
    expect(isCi({ NODE: "/usr/local/bin/node" })).toBe(false);
  });

  it("ignores an explicitly-empty env var", () => {
    expect(isCi({ CI: "" })).toBe(false);
  });

  it("treats CI=false as not CI (ci-info escape hatch)", () => {
    expect(isCi({ CI: "false", GITHUB_ACTIONS: "1" })).toBe(false);
  });

  it("uses ci-info's broad provider table", () => {
    expect(_CI_VENDOR_COUNT_FOR_TEST).toBeGreaterThanOrEqual(45);
  });
});
