import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { DeviceInfo, Registry, ToolContext } from "@argent/registry";
import { invokeSubTool } from "../../utils/sub-invoke";
import { fetchTree } from "../../utils/ui-tree-match";
import type { DescribeNode } from "../describe/contract";
import type { CrawlDriver } from "./crawler";
import { screenKey } from "./fingerprint";
import { fetchStableTree } from "./stable-tree";

/**
 * The real {@link CrawlDriver}: every primitive dispatches an existing Argent
 * tool through `registry.invokeTool` (via `invokeSubTool`, so the outer
 * request's abort signal and telemetry attribution propagate to every nested
 * gesture), except the tree read, which uses the internal `fetchTree` — the
 * public `describe` tool only returns rendered text, and the crawler needs the
 * raw structured tree.
 */

// Settle window between crawl steps: short (a crawl takes hundreds of steps)
// but long enough for a push transition; an unsettled screen is not an error —
// the crawler re-reads the tree regardless.
const SETTLE_TIMEOUT_MS = 4_000;
const SETTLE_MIN_STABLE_MS = 800;

export interface MapDriverOptions {
  registry: Registry;
  ctx: ToolContext | undefined;
  device: DeviceInfo;
  bundleId: string;
  /** Per-crawl directory screenshots are copied into (see map-session). */
  screenshotDir: string;
}

export function createMapDriver(opts: MapDriverOptions): CrawlDriver {
  const { registry, ctx, device, bundleId, screenshotDir } = opts;
  const udid = device.id;
  return {
    async fetchTree(): Promise<DescribeNode> {
      // Sampled, not single-shot: iOS AX trees oscillate on an idle screen
      // (content nodes appear late and can drop out again), and one arbitrary
      // sample would flip the screen fingerprint between visits — see
      // stable-tree.ts.
      return fetchStableTree({
        fetch: async () => (await fetchTree(registry, device, { bundleId })).tree,
        keyOf: screenKey,
        sleep: (ms) => delay(ms),
      });
    },

    async tap(x: number, y: number): Promise<void> {
      await invokeSubTool(registry, ctx, "gesture-tap", { udid, x, y });
    },

    async pressBack(): Promise<boolean> {
      if (device.platform !== "android") return false;
      await invokeSubTool(registry, ctx, "button", { udid, button: "back" });
      return true;
    },

    async restartApp(): Promise<void> {
      await invokeSubTool(registry, ctx, "restart-app", { udid, bundleId });
    },

    async launchApp(): Promise<void> {
      await invokeSubTool(registry, ctx, "launch-app", { udid, bundleId });
    },

    async awaitSettle(): Promise<void> {
      try {
        await invokeSubTool(registry, ctx, "await-screen-idle", {
          udid,
          timeoutMs: SETTLE_TIMEOUT_MS,
          minStableMs: SETTLE_MIN_STABLE_MS,
        });
      } catch {
        // Best-effort: an unsettled or momentarily unreadable screen must not
        // kill the crawl — the crawler re-reads the tree right after anyway.
      }
    },

    async screenshot(nodeId: string): Promise<string | null> {
      // Best-effort: a screen without a thumbnail is still a mapped screen.
      try {
        const result = await invokeSubTool<{ image: { hostPath: string } }>(
          registry,
          ctx,
          "screenshot",
          { udid, includeImageInContext: false }
        );
        await fsp.mkdir(screenshotDir, { recursive: true });
        // `nodeId` is store-minted ("s0", "s1", …), never caller input, so it
        // is always a safe single path segment.
        const dest = path.join(screenshotDir, `${nodeId}.png`);
        await fsp.copyFile(result.image.hostPath, dest);
        return dest;
      } catch {
        return null;
      }
    },

    now: () => Date.now(),
  };
}
