import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";

const ANDROID_DEVICE = "emulator-5554";
let tmpDir: string;

interface Call {
  id: string;
  args: Record<string, unknown>;
}

/**
 * Android hierarchy with one EditText holding `text` and reporting focus,
 * shaped like a real device: the hint arrives as `content-desc` (the node's
 * LABEL) and the entered contents as `text` (its VALUE).
 *
 * The focus matters, and so does WHERE it sits: `runType` dispatches a
 * destructive clear only when a focus-flagged node is INSIDE the target's frame
 * — here they are the same node — or when the tree flags focus nowhere at all
 * (`noFocusXml`). Focus reported elsewhere (`unfocusedXml`) or on a node that
 * merely covers the target (`enclosingFocusXml`) refuses.
 */
const fieldXml = (text: string) =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.EditText" resource-id="email" content-desc="Username or email address" text="${text}" focused="true" package="com.acme.app" bounds="[40,200][1040,280]" />
  </node>
</hierarchy>`;

/**
 * The mis-target: the tap never moves focus, so the `email` field the step aims
 * at is NOT focused and a second field elsewhere on screen holds focus instead.
 * Keys injected here reach `other`, not `email` — the shape behind a selector
 * that resolves to a label or a wrapper, and behind any app whose control
 * refuses focus on tap.
 */
const unfocusedXml = () =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.EditText" resource-id="email" content-desc="Username or email address" text="" package="com.acme.app" bounds="[40,200][1040,280]" />
    <node index="1" class="android.widget.EditText" resource-id="other" content-desc="Display name" text="do not erase me" focused="true" package="com.acme.app" bounds="[40,600][1040,680]" />
  </node>
</hierarchy>`;

/**
 * A tree that reports focus on NO node at all — the shape an iOS build whose
 * injected framework predates the `firstResponder` field produces, where
 * `getFullHierarchy` simply omits it. Distinct from `unfocusedXml`: there the
 * tree can see focus and says it is elsewhere; here it cannot see focus at all,
 * which is no evidence against the clear. Verified on an iPhone 16 Pro, where
 * conflating the two refused every clear on the platform.
 */
const noFocusXml = () =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.EditText" resource-id="email" content-desc="Username or email address" text="old.remembered.login" package="com.acme.app" bounds="[40,200][1040,280]" />
  </node>
</hierarchy>`;

/**
 * The shape an overlap test cannot tell from a real confirmation: the only
 * focus-flagged node CONTAINS the target rather than sitting inside it.
 *
 * Measured on a live Chromium page as a screen-spanning shadow host (whose
 * `document.activeElement` is the host, never the inner element) with an input
 * of its own holding the keys, and again as a `focusin` focus trap on an
 * ordinary `<textarea>`. In both, a clear aimed at `email` emptied the ENCLOSING
 * element and left `email` untouched while the step reported a pass.
 */
const enclosingFocusXml = () =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.webkit.WebView" resource-id="host" content-desc="Editor" text="do not erase me" focused="true" package="com.acme.app" bounds="[0,100][1080,1900]" />
    <node index="1" class="android.widget.EditText" resource-id="email" content-desc="Username or email address" text="old.remembered.login" package="com.acme.app" bounds="[40,200][1040,280]" />
  </node>
</hierarchy>`;

/**
 * The overlay: a focused input sitting INSIDE the named field's box without
 * being it — a mention/autocomplete popover over a composer. Geometry alone
 * cannot tell this from `wrapperFocusXml` below; what separates them is that
 * here the NAMED node is itself a text field, so a different focused text field
 * inside it is covering it rather than belonging to it.
 */
const overlayFocusXml = () =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.EditText" resource-id="email" content-desc="Username or email address" text="old.remembered.login" package="com.acme.app" bounds="[40,200][1040,600]" />
    <node index="1" class="android.widget.EditText" resource-id="suggestions" content-desc="Suggestions" text="do not erase me" focused="true" package="com.acme.app" bounds="[80,300][900,380]" />
  </node>
</hierarchy>`;

/**
 * The legitimate non-identity case the containment test has to keep working:
 * the selector names a testID wrapper and focus is reported by the input INSIDE
 * it. A second focused node sits elsewhere on screen, so the verdict cannot
 * come from "something, somewhere, is focused".
 */
const wrapperFocusXml = () =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.view.ViewGroup" resource-id="email-wrapper" package="com.acme.app" bounds="[40,180][1040,300]">
      <node index="0" class="android.widget.EditText" resource-id="email" content-desc="Username or email address" text="old.remembered.login" focused="true" package="com.acme.app" bounds="[40,200][1040,280]" />
    </node>
    <node index="1" class="android.widget.EditText" resource-id="other" content-desc="Display name" text="do not erase me" focused="true" package="com.acme.app" bounds="[40,600][1040,680]" />
  </node>
</hierarchy>`;

function mockRegistry(calls: Call[], getHierarchy: () => { xml: string }): Registry {
  return {
    invokeTool: vi.fn(async (id: string, args: Record<string, unknown>) => {
      calls.push({ id, args });
      if (id === "list-devices") return { devices: [] };
      return { ok: true };
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    resolveService: vi.fn(async () => ({
      getHierarchy: vi.fn(async () => getHierarchy()),
      getScreenSize: vi.fn(async () => ({ width: 1080, height: 1920 })),
    })),
  } as unknown as Registry;
}

async function writeFlow(name: string, flow: Parameters<typeof serializeFlow>[0]): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.yaml`), serializeFlow(flow), "utf8");
}

function asRun(r: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in r)) throw new Error(`expected a run result, got notice: ${r.notice}`);
  return r;
}

/** Keyboard call args with the auto-injected `udid` stripped, in call order. */
const keyboardArgs = (calls: Call[]) =>
  calls
    .filter((c) => c.id === "keyboard")
    .map(({ args }) => {
      const { udid: _udid, ...rest } = args;
      return rest;
    });

const run = (registry: Registry) =>
  createRunFlowTool(registry).execute(
    {},
    { name: "f", project_root: tmpDir, device: ANDROID_DEVICE }
  );

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-type-clear-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("type directive — clear dispatch", () => {
  it("clears and types in ONE keyboard call, then submits (tap → clear+text → enter)", async () => {
    const calls: Call[] = [];
    // The field a `clear` exists for: one that already holds a value.
    const registry = mockRegistry(calls, () => ({ xml: fieldXml("old.remembered.login") }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "new@example.com", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);

    // Clear and text MUST ride one call. Every backend validates the whole
    // request before touching the device, so a rejected `text` leaves the field
    // untouched; split across two calls the clear commits first and a rejection
    // then leaves the field empty — worse off than before a call that failed.
    // Enter stays separate: `typeTv` rejects `key` outright before typing, so
    // folding it in would leave a TV target's field empty on submit.
    const keyboard = keyboardArgs(calls);
    expect(keyboard).toEqual([{ clear: true, text: "new@example.com" }, { key: "enter" }]);

    // …and the focusing tap comes before all of them.
    const order = calls
      .filter((c) => c.id === "gesture-tap" || c.id === "keyboard")
      .map((c) => c.id);
    expect(order[0]).toBe("gesture-tap");
  });

  it("refuses to clear when the focus wait never sees focus reach the target", async () => {
    // The destructive case: the tap did not move focus, so a clear would empty
    // whichever field still holds it — silently, and reported as a pass on a
    // field it never touched. Reproduced on a Pixel 3a before this guard.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: unfocusedXml() }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "new@example.com", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("refusing to clear");
    // Nothing may reach the device — not the clear, not the text, not Enter.
    expect(keyboardArgs(calls)).toEqual([]);
  });

  it("refuses to clear when the only focus flag merely COVERS the target", async () => {
    // An overlap test confirms this by construction, and every shape that
    // produces it — an open shadow root, a focused WebView, a focus trap — can
    // hide a different element holding the keys. Driven on a live Chromium
    // page, the clear emptied the enclosing element and reported a pass.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: enclosingFocusXml() }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "new@example.com", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("refusing to clear");
    expect(result.steps[0]!.reason).toContain("CONTAINS");
    expect(keyboardArgs(calls)).toEqual([]);
  });

  it("refuses to clear when a focused OVERLAY sits over the named field", async () => {
    // The mirror of the enclosing case, and the one geometry alone cannot tell
    // from the legitimate wrapper below: a suggestion popover's input sits
    // INSIDE the composer's box without being it. Driven on a live Chromium
    // page, the clear emptied the popover, left the composer untouched, and
    // reported a pass on the composer.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: overlayFocusXml() }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "new@example.com", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("refusing to clear");
    expect(result.steps[0]!.reason).toContain("OVERLAPS");
    expect(keyboardArgs(calls)).toEqual([]);
  });

  it("still clears when focus lands on the input inside the wrapper the selector named", async () => {
    // Containment, not identity: the legitimate case the strict test must keep
    // working. The decoy focused node elsewhere on screen is what stops this
    // passing on "something, somewhere, reports focus".
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: wrapperFocusXml() }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "type",
          into: { identifier: "email-wrapper" },
          text: "new@example.com",
          clear: true,
        },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(keyboardArgs(calls)).toEqual([
      { clear: true, text: "new@example.com" },
      { key: "enter" },
    ]);
  });

  it("refuses to clear when every read in the focus window failed", async () => {
    // A tree-source outage is not the same as a tree that reported nothing:
    // nothing was observed, so nothing is known about what holds focus.
    // `settleTree` draws the same line for the same condition.
    const calls: Call[] = [];
    let reads = 0;
    const registry = mockRegistry(calls, () => {
      reads++;
      // The pre-tap settle succeeds (so `waitForFrame` resolves), then every
      // read inside the focus window throws.
      if (reads > 2) throw new Error("device disconnected");
      return { xml: fieldXml("old.remembered.login") };
    });

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "new@example.com", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("refusing to clear");
    expect(result.steps[0]!.reason).toContain("could not be read");
    expect(keyboardArgs(calls)).toEqual([]);
  });

  it("judges focus by the latest read, not by any read that ever saw it", async () => {
    // The blur race. An app that drops focus when the tap lands reports the
    // PREVIOUS field as focused for however many poll rounds precede the blur.
    // With a sticky "saw focus at any point" flag the verdict then depended on
    // whether round 1 beat the blur — the same flow against the same app failing
    // or passing between runs. The question the clear is about to act on is
    // whether something else holds focus NOW.
    const calls: Call[] = [];
    let reads = 0;
    const registry = mockRegistry(calls, () => {
      reads++;
      // The pre-tap settle reads plus the first focus poll still see the old
      // field focused; everything after the blur sees nothing focused.
      return { xml: reads <= 3 ? unfocusedXml() : noFocusXml() };
    });

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "new@example.com", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(keyboardArgs(calls)).toEqual([
      { clear: true, text: "new@example.com" },
      { key: "enter" },
    ]);
  });

  it("still clears when the tree reports focus on no node at all", async () => {
    // The refusal keys off focus being reported SOMEWHERE ELSE, not off the poll
    // failing. A tree that never flags focus is not evidence the tap missed —
    // treating it as such disabled `clear` on every iOS build whose injected
    // framework omits `firstResponder`.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: noFocusXml() }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "new@example.com", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(keyboardArgs(calls)).toEqual([
      { clear: true, text: "new@example.com" },
      { key: "enter" },
    ]);
  });

  it("compares focus against where the target is NOW, not where it was tapped", async () => {
    // Keyboard avoidance scrolls the field away from the point the tap landed
    // on. The identity arm does not care, but the geometric one — the selector
    // named a wrapper and the input inside it reports focus — compares boxes,
    // and against the stale tap frame the input is no longer inside it. Every
    // other fixture here is static, so this is otherwise never exercised.
    const calls: Call[] = [];
    let reads = 0;
    const registry = mockRegistry(calls, () => {
      reads++;
      // From the focus poll onwards the whole group sits 500px higher.
      const y = reads <= 2 ? 900 : 400;
      return {
        xml:
          `<?xml version='1.0' encoding='UTF-8'?><hierarchy rotation="0">` +
          `<node index="0" class="android.widget.FrameLayout" bounds="[0,0][1080,1920]">` +
          `<node index="0" class="android.view.ViewGroup" resource-id="email-wrapper" ` +
          `bounds="[40,${y - 20}][1040,${y + 100}]">` +
          `<node index="0" class="android.widget.EditText" resource-id="email" ` +
          `content-desc="Username or email address" text="old.remembered.login" ` +
          `focused="true" bounds="[40,${y}][1040,${y + 80}]" />` +
          `</node></node></hierarchy>`,
      };
    });

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "type",
          into: { identifier: "email-wrapper" },
          text: "new@example.com",
          clear: true,
        },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(keyboardArgs(calls)).toEqual([
      { clear: true, text: "new@example.com" },
      { key: "enter" },
    ]);
  });

  it("still types on an unconfirmed focus when there is no clear", async () => {
    // The refusal is scoped to the destructive half. Misplaced text is additive
    // and visible, and "no focus seen" can also mean the focused view never made
    // it into the tree — so a plain type stays best-effort, as it always was.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: unfocusedXml() }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "new@example.com" }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(keyboardArgs(calls)).toEqual([{ text: "new@example.com" }, { key: "enter" }]);
  });

  it("does not submit a clear-only step", async () => {
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: fieldXml("stale draft") }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, clear: true }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    // Enter into a field the step just emptied is never the intent — and on a
    // search box it would run an empty query.
    const keyboard = keyboardArgs(calls);
    expect(keyboard).toEqual([{ clear: true }]);
  });

  it("submits a clear-only step when the author asks for it explicitly", async () => {
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: fieldXml("stale query") }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, clear: true, submit: true }],
    });

    asRun(await run(registry));
    const keyboard = keyboardArgs(calls);
    expect(keyboard).toEqual([{ clear: true }, { key: "enter" }]);
  });

  it("issues no clear call for a plain type step", async () => {
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: fieldXml("") }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "x" }],
    });

    asRun(await run(registry));
    const keyboard = keyboardArgs(calls);
    expect(keyboard).toEqual([{ text: "x" }, { key: "enter" }]);
  });

  it("reads the tree no more than a plain type step does", async () => {
    // The clear must not add a read-back pass. An earlier cut verified the
    // field was empty afterwards; that check was blind on iOS and on Chromium
    // `<input>` (neither carries a `value`) and actively failed correct
    // behaviour on Android fields whose hint becomes the value once emptied.
    // Pin the absence so it is not reintroduced by reflex.
    let reads = 0;
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => {
      reads++;
      return { xml: fieldXml("") };
    });

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "x" }],
    });
    asRun(await run(registry));
    const withoutClear = reads;

    reads = 0;
    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "x", clear: true }],
    });
    asRun(await run(registry));

    expect(reads).toBe(withoutClear);
  });
});

describe("type directive — report rendering", () => {
  it("names the clear in the run report's step target", async () => {
    // `into X` alone reads as a plain append, so a replace-a-field step would
    // be indistinguishable in the report from the bug it fixes.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: fieldXml("") }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "x", clear: true },
        { kind: "type", into: { identifier: "email" }, text: "y" },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps[0]!.target).toContain("clear first");
    expect(result.steps[1]!.target).not.toContain("clear first");
  });
});
