import { describe, it, expect } from "vitest";
import { formatWhatsNewNote, highlightsSince } from "../src/whats-new.js";

const RELEASES = {
  "0.36.0": ["c1", "c2"],
  "0.35.0": ["b1", "b2", "b3"],
  "0.34.0": ["a1", "a2"],
};

describe("highlightsSince", () => {
  it("lists the releases after the seen version, newest first, up to five items", () => {
    expect(highlightsSince("0.33.0", "0.36.0", RELEASES)).toEqual(["c1", "c2", "b1", "b2", "b3"]);
  });

  it("skips the seen release and the ones newer than the running version", () => {
    expect(highlightsSince("0.34.0", "0.35.0", RELEASES)).toEqual(["b1", "b2", "b3"]);
  });

  it("lists only the running release when no version was recorded", () => {
    expect(highlightsSince(null, "0.35.0", RELEASES)).toEqual(["b1", "b2", "b3"]);
  });

  it("lists nothing for a canary of a release without highlights yet", () => {
    expect(highlightsSince("0.36.0", "0.37.0-next.2", RELEASES)).toEqual([]);
  });

  it("lists nothing when the running version is unknown", () => {
    expect(highlightsSince("0.34.0", "unknown", RELEASES)).toEqual([]);
  });
});

describe("formatWhatsNewNote", () => {
  it("names the version and lists each highlight", () => {
    expect(formatWhatsNewNote("0.35.0", ["b1", "b2"])).toBe(
      "Argent was updated to v0.35.0. Tell the user what is new in one sentence or a short list, then continue the task:\n- b1\n- b2"
    );
  });
});
