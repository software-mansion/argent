import { describe, expect, it } from "vitest";
import { vacuousHiddenSelectors, VACUOUS_HIDDEN_MARKER } from "../../src/tools/await-ui-element";

/**
 * A `hidden` wait that passed without its selector EVER matching proves
 * nothing — it holds against a typo, a renamed id, and the wrong screen alike.
 * The recorder refuses to write one and the runner marks it with ⚠.
 *
 * Both gates keyed on "is this an await-ui-element result", so wrapping the
 * identical wait in a one-step `run-sequence` walked straight past them:
 * reproduced on a real device, the wrapped form recorded clean and replayed as
 * `status: "pass"` with no warning, i.e. exactly the permanently-green gate the
 * direct form is refused for.
 */

const vacuousResult = {
  success: true,
  elapsed: 29,
  note: `condition met immediately — ${VACUOUS_HIDDEN_MARKER}, so it may have already been hidden before the wait, or the selector is wrong`,
};

const SELECTOR = { text: "ZzNoSuchElementZz" };

describe("vacuousHiddenSelectors", () => {
  it("names the selector of a direct vacuous hidden wait", () => {
    expect(
      vacuousHiddenSelectors("await-ui-element", vacuousResult, {
        udid: "emulator-5554",
        condition: "hidden",
        selector: SELECTOR,
      })
    ).toEqual([SELECTOR]);
  });

  it("names it through a run-sequence wrapper — the bypass", () => {
    expect(
      vacuousHiddenSelectors(
        "run-sequence",
        { completed: 1, total: 1, steps: [{ tool: "await-ui-element", result: vacuousResult }] },
        {
          udid: "emulator-5554",
          steps: [{ tool: "await-ui-element", args: { condition: "hidden", selector: SELECTOR } }],
        }
      )
    ).toEqual([SELECTOR]);
  });

  it("picks the offending step out of a longer sequence, by index", () => {
    const other = { text: "Home" };
    expect(
      vacuousHiddenSelectors(
        "run-sequence",
        {
          completed: 3,
          total: 3,
          steps: [
            { tool: "gesture-tap", result: { tapped: true } },
            { tool: "await-ui-element", result: { success: true, elapsed: 12 } },
            { tool: "await-ui-element", result: vacuousResult },
          ],
        },
        {
          udid: "emulator-5554",
          steps: [
            { tool: "gesture-tap", args: { x: 0.5, y: 0.5 } },
            { tool: "await-ui-element", args: { condition: "visible", selector: other } },
            { tool: "await-ui-element", args: { condition: "hidden", selector: SELECTOR } },
          ],
        }
      )
    ).toEqual([SELECTOR]);
  });

  it("clears a nested hidden that an earlier nested wait established — a self-contained proof", () => {
    // `[visible Sheet, tap, hidden Sheet]` in one sequence proves Sheet went
    // away: the earlier `visible` is the evidence, so the `hidden` is NOT
    // vacuous even though its own poll window never saw Sheet.
    const sheet = { text: "Sheet" };
    expect(
      vacuousHiddenSelectors(
        "run-sequence",
        {
          completed: 3,
          total: 3,
          steps: [
            { tool: "await-ui-element", result: { success: true, elapsed: 10 } },
            { tool: "gesture-tap", result: { tapped: true } },
            { tool: "await-ui-element", result: vacuousResult },
          ],
        },
        {
          udid: "emulator-5554",
          steps: [
            { tool: "await-ui-element", args: { condition: "visible", selector: sheet } },
            { tool: "gesture-tap", args: { x: 0.5, y: 0.5 } },
            { tool: "await-ui-element", args: { condition: "hidden", selector: sheet } },
          ],
        }
      )
    ).toEqual([]);
  });

  it("does not let a FAILED earlier wait establish the selector", () => {
    // The earlier `visible` did not succeed, so it proves nothing — the later
    // hidden on the same selector stays vacuous.
    const sheet = { text: "Sheet" };
    expect(
      vacuousHiddenSelectors(
        "run-sequence",
        {
          completed: 2,
          total: 2,
          steps: [
            { tool: "await-ui-element", result: { success: false, elapsed: 300 } },
            { tool: "await-ui-element", result: vacuousResult },
          ],
        },
        {
          udid: "emulator-5554",
          steps: [
            { tool: "await-ui-element", args: { condition: "visible", selector: sheet } },
            { tool: "await-ui-element", args: { condition: "hidden", selector: sheet } },
          ],
        }
      )
    ).toEqual([sheet]);
  });

  it("stays silent for a wait that genuinely saw its element", () => {
    expect(
      vacuousHiddenSelectors(
        "run-sequence",
        {
          completed: 1,
          total: 1,
          steps: [{ tool: "await-ui-element", result: { success: true } }],
        },
        { steps: [{ tool: "await-ui-element", args: { condition: "hidden", selector: SELECTOR } }] }
      )
    ).toEqual([]);
  });

  it("does not choke on a sequence whose step failed, or on junk", () => {
    expect(
      vacuousHiddenSelectors(
        "run-sequence",
        { completed: 0, total: 1, steps: [{ tool: "await-ui-element", error: "boom" }] },
        { steps: [{ tool: "await-ui-element", args: { condition: "hidden", selector: SELECTOR } }] }
      )
    ).toEqual([]);
    expect(vacuousHiddenSelectors("run-sequence", null, null)).toEqual([]);
    expect(vacuousHiddenSelectors("screenshot", vacuousResult, {})).toEqual([]);
  });
});
