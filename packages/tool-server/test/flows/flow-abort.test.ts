import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

// Cancel the run mid-directive by tripping an AbortController from inside the
// tree fetch itself: the mock counts reads and aborts on a scripted one, which
// lands the abort deterministically inside a directive's auto-wait / focus-wait
// poll (no timer races).
let currentFetch: () => DescribeTreeData;
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(async (): Promise<DescribeTreeData> => currentFetch()),
}));

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
let tmpDir: string;

function n(partial: Partial<DescribeNode> & { frame: DescribeNode["frame"] }): DescribeNode {
  return { role: "AXOther", children: [], ...partial };
}

function screen(children: DescribeNode[]): DescribeNode {
  return n({ role: "AXWindow", frame: { x: 0, y: 0, width: 1, height: 1 }, children });
}

function mockRegistry(calls: string[]): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      calls.push(id);
      if (id === "list-devices") return { devices: [] };
      return { ok: true };
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
  } as unknown as Registry;
}

async function writeFlow(name: string, yaml: Parameters<typeof serializeFlow>[0]): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.yaml`), serializeFlow(yaml), "utf8");
}

function asRun(r: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in r)) throw new Error(`expected a run result, got notice: ${r.notice}`);
  return r;
}

async function run(name: string, registry: Registry, signal: AbortSignal): Promise<FlowRunResult> {
  return asRun(
    await createRunFlowTool(registry).execute({}, { name, project_root: tmpDir, device: DEVICE }, {
      signal,
    } as never)
  );
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-abort-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("run cancellation mid-directive", () => {
  it("fails the verdict when an already-aborted run only contains echo narration", async () => {
    const controller = new AbortController();
    controller.abort();
    currentFetch = () => ({ tree: screen([]), source: "native-devtools" });

    await writeFlow("cancelled-echo", {
      executionPrerequisite: "",
      steps: [{ kind: "echo", message: "never narrated" }],
    });

    const result = await run("cancelled-echo", mockRegistry([]), controller.signal);

    expect(result.steps).toMatchObject([{ kind: "echo", status: "skip", reason: "run aborted" }]);
    // Echo remains excluded from displayed counters, but cancellation still
    // makes the run incomplete rather than a zero-step pass.
    expect(result.skipped).toBe(0);
    expect(result.ok).toBe(false);
  });

  it("reports a tap cancelled during its auto-wait as a skip, not an offscreen failure", async () => {
    const controller = new AbortController();
    // The target never appears; the run is cancelled on the third tree read
    // (i.e. while the tap's auto-wait is still polling).
    let reads = 0;
    currentFetch = () => {
      reads++;
      if (reads >= 3) controller.abort();
      return {
        tree: screen([n({ label: "Other", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 } })]),
        source: "native-devtools",
      };
    };
    const calls: string[] = [];

    await writeFlow("cancelled-tap", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", selector: { text: "Checkout", loose: true } }],
    });

    const result = await run("cancelled-tap", mockRegistry(calls), controller.signal);

    // A skip with the uniform abort reason — NOT a fail with the misleading
    // "no visible element matched … add a scroll-to step" hint.
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tap:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
    expect(result.ok).toBe(false);
    expect(calls).not.toContain("gesture-tap");
  });

  it("dispatches no tap when the run is cancelled during the settle-completing tree read", async () => {
    const controller = new AbortController();
    // The target is visible and the tree is stable, so read 2 is the read that
    // completes the settle (two identical fingerprints). The abort lands inside
    // that read — settleTree must NOT hand the tree back to waitForFrame, or the
    // tap would be dispatched post-cancellation and recorded as a pass.
    let reads = 0;
    currentFetch = () => {
      reads++;
      if (reads >= 2) controller.abort();
      return {
        tree: screen([
          n({ label: "Checkout", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 } }),
        ]),
        source: "native-devtools",
      };
    };
    const calls: string[] = [];

    await writeFlow("cancelled-tap-settle", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", selector: { text: "Checkout", loose: true } }],
    });

    const result = await run("cancelled-tap-settle", mockRegistry(calls), controller.signal);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tap:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
    expect(result.ok).toBe(false);
    expect(calls).not.toContain("gesture-tap");
  });

  it("dispatches no tap when the run is cancelled one read before the settle completes", async () => {
    // Control for the settle-completing case above: aborting during the FIRST
    // read (not yet a fingerprint match) already skipped correctly — keep it so.
    const controller = new AbortController();
    let reads = 0;
    currentFetch = () => {
      reads++;
      if (reads >= 1) controller.abort();
      return {
        tree: screen([
          n({ label: "Checkout", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 } }),
        ]),
        source: "native-devtools",
      };
    };
    const calls: string[] = [];

    await writeFlow("cancelled-tap-first-read", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", selector: { text: "Checkout", loose: true } }],
    });

    const result = await run("cancelled-tap-first-read", mockRegistry(calls), controller.signal);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tap:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
    expect(calls).not.toContain("gesture-tap");
  });

  it("dispatches no scroll increment when the run is cancelled during a mid-scroll settle read", async () => {
    const controller = new AbortController();
    // The target never appears and the tree is stable — after read 2 settles,
    // scroll-to would dispatch its first swipe increment. The abort lands inside
    // that settle-completing read, so no gesture may follow it.
    let reads = 0;
    currentFetch = () => {
      reads++;
      if (reads >= 2) controller.abort();
      return {
        tree: screen([n({ label: "Row 1", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 } })]),
        source: "native-devtools",
      };
    };
    const calls: string[] = [];

    await writeFlow("cancelled-scroll-settle", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Order #1234" }, direction: "down" }],
    });

    const result = await run("cancelled-scroll-settle", mockRegistry(calls), controller.signal);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["scroll-to:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
    expect(calls).not.toContain("gesture-swipe");
    expect(calls).not.toContain("gesture-scroll");
  });

  it("dispatches no focus tap when a type step is cancelled during the settle-completing read", async () => {
    const controller = new AbortController();
    // Same timing as the tap case, but for `type`: the leak would be the focus
    // tap (the keyboard dispatches are separately guarded already).
    let reads = 0;
    currentFetch = () => {
      reads++;
      if (reads >= 2) controller.abort();
      return {
        tree: screen([
          n({ identifier: "email", frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.06 } }),
        ]),
        source: "native-devtools",
      };
    };
    const calls: string[] = [];

    await writeFlow("cancelled-type-settle", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "a@b.com" }],
    });

    const result = await run("cancelled-type-settle", mockRegistry(calls), controller.signal);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["type:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
    expect(calls).not.toContain("gesture-tap");
    expect(calls).not.toContain("keyboard");
  });

  it("injects no keyboard input when the run is cancelled during the focus wait", async () => {
    const controller = new AbortController();
    // Reads 1-2 are the pre-tap settle (field resolves immediately); read 3 is
    // the focus poll's first look — the field never reports focus, and the run
    // is cancelled there.
    let reads = 0;
    currentFetch = () => {
      reads++;
      if (reads >= 3) controller.abort();
      return {
        tree: screen([
          n({ identifier: "email", frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.06 } }),
        ]),
        source: "native-devtools",
      };
    };
    const calls: string[] = [];

    await writeFlow("cancelled-type", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "a@b.com" }],
    });

    const result = await run("cancelled-type", mockRegistry(calls), controller.signal);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["type:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
    // The focus tap fired before the cancel, but neither the text nor the
    // submitting Enter may reach the app afterwards.
    expect(calls).toContain("gesture-tap");
    expect(calls).not.toContain("keyboard");
  });

  it("reports a type cancelled DURING the keyboard dispatch as a skip, not an error", async () => {
    // The keyboard tool has no abort handling of its own, so the guards around
    // it only cover the gaps between calls. Cancelling tears down the transport
    // the keys ride on (simulator-server connection, CDP session) and the
    // in-flight call rejects with the backend's own message — which must not
    // surface as a step failure quoting the tool. Same guard `runRotate` and
    // `runLaunch` already apply to their dispatches.
    const controller = new AbortController();
    currentFetch = () => ({
      tree: screen([
        n({
          identifier: "email",
          focused: true,
          frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.06 },
        }),
      ]),
      source: "native-devtools",
    });
    const calls: string[] = [];
    const registry = {
      invokeTool: vi.fn(async (id: string) => {
        calls.push(id);
        if (id === "list-devices") return { devices: [] };
        if (id === "keyboard") {
          controller.abort();
          throw new Error("simulator-server connection closed");
        }
        return { ok: true };
      }),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    } as unknown as Registry;

    await writeFlow("cancelled-type-dispatch", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "a@b.com" }],
    });

    const result = await run("cancelled-type-dispatch", registry, controller.signal);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["type:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
    expect(calls).toContain("keyboard");
  });

  // The four guards below were each removable with the whole flow suite still
  // green. They are the ones that stop a cancelled run from still reaching the
  // device, so each gets a test that fails when it is taken out.
  //
  // `focusedField` is the tree every one of them runs against: focus lands on
  // the target, so the focus wait confirms immediately and the step proceeds to
  // its dispatches — which is where the cancellation has to be caught.
  const focusedField = () => ({
    tree: screen([
      n({
        identifier: "email",
        focused: true,
        frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.06 },
      }),
    ]),
    source: "native-devtools" as const,
  });

  it("does not submit after a run cancelled during the text dispatch", async () => {
    // The first keyboard call SUCCEEDS and the cancel lands while it runs, so
    // no rejection reclassifies anything: only the explicit re-check before the
    // Enter block stops the submit. Without it the cancelled run presses Enter
    // into whatever the app has focused, and reports the step as a pass.
    const controller = new AbortController();
    currentFetch = focusedField;
    const calls: string[] = [];
    const registry = {
      invokeTool: vi.fn(async (id: string) => {
        calls.push(id);
        if (id === "list-devices") return { devices: [] };
        if (id === "keyboard") controller.abort();
        return { ok: true };
      }),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    } as unknown as Registry;

    await writeFlow("cancelled-before-submit", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "a@b.com" }],
    });

    const result = await run("cancelled-before-submit", registry, controller.signal);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["type:skip"]);
    expect(calls.filter((c) => c === "keyboard")).toHaveLength(1);
  });

  it("reports a clear-only step cancelled during its one dispatch as a skip", async () => {
    // `submit` defaults to false for a clear-only step, so the Enter block never
    // runs and the guard on the clear/text dispatch's own return value is the
    // only one in play. Without it the step reports a pass after the clear was
    // dispatched into a cancelled run.
    const controller = new AbortController();
    currentFetch = focusedField;
    const registry = {
      invokeTool: vi.fn(async (id: string) => {
        if (id === "list-devices") return { devices: [] };
        if (id === "keyboard") {
          controller.abort();
          throw new Error("simulator-server connection closed");
        }
        return { ok: true };
      }),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    } as unknown as Registry;

    await writeFlow("cancelled-clear-only", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, clear: true }],
    });

    const result = await run("cancelled-clear-only", registry, controller.signal);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["type:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
  });

  it("reports a clear-only step cancelled during a RESOLVING dispatch as a skip", async () => {
    // The twin of the test above, and the shape that actually happens:
    // `dispatchOrAbort` reclassifies only a dispatch that REJECTS while the
    // signal is aborted. On Android and Chromium the keyboard backend takes no
    // signal at all, so a cancel mid-call leaves the call to resolve normally
    // and the guard on its return value never fires.
    //
    // A step that submits is still caught, by the re-check before the Enter —
    // which is why the two shapes diverged: `submit` defaults to false for a
    // clear-only step, so that block, and the only remaining check with it, was
    // skipped and the step reported a pass on a cancelled run.
    const controller = new AbortController();
    currentFetch = focusedField;
    const calls: string[] = [];
    const registry = {
      invokeTool: vi.fn(async (id: string) => {
        calls.push(id);
        if (id === "list-devices") return { devices: [] };
        if (id === "keyboard") controller.abort();
        return { ok: true };
      }),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    } as unknown as Registry;

    await writeFlow("cancelled-clear-only-resolving", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, clear: true }],
    });

    const result = await run("cancelled-clear-only-resolving", registry, controller.signal);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["type:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
    // The clear itself went out — this is a cancellation caught AFTER the
    // dispatch, not one that pre-empted it, so the assertion cannot pass by the
    // step never reaching the keyboard at all.
    expect(calls.filter((c) => c === "keyboard")).toHaveLength(1);
  });

  it("reports a type cancelled DURING the submitting Enter as a skip, not an error", async () => {
    // The Enter dispatch needs the same reclassification as the text one: a
    // rejection that coincides with the cancel must not surface as a step error
    // quoting the backend.
    const controller = new AbortController();
    currentFetch = focusedField;
    let keyboardCalls = 0;
    const registry = {
      invokeTool: vi.fn(async (id: string) => {
        if (id === "list-devices") return { devices: [] };
        if (id === "keyboard") {
          keyboardCalls++;
          if (keyboardCalls === 1) return { ok: true };
          controller.abort();
          throw new Error("simulator-server connection closed");
        }
        return { ok: true };
      }),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    } as unknown as Registry;

    await writeFlow("cancelled-enter", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "a@b.com" }],
    });

    const result = await run("cancelled-enter", registry, controller.signal);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["type:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
    expect(keyboardCalls).toBe(2);
  });

  it("reports a type cancelled DURING a RESOLVING Enter as a skip, not a pass", async () => {
    // The twin of the test above, and the same gap the clear-only step had one
    // dispatch earlier: `dispatchOrAbort` reclassifies only a dispatch that
    // REJECTS under an aborted signal, and the Android backend takes no signal at
    // all — so a cancel landing mid-Enter leaves the call to resolve and returns
    // `true`. The re-check that catches the clear/text half runs BEFORE the Enter
    // block, so nothing stood between this dispatch and `{ ok: true }`: the step
    // reported a PASS with the submit already sent, while the identical
    // cancellation one dispatch earlier reported a skip.
    const controller = new AbortController();
    currentFetch = focusedField;
    let keyboardCalls = 0;
    const registry = {
      invokeTool: vi.fn(async (id: string, args?: Record<string, unknown>) => {
        if (id === "list-devices") return { devices: [] };
        if (id === "keyboard") {
          keyboardCalls++;
          // Cancel while the Enter is in flight, and resolve anyway — what a
          // signal-less backend does.
          if (args?.key === "enter") controller.abort();
        }
        return { ok: true };
      }),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    } as unknown as Registry;

    await writeFlow("cancelled-enter-resolving", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "a@b.com" }],
    });

    const result = await run("cancelled-enter-resolving", registry, controller.signal);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["type:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
    // Both dispatches went out — this is a cancellation caught AFTER the submit,
    // not one that pre-empted it, so the assertion cannot pass by the step never
    // reaching the Enter at all.
    expect(keyboardCalls).toBe(2);
  });

  it("reports an explicit `submit: true` clear-only step the same way", async () => {
    // `submit` defaults off for a clear-only step, but an author can turn it on —
    // and then the step's LAST dispatch is the Enter again, with no text dispatch
    // before it. Without the re-check after the Enter this shape reported a pass
    // while the same step minus `submit` reported a skip, which is the divergence
    // the whole re-check exists to close.
    const controller = new AbortController();
    currentFetch = focusedField;
    let keyboardCalls = 0;
    const registry = {
      invokeTool: vi.fn(async (id: string, args?: Record<string, unknown>) => {
        if (id === "list-devices") return { devices: [] };
        if (id === "keyboard") {
          keyboardCalls++;
          if (args?.key === "enter") controller.abort();
        }
        return { ok: true };
      }),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    } as unknown as Registry;

    await writeFlow("cancelled-enter-clear-only", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, clear: true, submit: true }],
    });

    const result = await run("cancelled-enter-clear-only", registry, controller.signal);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["type:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
    expect(keyboardCalls).toBe(2);
  });

  it("reports a type cancelled DURING the focusing tap as a skip, not an error", async () => {
    // All three of the step's device calls have to classify a cancelled run the
    // same way; with the tap left bare, the same step reported `error` or `skip`
    // depending on which dispatch happened to be in flight.
    const controller = new AbortController();
    currentFetch = focusedField;
    const registry = {
      invokeTool: vi.fn(async (id: string) => {
        if (id === "list-devices") return { devices: [] };
        if (id === "gesture-tap") {
          controller.abort();
          throw new Error("simulator-server connection closed");
        }
        return { ok: true };
      }),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    } as unknown as Registry;

    await writeFlow("cancelled-focus-tap", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "a@b.com" }],
    });

    const result = await run("cancelled-focus-tap", registry, controller.signal);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["type:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
  });

  it("propagates a keyboard rejection as a real error when the run is not aborted", async () => {
    // The other half of the guard above: only a CANCELLED run may be reclassified
    // as a skip. A backend rejecting on its own — un-typeable text, an unknown
    // key, an unreachable transport — must still surface as a step error with
    // the tool's reason, or every such failure would be silently reported as
    // "run aborted". Mirrors flow-rotate's "propagates a dispatch rejection as a
    // real error when the run is not aborted".
    currentFetch = () => ({
      tree: screen([
        n({
          identifier: "email",
          focused: true,
          frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.06 },
        }),
      ]),
      source: "native-devtools",
    });
    const registry = {
      invokeTool: vi.fn(async (id: string) => {
        if (id === "list-devices") return { devices: [] };
        if (id === "keyboard") throw new Error("simulator-server unreachable");
        return { ok: true };
      }),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    } as unknown as Registry;

    await writeFlow("type-dispatch-error", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "a@b.com" }],
    });

    const result = asRun(
      await createRunFlowTool(registry).execute({}, {
        name: "type-dispatch-error",
        project_root: tmpDir,
        device: DEVICE,
      } as never)
    );

    expect(result.steps[0]).toMatchObject({ kind: "type", status: "error" });
    expect(result.steps[0].reason).toMatch(/simulator-server unreachable/);
  });

  it("erases nothing when a clear-only step is cancelled during the focus wait", async () => {
    const controller = new AbortController();
    // The clear-only shape shares the keyboard dispatch with the text case, so
    // this does not pin a separate branch — it pins the SHAPE: a cancelled
    // clear-only step must leave the field alone. A leak here is worse than a
    // stray character, since the run is reported cancelled while the field was
    // emptied anyway, which no report would show.
    let reads = 0;
    currentFetch = () => {
      reads++;
      if (reads >= 3) controller.abort();
      return {
        tree: screen([
          n({ identifier: "email", frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.06 } }),
        ]),
        source: "native-devtools",
      };
    };
    const calls: string[] = [];

    await writeFlow("cancelled-clear", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, clear: true }],
    });

    const result = await run("cancelled-clear", mockRegistry(calls), controller.signal);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["type:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
    expect(calls).toContain("gesture-tap");
    expect(calls).not.toContain("keyboard");
  });

  it("attributes abort skips inside a fragment to the fragment, not the root", async () => {
    const controller = new AbortController();
    // The fragment's tap polls for a target that never appears; the run is
    // cancelled on the third tree read, mid-auto-wait. The steps after the tap
    // then hit execSteps' abort-skip branch (the run: line) and the hard-stop
    // branch (the trailing echo) — with the fragment still on the run stack.
    // Every skip line must carry the fragment's attribution, and the run: line
    // its own target stem, identical to the executed and hard-stop paths.
    let reads = 0;
    currentFetch = () => {
      reads++;
      if (reads >= 3) controller.abort();
      return {
        tree: screen([n({ label: "Other", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 } })]),
        source: "native-devtools",
      };
    };

    await writeFlow("other", {
      executionPrerequisite: "",
      steps: [{ kind: "echo", message: "never loaded" }],
    });
    await writeFlow("frag", {
      executionPrerequisite: "",
      steps: [
        { kind: "tap", selector: { text: "Checkout", loose: true } },
        { kind: "run", flow: "other.yaml" },
        { kind: "echo", message: "fragment tail" },
      ],
    });
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: "frag.yaml" }],
    });

    const result = await run("main", mockRegistry([]), controller.signal);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "run:pass",
      "tap:skip",
      "run:skip",
      "echo:skip",
    ]);
    // The cancelled tap and the abort-skipped run: line report the uniform
    // abort reason; the echo after them is a plain hard-stop skip.
    expect(result.steps[1]).toMatchObject({ flow: "frag", reason: "run aborted" });
    expect(result.steps[2]).toMatchObject({
      flow: "other",
      target: "other.yaml",
      reason: "run aborted",
    });
    expect(result.steps[3]).toMatchObject({ flow: "frag", message: "fragment tail" });
    expect(result.ok).toBe(false);
  });

  it("reports an await cancelled mid-poll as a skip with the uniform abort reason", async () => {
    const controller = new AbortController();
    let reads = 0;
    currentFetch = () => {
      reads++;
      if (reads >= 3) controller.abort();
      return {
        tree: screen([n({ label: "Other", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 } })]),
        source: "native-devtools",
      };
    };
    const calls: string[] = [];

    await writeFlow("cancelled-await", {
      executionPrerequisite: "",
      steps: [{ kind: "await", condition: "visible", selector: { identifier: "spinner" } }],
    });

    const result = await run("cancelled-await", mockRegistry(calls), controller.signal);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["await:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
  });
});

describe("run cancellation mid-launch", () => {
  // Like mockRegistry, but the restart-app call runs a scripted hook first —
  // tripping the abort deterministically inside the launch step.
  function launchRegistry(calls: string[], onRestartApp: () => unknown): Registry {
    return {
      invokeTool: vi.fn(async (id: string) => {
        calls.push(id);
        if (id === "list-devices") return { devices: [] };
        if (id === "restart-app") return onRestartApp();
        return { ok: true };
      }),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    } as unknown as Registry;
  }

  it("reports a launch cancelled during the post-launch settle as a skip", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    // restart-app succeeds, but the run is cancelled right after — the abort
    // lands in the post-launch settle / tree-source gate.
    const registry = launchRegistry(calls, () => {
      controller.abort();
      return { ok: true };
    });

    await writeFlow("cancelled-launch-settle", {
      executionPrerequisite: "",
      steps: [{ kind: "launch", app: "com.acme.app" }],
    });

    const result = await run("cancelled-launch-settle", registry, controller.signal);

    // A skip with the uniform abort reason — NOT a pass: the settle and the
    // tree-source gate were cut short, so the launch verified nothing.
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["launch:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
    expect(result.ok).toBe(false);
    expect(calls).toContain("restart-app");
  });

  it("reports a launch cancelled during restart-app as a skip, not an error", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    // The cancellation makes the restart-app sub-tool itself reject: that
    // rejection is the abort, not an app failure.
    const registry = launchRegistry(calls, () => {
      controller.abort();
      throw new Error("This operation was aborted");
    });

    await writeFlow("cancelled-launch-restart", {
      executionPrerequisite: "",
      steps: [{ kind: "launch", app: "com.acme.app" }],
    });

    const result = await run("cancelled-launch-restart", registry, controller.signal);

    // A skip with the uniform abort reason — NOT an error blaming restart-app.
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["launch:skip"]);
    expect(result.steps[0].reason).toBe("run aborted");
    expect(calls).toContain("restart-app");
  });
});
