import { describe, it, expect } from "vitest";
import {
  extractResumedPackages,
  parseUserPackages,
} from "../../src/utils/android-profiler/detect-app";

describe("extractResumedPackages", () => {
  it("pulls the package from a ResumedActivity line", () => {
    const out = `
      mFocusedApp=ActivityRecord{abc u0 com.example.app/.MainActivity}
      ResumedActivity: ActivityRecord{def u0 com.example.app/.MainActivity t1}
    `;
    expect([...extractResumedPackages(out)]).toEqual(["com.example.app"]);
  });

  it("pulls the package from a topResumedActivity= line", () => {
    const out = `topResumedActivity=ActivityRecord{xyz u0 com.android.settings/.Settings}`;
    expect([...extractResumedPackages(out)]).toEqual(["com.android.settings"]);
  });

  it("returns an empty set when no resumed activity is present", () => {
    expect(extractResumedPackages("idle")).toEqual(new Set());
  });

  it("dedupes across multiple matching lines", () => {
    const out = `
      ResumedActivity: ActivityRecord{a u0 com.example/.Main}
      mResumedActivity: ActivityRecord{b u0 com.example/.Main}
    `;
    expect([...extractResumedPackages(out)]).toEqual(["com.example"]);
  });

  it("captures both packages when two distinct user apps are resumed (multi-window)", () => {
    const out = `
      ResumedActivity: ActivityRecord{a u0 com.foo/.A}
      ResumedActivity: ActivityRecord{b u0 com.bar/.B}
    `;
    const result = extractResumedPackages(out);
    expect(result.has("com.foo")).toBe(true);
    expect(result.has("com.bar")).toBe(true);
  });
});

describe("parseUserPackages", () => {
  it("parses a typical pm list packages -3 dump", () => {
    const out = `
package:com.example.app
package:com.acme.tools
trailing junk
    `;
    const set = parseUserPackages(out);
    expect(set.has("com.example.app")).toBe(true);
    expect(set.has("com.acme.tools")).toBe(true);
    expect(set.size).toBe(2);
  });

  it("returns an empty set on an empty dump", () => {
    expect(parseUserPackages("")).toEqual(new Set());
  });
});
