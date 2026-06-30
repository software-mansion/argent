import type { DeviceInfo, Registry } from "@argent/registry";
import type { ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import type { DescribeTreeData } from "./contract";
import { describeIos } from "./platforms/ios";
import { describeAndroid } from "./platforms/android";
import { describeChromium } from "./platforms/chromium";

// Shared describe-tree fetch used by the tools that poll the accessibility / DOM
// tree (`await-ui-element`, `find`). iOS / Android resolve their AX /
// android-devtools services through the `registry` (not the calling tool's
// services() declaration); Chromium's CDP session flows in as a normal service.
// Kept in one place so both pollers fetch identically and stay in sync.
//
// `options.isTvOs` lets a polling caller pre-resolve the tvOS verdict once and
// pass it in, so the hot path doesn't re-shell `xcrun` on every poll iteration;
// omitted, `describeIos` probes it itself (fine for a single-shot fetch).
export async function fetchDescribeTree(
  registry: Registry,
  device: DeviceInfo,
  params: { bundleId?: string },
  services: Record<string, unknown>,
  options: { isTvOs?: boolean } = {}
): Promise<DescribeTreeData> {
  if (device.platform === "ios") {
    return describeIos(registry, device, { bundleId: params.bundleId }, { isTvOs: options.isTvOs });
  }
  if (device.platform === "android") {
    return describeAndroid(registry, device.id);
  }
  return describeChromium(services.chromium as ChromiumCdpApi);
}

// Fold an unreliable-read hint / restart prompt onto a not-found / timeout note
// so the agent learns the real cause (degraded AX, native injection pending)
// rather than a bare "no element matched". iOS `describeIos` attaches these to an
// empty tree instead of throwing; Android / Chromium never set them.
export function appendDescribeDiagnostics(base: string, data: DescribeTreeData | null): string {
  if (!data) return base;
  const extras: string[] = [];
  if (data.should_restart) {
    extras.push(
      "the foreground app may need a restart for native inspection — call restart-app and retry"
    );
  }
  if (data.hint) extras.push(data.hint);
  return extras.length === 0 ? base : `${base} (${extras.join("; ")})`;
}
