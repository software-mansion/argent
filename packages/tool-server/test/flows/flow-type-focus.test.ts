import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

// The iOS test exercises the focus-wait's source gate (a source that can't
// report focus bails out of the poll) by stubbing the tree fetch with an
// `ax-service`-tagged tree — flows no longer degrade to that source on their
// own, so the stub is the only way to present it. The Android test leaves
// `currentFetch` unset and drives the REAL fetch path: its tree comes from the
// android-devtools getHierarchy stub below.
let currentTree: () => DescribeNode;
let currentFetch: (() => DescribeTreeData) | undefined;
vi.mock("../../src/tools/flows/flow-tree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/flows/flow-tree")>();
  return {
    fetchFlowTree: vi.fn(async (...args: Parameters<typeof actual.fetchFlowTree>) =>
      currentFetch ? currentFetch() : actual.fetchFlowTree(...args)
    ),
  };
});

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";

const ANDROID_DEVICE = "emulator-5554";
const IOS_DEVICE = "00000000-0000-0000-0000-0000000000ab";
let tmpDir: string;

interface Call {
  id: string;
  args: Record<string, unknown>;
  t: number;
}

const emailXml = (focused: boolean) => `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.EditText" resource-id="email" focused="${focused}" package="com.acme.app" bounds="[40,200][1040,280]" />
  </node>
</hierarchy>`;

function mockRegistry(calls: Call[], getHierarchy: () => { xml: string }): Registry {
  return {
    invokeTool: vi.fn(async (id: string, args: Record<string, unknown>) => {
      calls.push({ id, args, t: Date.now() });
      if (id === "list-devices") return { devices: [] };
      return { ok: true };
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    // The Android flow tree reads getHierarchy/getScreenSize off the resolved
    // android-devtools service; the iOS test never resolves a service (its
    // tree fetch is stubbed via `currentFetch`).
    resolveService: vi.fn(async () => ({
      getHierarchy: vi.fn(async () => getHierarchy()),
      getScreenSize: vi.fn(async () => ({ width: 1080, height: 1920 })),
    })),
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

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-type-"));
  currentFetch = undefined;
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("type directive focus wait", () => {
  it("waits for the tapped field to report focus before typing (android)", async () => {
    // Script the hierarchy by call count: reads 1-2 are the pre-tap settle
    // (identical, unfocused), read 3 is the focus poll's first look (focus not
    // landed yet), read 4 reports it — only then may the keyboard fire.
    let hierarchyReads = 0;
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => {
      hierarchyReads++;
      return { xml: emailXml(hierarchyReads >= 4) };
    });

    await writeFlow("login", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "a@b.com" }],
    });

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "login", project_root: tmpDir, device: ANDROID_DEVICE }
      )
    );

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["type:pass"]);
    expect(hierarchyReads).toBe(4);

    const tap = calls.find((c) => c.id === "gesture-tap");
    const keys = calls.filter((c) => c.id === "keyboard");
    expect(tap).toBeDefined();
    // Text first, then the submitting Enter as a separate call.
    expect(keys.map((c) => c.args.text ?? c.args.key)).toEqual(["a@b.com", "enter"]);
    // The gap covers the fixed settle (500ms) plus at least one poll interval
    // (300ms) before read 4 confirmed focus. setTimeout never fires early, so
    // the lower bound is safe to assert; no upper bound (CI jitter).
    expect(keys[0]!.t - tap!.t).toBeGreaterThanOrEqual(800);
  });

  it("skips the focus poll on a source that can't report focus", async () => {
    let axReads = 0;
    currentTree = () => {
      axReads++;
      return {
        role: "AXWindow",
        frame: { x: 0, y: 0, width: 1, height: 1 },
        children: [
          {
            role: "AXTextField",
            label: "Email",
            frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.06 },
            children: [],
          },
        ],
      };
    };
    currentFetch = () => ({ tree: currentTree(), source: "ax-service" });
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: emailXml(false) }));

    await writeFlow("ax-login", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { text: "Email" }, text: "a@b.com", submit: false }],
    });

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "ax-login", project_root: tmpDir, device: IOS_DEVICE }
      )
    );

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["type:pass"]);
    // Reads 1-2: pre-tap settle. Read 3: the focus wait's single look, after
    // which the ax-service source bails out instead of polling to the timeout.
    expect(axReads).toBe(3);

    const tap = calls.find((c) => c.id === "gesture-tap");
    const keys = calls.filter((c) => c.id === "keyboard");
    // submit: false — no trailing Enter.
    expect(keys.map((c) => c.args.text)).toEqual(["a@b.com"]);
    // The fixed settle still applies even without a focus-reporting source.
    expect(keys[0]!.t - tap!.t).toBeGreaterThanOrEqual(500);
  });

  // R7: `waitForFocus`'s verdict used to be discarded, so an unfocused field
  // was typed into anyway. The keys go to the HID layer, not to the element —
  // observed live as a dropped leading character that iOS autocorrect then
  // completed into a different word, which the app saved.
  it("retries the focus tap once when focus never lands (android)", async () => {
    const calls: Call[] = [];
    // The field takes focus only on the SECOND tap — the shape of a field
    // whose first tap was swallowed by a sheet still animating away.
    const registry = mockRegistry(calls, () => ({
      xml: emailXml(calls.filter((c) => c.id === "gesture-tap").length >= 2),
    }));

    await writeFlow("login", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "a@b.com" }],
    });

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "login", project_root: tmpDir, device: ANDROID_DEVICE }
      )
    );

    expect(result.ok).toBe(true);
    // Two focus taps, and the text was typed only after focus was confirmed.
    expect(calls.filter((c) => c.id === "gesture-tap")).toHaveLength(2);
    expect(calls.filter((c) => c.id === "keyboard").map((c) => c.args.text ?? c.args.key)).toEqual([
      "a@b.com",
      "enter",
    ]);
  }, 30_000);

  // A modal composer three quarters of the screen tall CONTAINS every node of
  // the screen behind it. Accepting a focused ancestor unconditionally let it
  // vouch for any of them, so `type:` reported a pass on a static label while
  // the keys — injected at the HID level — landed in the composer.
  it("does not let a huge focused element vouch for a small target behind it", async () => {
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({
      xml: `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.EditText" resource-id="composer" focused="true" package="com.acme.app" bounds="[100,100][1000,1500]" />
    <node index="1" class="android.widget.TextView" resource-id="tab-label" focused="false" package="com.acme.app" bounds="[200,300][400,340]" />
  </node>
</hierarchy>`,
    }));

    await writeFlow("behind", {
      executionPrerequisite: "composer open",
      steps: [{ kind: "type", into: { identifier: "tab-label" }, text: "WRONG", submit: false }],
    });

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        {
          name: "behind",
          project_root: tmpDir,
          device: ANDROID_DEVICE,
          prerequisiteAcknowledged: true,
        }
      )
    );

    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)!.reason).toContain("did not take keyboard focus");
    expect(calls.filter((c) => c.id === "keyboard")).toHaveLength(0);
  }, 30_000);

  // An EDITABLE ancestor never vouches, whatever its size: it is itself the
  // input that would swallow every key injected at HID level while the step
  // reports a pass on the covered element behind it.
  it("does not let an editable ancestor of any size vouch for an element behind it", async () => {
    const calls: Call[] = [];
    // The composer is only ~3x the label's area — inside the old 4x area
    // ratio, which is exactly why the size bound alone was not enough.
    const registry = mockRegistry(calls, () => ({
      xml: `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.EditText" resource-id="composer" focused="true" package="com.acme.app" bounds="[170,285][470,365]" />
    <node index="1" class="android.widget.TextView" resource-id="tab-label" focused="false" package="com.acme.app" bounds="[200,300][400,340]" />
  </node>
</hierarchy>`,
    }));

    await writeFlow("behind", {
      executionPrerequisite: "composer open",
      steps: [{ kind: "type", into: { identifier: "tab-label" }, text: "WRONG", submit: false }],
    });

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        {
          name: "behind",
          project_root: tmpDir,
          device: ANDROID_DEVICE,
          prerequisiteAcknowledged: true,
        }
      )
    );

    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)!.reason).toContain("did not take keyboard focus");
    expect(calls.filter((c) => c.id === "keyboard")).toHaveLength(0);
  }, 30_000);

  // A non-editable container cannot take HID text itself, so its focus flag
  // can only reflect a descendant — and genuine wrappers come in every size
  // (a shadow-DOM host, a tappable form row). Refusing them past an arbitrary
  // area ratio hard-fails fields that would accept the keys.
  it("accepts a focused non-editable wrapper far larger than the field", async () => {
    const calls: Call[] = [];
    // Row area is ~8x the field's — past any reasonable size bound — yet it is
    // the field's own wrapper, and the field accepts keys.
    const registry = mockRegistry(calls, () => ({
      xml: `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.LinearLayout" resource-id="email-row" focused="true" package="com.acme.app" bounds="[0,100][1080,700]">
      <node index="0" class="android.widget.EditText" resource-id="email" focused="false" package="com.acme.app" bounds="[40,200][1040,280]" />
    </node>
  </node>
</hierarchy>`,
    }));

    await writeFlow("wrapper", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "a@b.com", submit: false }],
    });

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "wrapper", project_root: tmpDir, device: ANDROID_DEVICE }
      )
    );

    expect(result.ok).toBe(true);
    expect(calls.filter((c) => c.id === "keyboard").map((c) => c.args.text)).toEqual(["a@b.com"]);
  }, 30_000);

  it("still accepts a focused wrapper close to the field's own size (android)", async () => {
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({
      xml: `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.LinearLayout" resource-id="email-row" focused="true" package="com.acme.app" bounds="[30,190][1050,290]">
      <node index="0" class="android.widget.EditText" resource-id="email" focused="false" package="com.acme.app" bounds="[40,200][1040,280]" />
    </node>
  </node>
</hierarchy>`,
    }));

    await writeFlow("wrapper", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "a@b.com", submit: false }],
    });

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "wrapper", project_root: tmpDir, device: ANDROID_DEVICE }
      )
    );

    expect(result.ok).toBe(true);
    expect(calls.filter((c) => c.id === "keyboard").map((c) => c.args.text)).toEqual(["a@b.com"]);
  }, 30_000);

  it("fails the step rather than typing into an unfocused field (android)", async () => {
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: emailXml(false) }));

    await writeFlow("login", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "a@b.com" }],
    });

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "login", project_root: tmpDir, device: ANDROID_DEVICE }
      )
    );

    expect(result.ok).toBe(false);
    const step = result.steps.at(-1)!;
    expect(step.status).toBe("fail");
    expect(step.reason).toContain("did not take keyboard focus");
    expect(step.reason).toContain("nothing was typed");
    // Two taps were attempted, and NOT ONE key was injected.
    expect(calls.filter((c) => c.id === "gesture-tap")).toHaveLength(2);
    expect(calls.filter((c) => c.id === "keyboard")).toHaveLength(0);
  }, 30_000);

  // The env-outage tier is the one focus verdict with no sibling: if it ever
  // collapsed into plain `unconfirmed`, an all-reads-throw devtools outage
  // would drop from `error` ("the app was never judged") to a hard `fail`,
  // which CI reads as an app regression. This test pins the distinction.
  it("reports an environment error, not a fail, when every read during the focus wait throws", async () => {
    const calls: Call[] = [];
    // Reads 1-2 are the pre-tap settle (must succeed, or the step ends before
    // any tap); from read 3 on — the focus wait's first look — every read
    // throws, as when native devtools disconnects mid-run.
    let reads = 0;
    const registry = mockRegistry(calls, () => {
      reads++;
      if (reads >= 3) throw new Error("devtools disconnected");
      return { xml: emailXml(false) };
    });

    await writeFlow("login", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "a@b.com", submit: false }],
    });

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "login", project_root: tmpDir, device: ANDROID_DEVICE }
      )
    );

    expect(result.ok).toBe(false);
    const step = result.steps.at(-1)!;
    // `error`, not `fail`: the runner scores indeterminate outcomes as errors,
    // so an environment outage can never read as an app regression.
    expect(step.status).toBe("error");
    expect(step.reason).toContain("could not read the UI tree");
    expect(step.reason).toContain("environment failure");
    // One focus tap happened; NOT ONE key was injected on an unknown-focus field.
    expect(calls.filter((c) => c.id === "gesture-tap")).toHaveLength(1);
    expect(calls.filter((c) => c.id === "keyboard")).toHaveLength(0);
  }, 30_000);

  describe("type: abort", () => {
    it("skips as aborted when the run is cancelled during the first focus wait", async () => {
      const controller = new AbortController();
      const calls: Call[] = [];
      // Reads 1-2 are the pre-tap settle; the focus wait then polls every
      // interval — cancel partway through that poll loop, before any key can
      // be dispatched against whatever the app has focused.
      let reads = 0;
      const registry = mockRegistry(calls, () => {
        reads++;
        if (reads >= 8) controller.abort();
        return { xml: emailXml(false) };
      });

      await writeFlow("login", {
        executionPrerequisite: "",
        steps: [{ kind: "type", into: { identifier: "email" }, text: "a@b.com", submit: false }],
      });

      const result = asRun(
        await createRunFlowTool(registry).execute(
          {},
          { name: "login", project_root: tmpDir, device: ANDROID_DEVICE },
          { signal: controller.signal } as never
        )
      );

      expect(result.ok).toBe(false);
      const step = result.steps.at(-1)!;
      expect(step.status).toBe("skip");
      expect(step.reason).toBe("run aborted");
      expect(calls.filter((c) => c.id === "gesture-tap")).toHaveLength(1);
      expect(calls.filter((c) => c.id === "keyboard")).toHaveLength(0);
    }, 30_000);

    it("skips as aborted when cancelled while resolving the field's frame", async () => {
      const controller = new AbortController();
      const calls: Call[] = [];
      // Cancel during the very first settle, before any tap exists to abort
      // mid-wait: `waitForFrame` must surface the cancel as an aborted skip,
      // never resolve a frame from a post-cancel read.
      let reads = 0;
      const registry = mockRegistry(calls, () => {
        reads++;
        if (reads >= 2) controller.abort();
        return { xml: emailXml(false) };
      });

      await writeFlow("login", {
        executionPrerequisite: "",
        steps: [{ kind: "type", into: { identifier: "email" }, text: "a@b.com", submit: false }],
      });

      const result = asRun(
        await createRunFlowTool(registry).execute(
          {},
          { name: "login", project_root: tmpDir, device: ANDROID_DEVICE },
          { signal: controller.signal } as never
        )
      );

      expect(result.ok).toBe(false);
      const step = result.steps.at(-1)!;
      expect(step.status).toBe("skip");
      expect(step.reason).toBe("run aborted");
      // Nothing was tapped or typed after the caller gave up.
      expect(calls.filter((c) => c.id === "gesture-tap")).toHaveLength(0);
      expect(calls.filter((c) => c.id === "keyboard")).toHaveLength(0);
    }, 30_000);

    it("skips as aborted when cancelled after the text lands but before the submit Enter", async () => {
      const controller = new AbortController();
      const calls: Call[] = [];
      // Focus lands on the first tap (no retry); the run is cancelled during
      // the keyboard-text call itself, so the pre-Enter re-check is the last
      // line that can stop a cancelled run from submitting.
      const registry = mockRegistry(calls, () => ({ xml: emailXml(true) }));
      const baseInvoke = registry.invokeTool as (
        id: string,
        args: Record<string, unknown>
      ) => Promise<unknown>;
      registry.invokeTool = (async (id: string, args: Record<string, unknown>) => {
        if (id === "keyboard" && typeof args.text === "string") controller.abort();
        return baseInvoke(id, args);
      }) as never;

      await writeFlow("login", {
        executionPrerequisite: "",
        steps: [{ kind: "type", into: { identifier: "email" }, text: "a@b.com" }],
      });

      const result = asRun(
        await createRunFlowTool(registry).execute(
          {},
          { name: "login", project_root: tmpDir, device: ANDROID_DEVICE },
          { signal: controller.signal } as never
        )
      );

      expect(result.ok).toBe(false);
      const step = result.steps.at(-1)!;
      expect(step.status).toBe("skip");
      expect(step.reason).toBe("run aborted");
      // The text went out; the submitting Enter must NOT have.
      expect(
        calls.filter((c) => c.id === "keyboard").map((c) => c.args.text ?? c.args.key)
      ).toEqual(["a@b.com"]);
    }, 30_000);
  });

  // The failure copy used to say "after two taps" even when the retry could
  // not re-find the field (it scrolled off / vanished during the keyboard
  // slide) and only one tap was ever made.
  it("does not claim a second tap it never made", async () => {
    const calls: Call[] = [];
    // The field exists until the first tap, then it is gone — nothing to
    // re-resolve, so the retry re-taps nothing.
    const registry = mockRegistry(calls, () => ({
      xml:
        calls.filter((c) => c.id === "gesture-tap").length === 0
          ? emailXml(false)
          : `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.TextView" resource-id="toast" focused="false" package="com.acme.app" bounds="[200,300][400,340]" />
  </node>
</hierarchy>`,
    }));

    await writeFlow("login", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "a@b.com", submit: false }],
    });

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "login", project_root: tmpDir, device: ANDROID_DEVICE }
      )
    );

    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)!.reason).toContain("after 1 tap");
    expect(result.steps.at(-1)!.reason).not.toContain("two taps");
    expect(calls.filter((c) => c.id === "gesture-tap")).toHaveLength(1);
    expect(calls.filter((c) => c.id === "keyboard")).toHaveLength(0);
  }, 60_000);

  // The Chromium walker reports the ARIA `role` attribute before the tag name,
  // so `<div role="textbox">` reaches the flow tree as "textbox" — not
  // "input"/"textarea". Missing it from the editable set let a rich-text
  // composer covering a label behind it vouch for that label and swallow the
  // keys, the same silent misdirection the size bound used to miss.
  it("treats an ARIA textbox ancestor as the input it is (chromium)", async () => {
    currentFetch = () => ({
      source: "cdp-dom",
      tree: {
        role: "Screen",
        frame: { x: 0, y: 0, width: 1, height: 1 },
        children: [
          {
            role: "textbox",
            identifier: "rich-editor",
            focused: true,
            frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.6 },
            children: [],
          },
          {
            role: "generic",
            identifier: "label-behind",
            focused: false,
            frame: { x: 0.4, y: 0.3, width: 0.2, height: 0.05 },
            children: [],
          },
        ],
      },
    });
    const calls: Call[] = [];
    // Device id is irrelevant — fetchFlowTree is stubbed wholesale.
    const registry = mockRegistry(calls, () => ({ xml: "" }));

    await writeFlow("aria", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "label-behind" }, text: "WRONG", submit: false }],
    });

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "aria", project_root: tmpDir, device: IOS_DEVICE }
      )
    );

    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)!.reason).toContain("did not take keyboard focus");
    expect(calls.filter((c) => c.id === "keyboard")).toHaveLength(0);
  }, 30_000);

  // Same mechanism, the other ARIA text-entry pattern: an aria-activedescendant
  // combobox takes DOM focus on the widget itself, so a focused combobox
  // covering elements behind it is exactly as capable of swallowing the keys.
  it("treats an ARIA combobox ancestor as the input it is (chromium)", async () => {
    currentFetch = () => ({
      source: "cdp-dom",
      tree: {
        role: "Screen",
        frame: { x: 0, y: 0, width: 1, height: 1 },
        children: [
          {
            role: "combobox",
            identifier: "picker-combo",
            focused: true,
            frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.6 },
            children: [],
          },
          {
            role: "generic",
            identifier: "label-behind",
            focused: false,
            frame: { x: 0.4, y: 0.3, width: 0.2, height: 0.05 },
            children: [],
          },
        ],
      },
    });
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: "" }));

    await writeFlow("aria-combo", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "label-behind" }, text: "WRONG", submit: false }],
    });

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "aria-combo", project_root: tmpDir, device: IOS_DEVICE }
      )
    );

    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)!.reason).toContain("did not take keyboard focus");
    expect(calls.filter((c) => c.id === "keyboard")).toHaveLength(0);
  }, 30_000);

  // A bare contenteditable div reports its raw tag as the role ("div"), so no
  // role test can recognize it — the walker surfaces it as editable: true
  // instead. Missing that flag let the editor covering an element behind it
  // vouch for it and swallow the keys while the step reported a pass.
  it("treats a focused contenteditable div ancestor as the input it is (chromium)", async () => {
    currentFetch = () => ({
      source: "cdp-dom",
      tree: {
        role: "Screen",
        frame: { x: 0, y: 0, width: 1, height: 1 },
        children: [
          {
            role: "div",
            identifier: "rich-editor",
            editable: true,
            focused: true,
            frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.6 },
            children: [],
          },
          {
            role: "generic",
            identifier: "label-behind",
            focused: false,
            frame: { x: 0.4, y: 0.3, width: 0.2, height: 0.05 },
            children: [],
          },
        ],
      },
    });
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: "" }));

    await writeFlow("aria-ce", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "label-behind" }, text: "WRONG", submit: false }],
    });

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "aria-ce", project_root: tmpDir, device: IOS_DEVICE }
      )
    );

    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)!.reason).toContain("did not take keyboard focus");
    expect(calls.filter((c) => c.id === "keyboard")).toHaveLength(0);
  }, 30_000);
});
