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

  it("lists chosen variants with their element and variant names", () => {
    const out = formatLensFeedback(
      outcome({
        selections: [
          {
            element: "Login button",
            match: { by: "text", value: "Login" },
            chosenVariant: { name: "Bold primary" },
            comment: "make it bigger",
          },
        ],
      })
    );
    expect(out).toContain('"Login button" → "Bold primary"');
    expect(out).toContain("make it bigger");
  });

  it("separates element notes (comment but no pick) from chosen variants", () => {
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
    expect(out).toContain('"Header": darker');
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
      "Overall — tighten spacing"
    );
  });

  it("falls back to a neutral message when nothing concrete was submitted", () => {
    expect(formatLensFeedback(outcome())).toContain("No specific picks");
  });

  it("steers the agent back to propose_variant and away from awaiting", () => {
    const out = formatLensFeedback(outcome());
    expect(out).toContain("propose_variant");
    expect(out).toContain("do not call await_user_selection");
  });
});

describe("buildSeedPrompt", () => {
  it("tells the agent it's a CLI Lens session and not to block", () => {
    const seed = buildSeedPrompt();
    expect(seed).toContain("Argent Lens CLI session");
    expect(seed).toContain("propose_variant");
    expect(seed).toContain("await_user_selection");
  });
  it("is a single line so it survives the spawn command unquoted", () => {
    expect(buildSeedPrompt()).not.toContain("\n");
  });
});
