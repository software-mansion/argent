import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { DeviceInfo, Registry, ToolContext } from "@argent/registry";
import { invokeSubTool } from "../../utils/sub-invoke";
import { fetchTree } from "../../utils/ui-tree-match";
import { nativeDevtoolsRef, type NativeDevtoolsApi } from "../../blueprints/native-devtools";
import { runAdb } from "../../utils/adb";
import type { DescribeNode } from "../describe/contract";
import type { CrawlDriver } from "./crawler";
import type { OpenUrlResult } from "../open-url/types";
import { screenKey, screenNodeCount } from "./fingerprint";
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
        // Measure "fullest" over the same nodes the key uses (scroll decorations
        // excluded), so a fading scroll indicator can't bias the pick.
        sizeOf: screenNodeCount,
        sleep: (ms) => delay(ms),
      });
    },

    async isTargetForeground(): Promise<boolean | null> {
      // Answers "is the app we're crawling actually on screen right now?" so the
      // crawler can tell an in-app screen from a foreign one it was bounced to (a
      // tap that opened Safari / the share sheet / Settings, or an Android tap
      // that opened the launcher or browser). This is the reliable signal iOS
      // otherwise lacks: the AX describe reads whichever app is frontmost, not
      // the target bundle, so a foreign tree comes back looking non-empty and
      // in-app. Returns true (confidently on screen), false (confidently gone),
      // or null (can't tell — the caller then keeps its prior behaviour).
      try {
        if (device.platform === "ios") {
          const ref = nativeDevtoolsRef(device);
          const api = await registry.resolveService<NativeDevtoolsApi>(ref.urn, ref.options);
          // Only apps reached through native-devtools expose a lifecycle state.
          // A never-connected app (non-RN, or injection failed) is unknowable
          // here — return null rather than force a spurious "left the app".
          if (!api.isConnected(bundleId)) return null;
          const st = await api.getAppState(bundleId);
          // Any foreground scene (active OR inactive — a system alert / in-app
          // permission dialog leaves the app inactive-but-foregrounded, and its
          // content is exactly what we still want to map) means on screen.
          if (st.foregroundActiveSceneCount > 0 || st.foregroundInactiveSceneCount > 0) return true;
          if (st.applicationState === "active" || st.applicationState === "inactive") return true;
          if (st.applicationState === "background") return false;
          return null;
        }
        if (device.platform === "android") {
          const { stdout } = await runAdb(
            ["-s", udid, "shell", "dumpsys", "activity", "activities"],
            {
              timeoutMs: 5_000,
            }
          );
          // The resumed activity is written "<package>/<activity>"; the label is
          // mResumedActivity on most API levels and topResumedActivity on newer
          // ones. The package here is the launch applicationId (suffix and all),
          // which is exactly what `bundleId` holds.
          const m =
            /(?:mResumedActivity|topResumedActivity)\b[^\n]*?\s([A-Za-z0-9_.]+)\/[A-Za-z0-9_.$]+/.exec(
              stdout
            );
          if (!m) return null;
          return m[1] === bundleId;
        }
        return null;
      } catch {
        // A downed service / dropped adb call must not be misread as "left the
        // app" — that would trigger spurious relaunches. Unknown = keep going.
        return null;
      }
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

    async openUrl(url: string): Promise<boolean> {
      // Seeds a deep-link entry point. The tool throws when nothing handles the
      // URI; the crawler treats that (and a link that opens Safari / leaves the
      // app, detected by the blank tree read afterwards) as a skip.
      const result = await invokeSubTool<OpenUrlResult>(registry, ctx, "open-url", { udid, url });
      return result.opened;
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
