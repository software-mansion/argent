import { describe, expect, it } from "vitest";
import { FAILURE_CODES, type FailureSignal } from "@argent/registry";
import { createRegistry } from "../src/utils/setup-registry";
import { definitionsById, EXPECTED_TOOL_COUNT } from "./helpers/catalog";

const failureSignal: FailureSignal = {
  error_code: FAILURE_CODES.ARGENT_UNCLASSIFIED_FAILURE,
  failure_stage: "interaction_message_test",
  failure_area: "tool_server",
  error_kind: "unknown",
};

describe("tool interaction messages", () => {
  it("defines all three formatters for every tool", () => {
    const definitions = definitionsById(createRegistry());
    expect(definitions.size).toBe(EXPECTED_TOOL_COUNT);

    for (const [id, definition] of definitions) {
      expect(definition.interaction?.startedMsg, `${id}.startedMsg`).toBeTypeOf("function");
      expect(definition.interaction?.completedMsg, `${id}.completedMsg`).toBeTypeOf("function");
      expect(definition.interaction?.failedMsg, `${id}.failedMsg`).toBeTypeOf("function");
    }
  });

  it("formats messages from parameters, results, and failure signals", () => {
    const definitions = definitionsById(createRegistry());

    expect(
      definitions.get("gesture-tap")!.interaction!.completedMsg!({
        params: { udid: "device-1", x: 0.5, y: 0.25, clickCount: 2 },
        result: {},
      })
    ).toBe("Double-tapped at (50%, 25%)");

    // `keyboard` picks its wording from which of `text` / `key` was given, and
    // the two formatters see DIFFERENT sets of shapes. `startedMsg` renders
    // before `execute` runs, so it still sees a combined call — the one
    // `execute` is about to reject — and has to word four: text alone, key
    // alone, both, and neither. `completedMsg` runs only after a call that
    // succeeded, so the combined shape never reaches it and it words three. In
    // both, "neither" is a documented no-op returning { typed:"", keys:0 }
    // rather than an error (see keyboard-android.test.ts).
    const keyboard = definitions.get("keyboard")!.interaction!;
    expect(keyboard.startedMsg!({ params: { udid: "device-1", text: "hi" } })).toBe(
      "Entering text"
    );
    expect(keyboard.startedMsg!({ params: { udid: "device-1", key: "enter" } })).toBe(
      "Pressing a key"
    );
    // The combined shape, which only THIS formatter reaches: `startedMsg` runs
    // before the rejection. Without it, a `startedMsg` reduced to the two-way
    // text/key split would still satisfy every other assertion here while
    // announcing a rejected text+enter call as plain "Entering text".
    expect(keyboard.startedMsg!({ params: { udid: "device-1", text: "hi", key: "enter" } })).toBe(
      "Entering text and pressing a key"
    );
    // The empty request, on this formatter too. `completedMsg` appears in no
    // other test file, `startedMsg` only in this file's secret-leak check (which
    // every branch string satisfies), so neither empty-request branch is pinned
    // anywhere else. Narrowing BOTH to `params.text === undefined &&
    // params.key !== undefined` — so `keyboard {}` falls through to "Entering
    // text" / "Entered text" — stays green across the whole suite once this
    // assertion and its `completedMsg` twin below are removed. Both are
    // load-bearing.
    expect(keyboard.startedMsg!({ params: { udid: "device-1" } })).toBe("Pressing a key");
    expect(keyboard.completedMsg!({ params: { udid: "device-1", text: "hi" }, result: {} })).toBe(
      "Entered text"
    );
    expect(keyboard.completedMsg!({ params: { udid: "device-1", key: "enter" }, result: {} })).toBe(
      "Pressed a key"
    );
    // The third shape. "Pressed a key" for a call that pressed nothing is
    // inherited, not introduced here — pinned so the wording and the no-op
    // contract can only diverge deliberately.
    expect(keyboard.completedMsg!({ params: { udid: "device-1" }, result: {} })).toBe(
      "Pressed a key"
    );

    // `clear` carries neither `text` nor `key`, so without an arm of its own a
    // clear-only call is announced and logged as a key press that never happens,
    // and a `{ clear, text }` call hides the destructive half entirely.
    expect(keyboard.startedMsg!({ params: { udid: "device-1", clear: true } })).toBe(
      "Clearing a field"
    );
    expect(keyboard.completedMsg!({ params: { udid: "device-1", clear: true }, result: {} })).toBe(
      "Cleared a field"
    );
    expect(keyboard.startedMsg!({ params: { udid: "device-1", clear: true, text: "hi" } })).toBe(
      "Clearing a field and entering text"
    );
    expect(
      keyboard.completedMsg!({ params: { udid: "device-1", clear: true, text: "hi" }, result: {} })
    ).toBe("Cleared a field and entered text");
    expect(keyboard.startedMsg!({ params: { udid: "device-1", clear: true, key: "enter" } })).toBe(
      "Clearing a field and pressing a key"
    );
    // The completed tense of that arm was unpinned, so the two tenses could
    // drift apart on `{ clear, key }` — the largest shape a single call can
    // still carry, now that text and key cannot be combined.
    expect(
      keyboard.completedMsg!({
        params: { udid: "device-1", clear: true, key: "enter" },
        result: {},
      })
    ).toBe("Cleared a field and pressed a key");
    // The rejected shape, on `startedMsg` only. It renders before `execute`
    // throws, so this IS what an event log shows for a request about to 400 —
    // and a formatter that dropped the text+key arm would log it as a plain
    // clear-and-type. `completedMsg` never sees it, which is why there is no
    // twin assertion here.
    expect(
      keyboard.startedMsg!({ params: { udid: "device-1", clear: true, text: "hi", key: "enter" } })
    ).toBe("Clearing a field and entering text and pressing a key");

    expect(
      definitions.get("screenshot")!.interaction!.completedMsg!({
        params: { udid: "device-1" },
        result: { image: { filename: "screenshot.png" } },
      })
    ).toBe("Captured screenshot screenshot.png");

    expect(
      definitions.get("gesture-tap")!.interaction!.failedMsg!({
        params: { udid: "device-1", x: 0.5, y: 0.25 },
        error: new Error("raw error"),
        failureSignal,
      })
    ).toBe(`Failed to tap at (50%, 25%): ${failureSignal.error_code}`);
  });

  it("names the flow from either source in flow-execute messages", () => {
    const definitions = definitionsById(createRegistry());
    const interaction = definitions.get("flow-execute")!.interaction!;

    const byName = { name: "settings-explore", project_root: "/repo" };
    expect(interaction.startedMsg!({ params: byName })).toBe("Running flow settings-explore");
    expect(interaction.completedMsg!({ params: byName, result: {} })).toBe(
      "Ran flow settings-explore"
    );
    expect(interaction.failedMsg!({ params: byName, error: new Error("raw"), failureSignal })).toBe(
      `Failed to run flow settings-explore: ${failureSignal.error_code}`
    );

    // A flow_path call has no name param — the messages derive the name from
    // the YAML basename instead of rendering "undefined".
    const byPath = { flow_path: "/repo/flows/login.yaml", project_root: "/repo" };
    expect(interaction.startedMsg!({ params: byPath })).toBe("Running flow login");
    expect(interaction.completedMsg!({ params: byPath, result: {} })).toBe("Ran flow login");
    expect(interaction.failedMsg!({ params: byPath, error: new Error("raw"), failureSignal })).toBe(
      `Failed to run flow login: ${failureSignal.error_code}`
    );

    // Degenerate sources (these calls fail validation, but the started message
    // renders first) still say something honest — never "" or "undefined".
    expect(
      interaction.startedMsg!({ params: { flow_path: "/repo/flows/.yaml", project_root: "/repo" } })
    ).toBe("Running flow .yaml");
    // Unlike the bare ".yaml" above, this path has an empty basename stem, so
    // the raw path — not the stem — is what names the flow here.
    expect(interaction.startedMsg!({ params: { flow_path: "/", project_root: "/repo" } })).toBe(
      "Running flow /"
    );
    expect(interaction.startedMsg!({ params: { project_root: "/repo" } })).toBe(
      "Running flow (unspecified)"
    );
  });

  it("distinguishes a fresh recording start from a destructive restart", () => {
    // A restart truncates and replaces a live take; if its message ever
    // collapsed to the same wording as a fresh start (or reported a step
    // count that was never actually obtained), an agent re-recording a flow
    // would have no way to notice it just destroyed prior work.
    const definitions = definitionsById(createRegistry());
    const completedMsg = definitions.get("flow-start-recording")!.interaction!.completedMsg!;
    const params = { name: "checkout", project_root: "/tmp/proj" };

    expect(
      completedMsg({
        params,
        result: { message: "", flowFile: "", savedTo: "project" },
      })
    ).toBe("Started recording flow checkout");

    expect(
      completedMsg({
        params,
        result: { message: "", flowFile: "", savedTo: "project", restarted: true },
      })
    ).toBe("Restarted recording flow checkout, discarding the previous take");

    expect(
      completedMsg({
        params,
        result: {
          message: "",
          flowFile: "",
          savedTo: "project",
          restarted: true,
          discardedSteps: 1,
        },
      })
    ).toBe("Restarted recording flow checkout, discarding 1 step");

    expect(
      completedMsg({
        params,
        result: {
          message: "",
          flowFile: "",
          savedTo: "project",
          restarted: true,
          discardedSteps: 4,
        },
      })
    ).toBe("Restarted recording flow checkout, discarding 4 steps");
  });

  it("names the flow in every recording-tool interaction line", () => {
    // Recordings are concurrent, so several of these lines interleave in one log
    // and an unqualified "flow recording" would not say which one died or
    // finished. Only two of the twelve formatters on the four recording tools
    // are pinned elsewhere (flow-start-recording.completedMsg above,
    // flow-add-echo.completedMsg in the secrets test), so the other ten could
    // silently revert to name-free wording. Hold every one to naming the flow —
    // the property the concurrency support introduced — including the failure
    // lines, which are the diagnostic when several recordings are live.
    const definitions = definitionsById(createRegistry());
    const name = "checkout";
    const params = { name, project_root: "/tmp/proj", command: "gesture-tap", message: "note" };
    // Each tool's OWN result shape. One shared `{ message, flowFile, savedTo }`
    // used to stand in for all four, which stopped describing any of them once
    // the recorder dropped the per-step YAML: `flowFile` survives on start and
    // finish only, and add-step/add-echo report `stepCount` (plus `recorded`
    // on add-step) instead. No formatter below reads a field that differs
    // between them, but a fixture that misdescribes the contract is the one
    // that gets copied into a test that does.
    const results: Record<string, Record<string, unknown>> = {
      "flow-start-recording": { message: "", flowFile: "", savedTo: "project" },
      "flow-add-step": {
        message: "",
        toolResult: {},
        stepCount: 1,
        recorded: "1. tap: (0.5, 0.3)",
        savedTo: "project",
      },
      "flow-add-echo": { message: "", stepCount: 1, savedTo: "project" },
      "flow-finish-recording": {
        message: "",
        path: "/tmp/proj/.argent/flows/checkout.yaml",
        executionPrerequisite: "",
        steps: 1,
        summary: ["1. tap: (0.5, 0.3)"],
        flowFile: "",
        savedTo: "project",
      },
    };

    for (const id of [
      "flow-start-recording",
      "flow-add-step",
      "flow-add-echo",
      "flow-finish-recording",
    ]) {
      const i = definitions.get(id)!.interaction!;
      expect(i.startedMsg!({ params }), `${id}.startedMsg`).toContain(name);
      expect(i.completedMsg!({ params, result: results[id] }), `${id}.completedMsg`).toContain(
        name
      );
      expect(
        i.failedMsg!({ params, error: new Error("raw error"), failureSignal }),
        `${id}.failedMsg`
      ).toContain(name);
    }
  });

  it("does not expose sensitive inputs", () => {
    const definitions = definitionsById(createRegistry());
    const secret = "INTERACTION_MESSAGE_SECRET";
    const messages = [
      definitions.get("keyboard")!.interaction!.startedMsg!({
        params: { udid: "device-1", text: secret, key: secret },
      }),
      definitions.get("open-url")!.interaction!.startedMsg!({
        params: {
          udid: "device-1",
          url: `https://user:${secret}@example.com/path?token=${secret}#fragment`,
        },
      }),
      definitions.get("debugger-evaluate")!.interaction!.startedMsg!({
        params: { device_id: "device-1", port: 8081, expression: secret },
      }),
      definitions.get("chromium-cookies")!.interaction!.completedMsg!({
        params: { udid: "chromium-1", action: "set", name: "session", value: secret },
        result: { set: true },
      }),
      // Recordings are keyed by `name` + `project_root`, so both are required
      // and the message names the flow. The echoed `message` is the sensitive
      // part — it is caller-authored free text — and stays out.
      definitions.get("flow-add-echo")!.interaction!.completedMsg!({
        params: { name: "checkout", project_root: "/tmp/proj", message: secret },
        result: { message: secret, stepCount: 1, savedTo: "project" },
      }),
    ];

    expect(messages.join("\n")).not.toContain(secret);
    expect(messages).toContain("Opening example.com");
    expect(messages).toContain("Added note to flow checkout");
  });
});
