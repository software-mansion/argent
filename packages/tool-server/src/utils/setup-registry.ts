import { Registry } from "@argent/registry";
import { isFlagEnabled } from "@argent/configuration-core";
import { simulatorServerBlueprint } from "../blueprints/simulator-server";
import { nativeDevtoolsBlueprint } from "../blueprints/native-devtools";
import { androidDevtoolsBlueprint } from "../blueprints/android-devtools";
import { axServiceBlueprint } from "../blueprints/ax-service";
import { chromiumCdpBlueprint } from "../blueprints/chromium-cdp";
import { chromiumJsRuntimeDebuggerBlueprint } from "../blueprints/chromium-js-runtime-debugger";
import { tvControlBlueprint } from "../blueprints/tv-control";
import { androidTvControlBlueprint } from "../blueprints/android-tv-control";
import { nativeDevtoolsStatusTool } from "../tools/native-devtools/native-devtools-status";
import { nativeNetworkLogsTool } from "../tools/native-devtools/native-network-logs";
import { nativeFindViewsTool } from "../tools/native-devtools/native-find-views";
import { nativeFullHierarchyTool } from "../tools/native-devtools/native-full-hierarchy";
import { nativeDescribeScreenTool } from "../tools/native-devtools/native-describe-screen";
import { nativeViewAtPointTool } from "../tools/native-devtools/native-view-at-point";
import { nativeUserInteractableViewAtPointTool } from "../tools/native-devtools/native-user-interactable-view-at-point";
import { jsRuntimeDebuggerBlueprint } from "../blueprints/js-runtime-debugger";
import { networkInspectorBlueprint } from "../blueprints/network-inspector";
import { reactProfilerSessionBlueprint } from "../blueprints/react-profiler-session";
import { listDevicesTool } from "../tools/devices/list-devices";
import { createBootDeviceTool } from "../tools/devices/boot-device";
import { createLaunchAppTool } from "../tools/launch-app";
import { createRestartAppTool } from "../tools/restart-app";
import { reinstallAppTool } from "../tools/reinstall-app";
import { openUrlTool } from "../tools/open-url";
import { createScreenshotTool } from "../tools/screenshot";
import { gestureTapTool } from "../tools/gesture-tap";
import { gestureSwipeTool } from "../tools/gesture-swipe";
import { gestureScrollTool } from "../tools/gesture-scroll";
import { gestureDragTool } from "../tools/gesture-drag";
import { gestureCustomTool } from "../tools/gesture-custom";
import { gesturePinchTool } from "../tools/gesture-pinch";
import { gestureRotateTool } from "../tools/gesture-rotate";
import { buttonTool } from "../tools/button";
import { createKeyboardTool } from "../tools/keyboard";
import { rotateTool } from "../tools/rotate";
import { createTvRemoteTool } from "../tools/tv-remote";
import { createRunSequenceTool } from "../tools/run-sequence";
import { debuggerConnectTool } from "../tools/debugger/debugger-connect";
import { debuggerStatusTool } from "../tools/debugger/debugger-status";
import { debuggerEvaluateTool } from "../tools/debugger/debugger-evaluate";
import { debuggerReloadMetroTool } from "../tools/debugger/debugger-reload-metro";
import { debuggerComponentTreeTool } from "../tools/debugger/debugger-component-tree";
import { debuggerInspectElementTool } from "../tools/debugger/debugger-inspect-element";
import { debuggerLogRegistryTool } from "../tools/debugger/debugger-log-registry";
import { networkLogsTool } from "../tools/network/network-logs";
import { networkRequestTool } from "../tools/network/network-request";
import { createDescribeTool } from "../tools/describe";
import { createAwaitUiElementTool } from "../tools/await-ui-element";
import { createReactProfilerStartTool } from "../tools/profiler/react/react-profiler-start";
import { createReactProfilerStopTool } from "../tools/profiler/react/react-profiler-stop";
import { createReactProfilerStatusTool } from "../tools/profiler/react/react-profiler-status";
import { reactProfilerAnalyzeTool } from "../tools/profiler/react/react-profiler-analyze";
import { reactProfilerComponentSourceTool } from "../tools/profiler/react/react-profiler-component-source";
import { reactProfilerCpuSummaryTool } from "../tools/profiler/react/react-profiler-cpu-summary";
import { reactProfilerRendersTool } from "../tools/profiler/react/react-profiler-renders";
import { reactProfilerFiberTreeTool } from "../tools/profiler/react/react-profiler-fiber-tree";
import { nativeProfilerStartTool } from "../tools/profiler/native-profiler/native-profiler-start";
import { nativeProfilerStopTool } from "../tools/profiler/native-profiler/native-profiler-stop";
import { nativeProfilerAnalyzeTool } from "../tools/profiler/native-profiler/native-profiler-analyze";
import { nativeProfilerSessionBlueprint } from "../blueprints/native-profiler-session";
import { profilerCpuQueryTool } from "../tools/profiler/query/profiler-cpu-query";
import { profilerCommitQueryTool } from "../tools/profiler/query/profiler-commit-query";
import { profilerStackQueryTool } from "../tools/profiler/query/profiler-stack-query";
import { profilerCombinedReportTool } from "../tools/profiler/combined/profiler-combined-report";
import { profilerLoadTool } from "../tools/profiler/query/profiler-load";
import { createStopSimulatorServerTool } from "../tools/simulator/stop-simulator-server";
import { createStopAllSimulatorServersTool } from "../tools/simulator/stop-all-simulator-servers";
import { stopMetroTool } from "../tools/simulator/stop-metro";
import { flowStartRecordingTool } from "../tools/flows/flow-start-recording";
import { createFlowAddStepTool } from "../tools/flows/flow-add-step";
import { flowInsertEchoTool } from "../tools/flows/flow-insert-echo";
import { flowFinishRecordingTool } from "../tools/flows/flow-finish-recording";
import { createRunFlowTool } from "../tools/flows/flow-run";
import { flowReadPrerequisiteTool } from "../tools/flows/flow-read-prerequisite";
import { gatherWorkspaceDataTool } from "../tools/workspace/gather-workspace-data";
import { updateArgentTool } from "../tools/system/update-argent";
import { dismissUpdateTool } from "../tools/system/dismiss-update";
import { screenshotDiffTool } from "../tools/screenshot-diff";
import { createProposeVariantTool } from "../tools/variants/propose-variant";
import { awaitUserSelectionTool } from "../tools/variants/await-user-selection";
import { chromiumTabsTool } from "../tools/chromium-tabs";
import { chromiumCookiesTool } from "../tools/chromium-cookies";
import { chromiumStorageTool } from "../tools/chromium-storage";

export function createRegistry(): Registry {
  // Inject the real feature-flag check so the gate is enforced for EVERY
  // dispatch path (flow-execute, flow-add-step, run-sequence) — not only the
  // HTTP edge in http.ts. Re-read per invocation, so `argent enable/disable
  // <flag>` takes effect without restarting the long-lived tool-server.
  const registry = new Registry({ isFlagEnabled: (flag) => isFlagEnabled(flag) });

  registry.registerBlueprint(simulatorServerBlueprint);
  registry.registerBlueprint(jsRuntimeDebuggerBlueprint);
  registry.registerBlueprint(networkInspectorBlueprint);
  registry.registerBlueprint(reactProfilerSessionBlueprint);
  registry.registerBlueprint(nativeProfilerSessionBlueprint);
  registry.registerBlueprint(nativeDevtoolsBlueprint);
  registry.registerBlueprint(androidDevtoolsBlueprint);
  registry.registerBlueprint(axServiceBlueprint);
  registry.registerBlueprint(chromiumCdpBlueprint);
  registry.registerBlueprint(chromiumJsRuntimeDebuggerBlueprint);
  registry.registerBlueprint(tvControlBlueprint);
  registry.registerBlueprint(androidTvControlBlueprint);

  registry.registerTool(listDevicesTool);
  registry.registerTool(createBootDeviceTool(registry));
  registry.registerTool(createLaunchAppTool(registry));
  registry.registerTool(createRestartAppTool(registry));
  registry.registerTool(reinstallAppTool);
  registry.registerTool(openUrlTool);
  registry.registerTool(createScreenshotTool(registry));
  registry.registerTool(screenshotDiffTool);
  registry.registerTool(gestureTapTool);
  registry.registerTool(chromiumTabsTool);
  registry.registerTool(chromiumCookiesTool);
  registry.registerTool(chromiumStorageTool);
  registry.registerTool(gestureSwipeTool);
  registry.registerTool(gestureScrollTool);
  registry.registerTool(gestureDragTool);
  registry.registerTool(gestureCustomTool);
  registry.registerTool(gesturePinchTool);
  registry.registerTool(gestureRotateTool);
  registry.registerTool(buttonTool);
  registry.registerTool(createKeyboardTool(registry));
  registry.registerTool(rotateTool);
  registry.registerTool(createTvRemoteTool(registry));
  registry.registerTool(createRunSequenceTool(registry));
  registry.registerTool(debuggerConnectTool);
  registry.registerTool(debuggerStatusTool);
  registry.registerTool(debuggerEvaluateTool);
  registry.registerTool(debuggerReloadMetroTool);
  registry.registerTool(debuggerComponentTreeTool);
  registry.registerTool(debuggerInspectElementTool);
  registry.registerTool(debuggerLogRegistryTool);
  registry.registerTool(networkLogsTool);
  registry.registerTool(networkRequestTool);
  registry.registerTool(createDescribeTool(registry));
  registry.registerTool(createAwaitUiElementTool(registry));
  registry.registerTool(createReactProfilerStartTool(registry));
  registry.registerTool(createReactProfilerStopTool(registry));
  registry.registerTool(createReactProfilerStatusTool(registry));
  registry.registerTool(reactProfilerAnalyzeTool);
  registry.registerTool(reactProfilerComponentSourceTool);
  registry.registerTool(reactProfilerCpuSummaryTool);
  registry.registerTool(reactProfilerRendersTool);
  registry.registerTool(reactProfilerFiberTreeTool);
  registry.registerTool(nativeProfilerStartTool);
  registry.registerTool(nativeProfilerStopTool);
  registry.registerTool(nativeProfilerAnalyzeTool);
  registry.registerTool(profilerCpuQueryTool);
  registry.registerTool(profilerCommitQueryTool);
  registry.registerTool(profilerStackQueryTool);
  registry.registerTool(profilerCombinedReportTool);
  registry.registerTool(profilerLoadTool);
  registry.registerTool(gatherWorkspaceDataTool);
  registry.registerTool(nativeDevtoolsStatusTool);
  registry.registerTool(nativeNetworkLogsTool);
  registry.registerTool(nativeFindViewsTool);
  registry.registerTool(nativeFullHierarchyTool);
  registry.registerTool(nativeDescribeScreenTool);
  registry.registerTool(nativeViewAtPointTool);
  registry.registerTool(nativeUserInteractableViewAtPointTool);

  // Cleanup tools (close over registry for direct service disposal)
  registry.registerTool(createStopSimulatorServerTool(registry));
  registry.registerTool(createStopAllSimulatorServersTool(registry));
  registry.registerTool(stopMetroTool);

  // Flow tools
  registry.registerTool(flowStartRecordingTool);
  registry.registerTool(createFlowAddStepTool(registry));
  registry.registerTool(flowInsertEchoTool);
  registry.registerTool(flowFinishRecordingTool);
  registry.registerTool(flowReadPrerequisiteTool);
  registry.registerTool(createRunFlowTool(registry));

  // System tools
  registry.registerTool(updateArgentTool);
  registry.registerTool(dismissUpdateTool);

  // Variant proposal tools (non-blocking propose + single blocking await).
  // Both declare `featureFlag: "argent-lens"`, so the HTTP layer
  // (http.ts) hides them from GET /tools and rejects invocation when the flag
  // is off — re-checked on every request, so `argent enable/disable
  // argent-lens` takes effect on the next tools/list WITHOUT restarting
  // the long-lived tool-server. Registered unconditionally; the flag gates at
  // the exposure boundary, not at registration.
  registry.registerTool(createProposeVariantTool(registry));
  registry.registerTool(awaitUserSelectionTool);

  return registry;
}
