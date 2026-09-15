import type { DeviceInfo, Registry, ToolContext } from "@argent/registry";
import { invokeSubTool } from "../../utils/sub-invoke";
import { SECRET_PLACEHOLDER_MARKER } from "../../utils/secrets";
import { sleepOrAbort } from "../../utils/timing";
import {
  fetchTree,
  findAll as findAllNodes,
  firstInReadingOrder,
  isVisible,
  selectorToFrame,
  treeFingerprint,
  type Selector,
} from "../../utils/ui-tree-match";
import { getDescribeTapPoint, type DescribeNode } from "../describe/contract";
import {
  ScriptAbortError,
  StepFailedError,
  type FacadePoint,
  type FacadeSelector,
  type ScrollDirection,
  type Ui,
} from "./types";

// A tap can't land mid-fling, so re-read the tree until two consecutive reads
// match (a port of the flow runner's settle) before resolving a frame or judging
// an effect — bounded, then act on the latest read regardless.
const SETTLE_TIMEOUT_MS = 2000;
const SETTLE_POLL_MS = 250;

// Focus handshake before typing (port of flow-actions' `waitForFocus`): an
// unconditional head start, then a bounded poll on sources that report `focused`.
const TYPE_FOCUS_SETTLE_MS = 500;
const TYPE_FOCUS_TIMEOUT_MS = 1500;

const DEFAULT_MAX_SCROLLS = 10;
// Momentum-free swipe: gesture-swipe rejects `momentum:false` below 150ms, and a
// slower ease-out lands more precisely for a scroll-to loop.
const SCROLL_SWIPE_DURATION_MS = 600;

/** Everything a facade needs from the tool's `execute`, wired to the run deadline. */
export interface FacadeEnv {
  registry: Registry;
  device: DeviceInfo;
  /** Aborts when the run's deadline fires or the client disconnects. */
  signal: AbortSignal;
  /** Carries `signal` + the telemetry recorder into every sub-tool invocation. */
  subCtx: ToolContext | undefined;
  /** Called once at the start of every facade method, to count steps. */
  onStep: () => void;
  /**
   * Called when the facade forwards a `{{secret:…}}` placeholder to a text-entry
   * sub-tool. A script can build that marker dynamically, so the original
   * `params.script` carries no placeholder — this is the only place the use is
   * observable, and it drives the `secretsUsed` flag that tells the MCP layer to
   * skip the auto-capture that would otherwise leak the resolved plaintext.
   */
  onSecretUsed?: () => void;
}

function toSelector(selector: FacadeSelector): Selector {
  return selector as Selector;
}

function describeSelector(selector: FacadeSelector): string {
  return JSON.stringify(selector);
}

function hasAnyFocusFlag(root: DescribeNode): boolean {
  const walk = (node: DescribeNode): boolean => {
    if (node.focused !== undefined) return true;
    return node.children.some(walk);
  };
  return root.children.some(walk);
}

function scrollVector(direction: ScrollDirection): { from: FacadePoint; to: FacadePoint } {
  switch (direction) {
    case "down":
      return { from: { x: 0.5, y: 0.7 }, to: { x: 0.5, y: 0.3 } };
    case "up":
      return { from: { x: 0.5, y: 0.3 }, to: { x: 0.5, y: 0.7 } };
    case "right":
      return { from: { x: 0.7, y: 0.5 }, to: { x: 0.3, y: 0.5 } };
    case "left":
      return { from: { x: 0.3, y: 0.5 }, to: { x: 0.7, y: 0.5 } };
  }
}

export function buildUiFacade(env: FacadeEnv): Ui {
  const { registry, device, signal, subCtx, onStep, onSecretUsed } = env;

  const checkAbort = (): void => {
    if (signal.aborted) throw new ScriptAbortError();
  };

  const abortableSleep = async (ms: number): Promise<void> => {
    if (!(await sleepOrAbort(ms, signal))) throw new ScriptAbortError();
  };

  const readTree = async (): Promise<DescribeNode> => {
    checkAbort();
    return (await fetchTree(registry, device)).tree;
  };

  // Invoke a real tool as this script's step; a sub-tool failure becomes a
  // StepFailedError so the runtime can classify it as RUN_SCRIPT_STEP_FAILED.
  const sub = async <T = unknown>(
    tool: string,
    args: Record<string, unknown>,
    step: string
  ): Promise<T> => {
    checkAbort();
    // The text-entry sub-tools resolve `{{secret:…}}` before typing; flag the
    // run so the auto-capture that would render the plaintext back is skipped.
    if (
      (tool === "keyboard" || tool === "paste") &&
      typeof args.text === "string" &&
      args.text.includes(SECRET_PLACEHOLDER_MARKER)
    ) {
      onSecretUsed?.();
    }
    try {
      return await invokeSubTool<T>(registry, subCtx, tool, { ...args, udid: device.id });
    } catch (err) {
      if (err instanceof ScriptAbortError) throw err;
      throw new StepFailedError(step, err);
    }
  };

  // Re-read until two consecutive fingerprints match, bounded by SETTLE_TIMEOUT_MS.
  const settle = async (): Promise<DescribeNode> => {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    let previous: string | undefined;
    let latest = await readTree();
    while (true) {
      const fingerprint = treeFingerprint(latest);
      if (previous !== undefined && fingerprint === previous) return latest;
      if (Date.now() >= deadline) return latest;
      previous = fingerprint;
      await abortableSleep(SETTLE_POLL_MS);
      latest = await readTree();
    }
  };

  const waitForFocus = async (selector: FacadeSelector): Promise<void> => {
    await abortableSleep(TYPE_FOCUS_SETTLE_MS);
    const deadline = Date.now() + TYPE_FOCUS_TIMEOUT_MS;
    const sel = toSelector(selector);
    while (Date.now() < deadline) {
      const root = await readTree();
      if (findAllNodes(root, sel).some((node) => node.focused === true)) return;
      // A source that never reports `focused` would burn the whole budget; the
      // unconditional head start is the guarantee there, so stop polling.
      if (!hasAnyFocusFlag(root)) return;
      await abortableSleep(SETTLE_POLL_MS);
    }
  };

  const tapFrame = async (selector: FacadeSelector, step: string): Promise<DescribeNode> => {
    const root = await settle();
    const frame = selectorToFrame(root, toSelector(selector));
    if (!frame) {
      throw new StepFailedError(
        step,
        new Error(`no visible element matched ${describeSelector(selector)}`)
      );
    }
    const point = getDescribeTapPoint(frame);
    await sub("gesture-tap", { x: point.x, y: point.y }, step);
    return root;
  };

  return {
    async describe() {
      onStep();
      return readTree();
    },

    async find(selector) {
      onStep();
      const root = await readTree();
      const matches = findAllNodes(root, toSelector(selector));
      return firstInReadingOrder(matches.filter(isVisible)) ?? matches[0] ?? null;
    },

    async findAll(selector) {
      onStep();
      const root = await readTree();
      return findAllNodes(root, toSelector(selector));
    },

    async exists(selector) {
      onStep();
      const root = await readTree();
      return findAllNodes(root, toSelector(selector)).length > 0;
    },

    async visible(selector) {
      onStep();
      const root = await readTree();
      return findAllNodes(root, toSelector(selector)).some(isVisible);
    },

    async tap(selector) {
      onStep();
      const before = await tapFrame(selector, "tap");
      const beforeFingerprint = treeFingerprint(before);
      const after = await settle();
      if (treeFingerprint(after) === beforeFingerprint) {
        throw new StepFailedError(
          "tap",
          new Error(
            `tap on ${describeSelector(selector)} produced no visible change — the tap may have been lost (iOS taps are fire-and-forget); retry or use ui.tapPoint`
          )
        );
      }
    },

    async tapPoint(x, y) {
      onStep();
      await sub("gesture-tap", { x, y }, "tapPoint");
    },

    async fill(selector, text, opts) {
      onStep();
      await tapFrame(selector, "fill");
      await waitForFocus(selector);
      if (opts?.mode === "paste") await sub("paste", { text }, "fill");
      else await sub("keyboard", { text }, "fill");
    },

    async pressKey(key) {
      onStep();
      await sub("keyboard", { key }, "pressKey");
    },

    async button(name) {
      onStep();
      await sub("button", { button: name }, "button");
    },

    async swipe(from, to, opts) {
      onStep();
      const momentum = opts?.momentum ?? false;
      const args: Record<string, unknown> = {
        fromX: from.x,
        fromY: from.y,
        toX: to.x,
        toY: to.y,
        momentum,
      };
      const durationMs = opts?.durationMs ?? (momentum ? undefined : SCROLL_SWIPE_DURATION_MS);
      if (durationMs !== undefined) args.durationMs = durationMs;
      await sub("gesture-swipe", args, "swipe");
    },

    async scrollUntilVisible(selector, opts) {
      onStep();
      const maxScrolls = opts?.maxScrolls ?? DEFAULT_MAX_SCROLLS;
      const direction = opts?.direction ?? "down";
      const sel = toSelector(selector);
      for (let i = 0; i <= maxScrolls; i++) {
        const root = await settle();
        if (findAllNodes(root, sel).some(isVisible)) return true;
        if (i === maxScrolls) break;
        const before = treeFingerprint(root);
        const { from, to } = scrollVector(direction);
        await sub(
          "gesture-swipe",
          {
            fromX: from.x,
            fromY: from.y,
            toX: to.x,
            toY: to.y,
            momentum: false,
            durationMs: SCROLL_SWIPE_DURATION_MS,
          },
          "scrollUntilVisible"
        );
        const after = await settle();
        // No fingerprint change means the container did not move — end of scroll.
        if (treeFingerprint(after) === before) break;
      }
      return false;
    },

    async await(condition, selector, opts) {
      onStep();
      const step = `await(${condition})`;
      const args: Record<string, unknown> = { condition, selector };
      if (opts?.timeoutMs !== undefined) args.timeoutMs = opts.timeoutMs;
      if (opts?.expectedText !== undefined) args.expectedText = opts.expectedText;
      if (opts?.textMatch !== undefined) args.textMatch = opts.textMatch;
      const result = await sub<{ success?: boolean; note?: string; cause?: string }>(
        "await-ui-element",
        args,
        step
      );
      if (result && typeof result === "object" && result.success === false) {
        const cause = result.cause ? ` [${result.cause}]` : "";
        const note = result.note ? `: ${result.note}` : "";
        throw new StepFailedError(step, new Error(`condition not met${cause}${note}`));
      }
    },

    async awaitIdle(opts) {
      onStep();
      const args: Record<string, unknown> = {};
      if (opts?.timeoutMs !== undefined) args.timeoutMs = opts.timeoutMs;
      if (opts?.minStableMs !== undefined) args.minStableMs = opts.minStableMs;
      await sub("await-screen-idle", args, "awaitIdle");
    },

    async launchApp(bundleId) {
      onStep();
      await sub("launch-app", { bundleId }, "launchApp");
    },

    async openUrl(url) {
      onStep();
      await sub("open-url", { url }, "openUrl");
    },

    async sleep(ms) {
      onStep();
      await abortableSleep(ms);
    },
  };
}
