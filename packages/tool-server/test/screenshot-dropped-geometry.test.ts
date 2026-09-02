import { describe, expect, it } from "vitest";
import {
  requestedGeometry,
  chromiumDropNote,
  unsupportedDropNote,
  RESULT_NOTE_KEY,
} from "../src/tools/screenshot/dropped-geometry";

describe("requestedGeometry", () => {
  it("reports what the caller actually asked for", () => {
    expect(requestedGeometry({ rotation: "LandscapeLeft", scale: 0.25 })).toEqual([
      "rotation",
      "scale",
    ]);
  });

  it("ignores an absent parameter", () => {
    // The ARGENT_SCREENSHOT_SCALE default arrives as an absent param, and the
    // caller never asked for it — reporting it would put a note on captures
    // nobody requested a transform for (auto-screenshot passes only udid).
    expect(requestedGeometry({})).toEqual([]);
  });

  it("ignores the identity rotation", () => {
    expect(requestedGeometry({ rotation: "Portrait" })).toEqual([]);
  });

  it("ignores a full-size scale", () => {
    // A visual snapshot passes scale 1 on every step; nothing is lost there,
    // so flagging it would attach a note to every one of them.
    expect(requestedGeometry({ scale: 1 })).toEqual([]);
    expect(requestedGeometry({ scale: 0 })).toEqual([]);
  });
});

describe("drop notes", () => {
  it("says nothing when nothing was dropped", () => {
    expect(chromiumDropNote([])).toBeUndefined();
    expect(unsupportedDropNote([], "Apple TV")).toBeUndefined();
  });

  it("tells a Chromium caller how to make it work", () => {
    const note = chromiumDropNote(["scale", "rotation"]);
    expect(note).toContain("scale and rotation were not applied");
    expect(note).toContain("npm install sharp");
    expect(note).toContain("unmodified capture");
  });

  it("names the single dropped parameter", () => {
    expect(chromiumDropNote(["scale"])).toContain("scale was not applied");
  });

  it("does not blame a missing sharp when the PNG header was the problem", () => {
    // sharp is installed in this case and a requested rotation still ran, so
    // neither "unmodified capture" nor "npm install sharp" would be true.
    const note = chromiumDropNote(["scale"], "png-header-unreadable")!;
    expect(note).toContain("scale was not applied");
    expect(note).toContain("rotation requested on the same call was still applied");
    expect(note).not.toContain("npm install");
    expect(note).not.toContain("unmodified capture");
  });

  it("does not invite a pointless retry on a target that cannot transform", () => {
    const note = unsupportedDropNote(["rotation"], "Apple TV");
    expect(note).toContain("Apple TV");
    expect(note).toContain("will not change the result");
    // A scale on the same call is still applied server-side, so the note must
    // not claim the whole image is untransformed.
    expect(note).toContain("returned unrotated");
    expect(note).not.toContain("untransformed");
    // The Chromium remedy must not leak into a case where it cannot help.
    expect(note).not.toContain("npm install");
  });

  it("keeps the reserved key stable", () => {
    // http.ts hoists this off the result into the response envelope; renaming
    // it silently drops every note.
    expect(RESULT_NOTE_KEY).toBe("__argentNote");
  });
});
