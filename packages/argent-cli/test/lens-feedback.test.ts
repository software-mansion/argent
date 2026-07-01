import { describe, expect, it } from "vitest";
import { formatLensFeedback, buildSeedPrompt } from "../src/lens.js";

// Minimal completed-outcome factory.
function outcome(over: Partial<Parameters<typeof formatLensFeedback>[0]> = {}) {
  return {
    status: "completed" as const,
    round: 2,
    selections: [],
    unselected: [],
    annotations: [],
    completedAt: 123,
    ...over,
  };
}

describe("formatLensFeedback", () => {
  it("is always a single line (no embedded newlines)", () => {
    const out = formatLensFeedback(outcome({ globalComment: "first line\nsecond line" }));
    expect(out).not.toContain("\n");
  });

  it("is prefixed so the agent recognises it, and names the round", () => {
    expect(formatLensFeedback(outcome())).toContain("[Argent Lens]");
    expect(formatLensFeedback(outcome({ round: 7 }))).toContain("round 7");
  });

  it("lists chosen variants with element, selector, variant, summary, source, and note", () => {
    const out = formatLensFeedback(
      outcome({
        selections: [
          {
            element: "Login button",
            match: { by: "text", value: "Login" },
            chosenVariant: {
              name: "Bold primary",
              summary: "filled CTA",
              filePath: "src/Login.tsx",
            },
            comment: "make it bigger",
          },
        ],
      })
    );
    expect(out).toContain('"Login button" [text=Login] → "Bold primary"');
    expect(out).toContain("(filled CTA)");
    expect(out).toContain("[src: src/Login.tsx]");
    expect(out).toContain("make it bigger");
  });

  it("surfaces proposed-but-untouched elements as left-as-is (excluding chosen/noted)", () => {
    const out = formatLensFeedback(
      outcome({
        selections: [
          { element: "CTA", match: { by: "text", value: "Go" }, chosenVariant: { name: "A" } },
        ],
        unselected: [{ element: "Footer" }, { element: "CTA" }],
      })
    );
    expect(out).toContain('Left as-is (reviewed, no change) — "Footer"');
    // CTA was chosen, so it must not be reported as left-as-is.
    expect(out).not.toMatch(/Left as-is[^.]*CTA/);
  });

  it("separates element notes (comment but no pick) from chosen variants, with selector", () => {
    const out = formatLensFeedback(
      outcome({
        selections: [
          {
            element: "Header",
            match: { by: "text", value: "Header" },
            chosenVariant: null,
            comment: "darker",
          },
        ],
      })
    );
    expect(out).toContain("Element notes");
    expect(out).toContain('"Header" [text=Header]: darker');
    expect(out).not.toContain("Chosen variants");
  });

  it("includes inspector annotations with their matcher", () => {
    const out = formatLensFeedback(
      outcome({
        annotations: [
          {
            target: "Submit",
            match: { by: "identifier", value: "submit-btn" },
            comment: "align right",
          },
        ],
      })
    );
    expect(out).toContain('"Submit" [identifier=submit-btn]: align right');
  });

  it("includes the global comment", () => {
    expect(formatLensFeedback(outcome({ globalComment: "tighten spacing" }))).toContain(
      "Overall direction — tighten spacing"
    );
  });

  it("falls back to a neutral message when nothing concrete was submitted", () => {
    expect(formatLensFeedback(outcome())).toContain("No specific picks");
  });

  it("offers propose_variant only when there's open-ended direction, and ends the turn", () => {
    const out = formatLensFeedback(outcome({ globalComment: "make the header feel bolder" }));
    expect(out).toContain("propose_variant");
    expect(out).toContain("end your turn");
    // The await tool is hidden in a CLI session, so feedback never names it.
    expect(out).not.toContain("await_user_selection");
  });

  it("does not push new variants when the feedback is a plain approval", () => {
    const out = formatLensFeedback(
      outcome({
        selections: [
          { element: "CTA", match: { by: "text", value: "Go" }, chosenVariant: { name: "A" } },
        ],
        globalComment: "",
      })
    );
    // A pick with no attached direction is an approval — stop, don't re-propose.
    expect(out).not.toContain("propose_variant");
    expect(out).toContain("end your turn");
  });
});

describe("buildSeedPrompt", () => {
  it("tells the agent it's a CLI Lens session and not to block", () => {
    const seed = buildSeedPrompt();
    expect(seed).toContain("Argent Lens CLI session");
    expect(seed).toContain("propose_variant");
    expect(seed).toContain("end your turn");
    // Don't name a tool the agent can't see in this session.
    expect(seed).not.toContain("await_user_selection");
  });
  it("is a single line so it survives the spawn command unquoted", () => {
    expect(buildSeedPrompt()).not.toContain("\n");
  });
});
