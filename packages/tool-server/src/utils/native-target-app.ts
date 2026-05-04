import type { NativeAppState, NativeDevtoolsApi } from "../blueprints/native-devtools";

export type NativeTargetResolutionSource =
  | "explicit"
  | "single_connected_foreground_like"
  | "frontmost_detected";

export interface ResolvedNativeTargetApp {
  bundleId: string;
  source: NativeTargetResolutionSource;
}

export function chooseFrontmostConnectedApp(apps: NativeAppState[]): NativeAppState | null {
  const strongCandidates = apps.filter(
    (app) => app.applicationState === "active" || app.foregroundActiveSceneCount > 0
  );
  if (strongCandidates.length === 1) {
    return strongCandidates[0];
  }

  const weakCandidates = apps.filter(
    (app) => app.applicationState === "inactive" || app.foregroundInactiveSceneCount > 0
  );
  if (strongCandidates.length === 0 && weakCandidates.length === 1) {
    return weakCandidates[0];
  }

  return null;
}

export async function inspectConnectedNativeApps(
  api: NativeDevtoolsApi
): Promise<NativeAppState[]> {
  const bundleIds = api.listConnectedBundleIds();
  const appStates = await Promise.all(bundleIds.map((bundleId) => api.getAppState(bundleId)));
  return appStates.sort((a, b) => a.bundleId.localeCompare(b.bundleId));
}

export async function resolveNativeTargetApp(
  api: NativeDevtoolsApi,
  bundleId?: string
): Promise<ResolvedNativeTargetApp> {
  if (bundleId) {
    return { bundleId, source: "explicit" };
  }

  const connectedApps = await inspectConnectedNativeApps(api);
  if (connectedApps.length === 0) {
    throw new Error(
      "No native-devtools-connected apps are available for auto-targeting. " +
        "Launch or restart the app first, provide bundleId explicitly, or use screenshot to inspect visible Home/system UI."
    );
  }

  const frontmost = chooseFrontmostConnectedApp(connectedApps);
  if (connectedApps.length === 1) {
    if (frontmost) {
      return {
        bundleId: connectedApps[0].bundleId,
        source: "single_connected_foreground_like",
      };
    }
    const app = connectedApps[0];
    throw new Error(
      "A single native-devtools-connected app is available, but it is not foreground-like and may be backgrounded while home/system UI is visible.\n" +
        `- ${app.bundleId} (applicationState=${app.applicationState}, foregroundActiveScenes=${app.foregroundActiveSceneCount}, foregroundInactiveScenes=${app.foregroundInactiveSceneCount})\n` +
        "Provide bundleId explicitly if you still want to target this app."
    );
  }

  if (frontmost) {
    return { bundleId: frontmost.bundleId, source: "frontmost_detected" };
  }

  const appList = connectedApps
    .map(
      (app) =>
        `- ${app.bundleId} (applicationState=${app.applicationState}, foregroundActiveScenes=${app.foregroundActiveSceneCount}, foregroundInactiveScenes=${app.foregroundInactiveSceneCount})`
    )
    .join("\n");
  throw new Error(
    "Multiple native-devtools-connected apps are available and none can be identified as uniquely frontmost.\n" +
      `${appList}\n` +
      "Provide bundleId explicitly."
  );
}
