import type { Registry } from "@argent/registry";
import { nativeDevtoolsStatusTool } from "./tools/native-devtools/native-devtools-status";
import { nativeNetworkLogsTool } from "./tools/native-devtools/native-network-logs";
import { nativeFindViewsTool } from "./tools/native-devtools/native-find-views";
import { nativeFullHierarchyTool } from "./tools/native-devtools/native-full-hierarchy";
import { nativeDescribeScreenTool } from "./tools/native-devtools/native-describe-screen";
import { nativeViewAtPointTool } from "./tools/native-devtools/native-view-at-point";
import { nativeUserInteractableViewAtPointTool } from "./tools/native-devtools/native-user-interactable-view-at-point";
import { listDevicesTool } from "./tools/devices/list-devices";
import { createBootDeviceTool } from "./tools/devices/boot-device";
import { launchAppTool } from "./tools/launch-app";
import { restartAppTool } from "./tools/restart-app";
import { reinstallAppTool } from "./tools/reinstall-app";
import { openUrlTool } from "./tools/open-url";
import { screenshotTool } from "./tools/screenshot";
import { gestureTapTool } from "./tools/gesture-tap";
import { gestureSwipeTool } from "./tools/gesture-swipe";
import { gestureCustomTool } from "./tools/gesture-custom";
import { gesturePinchTool } from "./tools/gesture-pinch";
import { gestureRotateTool } from "./tools/gesture-rotate";
import { buttonTool } from "./tools/button";
import { keyboardTool } from "./tools/keyboard";
import { rotateTool } from "./tools/rotate";
import { createRunSequenceTool } from "./tools/run-sequence";
import { debuggerConnectTool } from "./tools/debugger/debugger-connect";
import { debuggerStatusTool } from "./tools/debugger/debugger-status";
import { debuggerEvaluateTool } from "./tools/debugger/debugger-evaluate";
import { debuggerReloadMetroTool } from "./tools/debugger/debugger-reload-metro";
import { debuggerComponentTreeTool } from "./tools/debugger/debugger-component-tree";
import { debuggerInspectElementTool } from "./tools/debugger/debugger-inspect-element";
import { debuggerLogRegistryTool } from "./tools/debugger/debugger-log-registry";
import { networkLogsTool } from "./tools/network/network-logs";
import { networkRequestTool } from "./tools/network/network-request";
import { createDescribeTool } from "./tools/describe";
import { createReactProfilerStartTool } from "./tools/profiler/react/react-profiler-start";
import { createReactProfilerStopTool } from "./tools/profiler/react/react-profiler-stop";
import { createReactProfilerStatusTool } from "./tools/profiler/react/react-profiler-status";
import { reactProfilerAnalyzeTool } from "./tools/profiler/react/react-profiler-analyze";
import { reactProfilerComponentSourceTool } from "./tools/profiler/react/react-profiler-component-source";
import { reactProfilerCpuSummaryTool } from "./tools/profiler/react/react-profiler-cpu-summary";
import { reactProfilerRendersTool } from "./tools/profiler/react/react-profiler-renders";
import { reactProfilerFiberTreeTool } from "./tools/profiler/react/react-profiler-fiber-tree";
import { nativeProfilerStartTool } from "./tools/profiler/native-profiler/native-profiler-start";
import { nativeProfilerStopTool } from "./tools/profiler/native-profiler/native-profiler-stop";
import { nativeProfilerAnalyzeTool } from "./tools/profiler/native-profiler/native-profiler-analyze";
import { profilerCpuQueryTool } from "./tools/profiler/query/profiler-cpu-query";
import { profilerCommitQueryTool } from "./tools/profiler/query/profiler-commit-query";
import { profilerStackQueryTool } from "./tools/profiler/query/profiler-stack-query";
import { profilerCombinedReportTool } from "./tools/profiler/combined/profiler-combined-report";
import { profilerLoadTool } from "./tools/profiler/query/profiler-load";
import { createStopSimulatorServerTool } from "./tools/simulator/stop-simulator-server";
import { createStopAllSimulatorServersTool } from "./tools/simulator/stop-all-simulator-servers";
import { stopMetroTool } from "./tools/simulator/stop-metro";
import { flowStartRecordingTool } from "./tools/flows/flow-start-recording";
import { createFlowAddStepTool } from "./tools/flows/flow-add-step";
import { flowInsertEchoTool } from "./tools/flows/flow-insert-echo";
import { flowFinishRecordingTool } from "./tools/flows/flow-finish-recording";
import { createRunFlowTool } from "./tools/flows/flow-run";
import { flowReadPrerequisiteTool } from "./tools/flows/flow-read-prerequisite";
import { gatherWorkspaceDataTool } from "./tools/workspace/gather-workspace-data";
import { updateArgentTool } from "./tools/system/update-argent";
import { dismissUpdateTool } from "./tools/system/dismiss-update";
import { screenshotDiffTool } from "./tools/screenshot-diff";

/**
 * Every tool the tool-server registers, keyed by tool id. This map is the
 * single source of truth for the served tool set:
 *
 * - `setup-registry.ts` registers tools by iterating it, so a tool exists on
 *   the server iff it has an entry here.
 * - The SDK (`@argent/sdk`) imports `AllTools` TYPE-ONLY to derive its typed
 *   method surface from the same zod schemas the server validates with.
 *   Never import this module at runtime from client-side code — that would
 *   pull the entire tool-server into the client bundle.
 *
 * Key/id agreement is enforced by a test (tools-manifest.test.ts). Insertion
 * order is preserved by `GET /tools`, so keep related tools grouped.
 */
export function createAllTools(registry: Registry) {
  return {
    "list-devices": listDevicesTool,
    "boot-device": createBootDeviceTool(registry),
    "launch-app": launchAppTool,
    "restart-app": restartAppTool,
    "reinstall-app": reinstallAppTool,
    "open-url": openUrlTool,
    "screenshot": screenshotTool,
    "screenshot-diff": screenshotDiffTool,
    "gesture-tap": gestureTapTool,
    "gesture-swipe": gestureSwipeTool,
    "gesture-custom": gestureCustomTool,
    "gesture-pinch": gesturePinchTool,
    "gesture-rotate": gestureRotateTool,
    "button": buttonTool,
    "keyboard": keyboardTool,
    "rotate": rotateTool,
    "run-sequence": createRunSequenceTool(registry),
    "debugger-connect": debuggerConnectTool,
    "debugger-status": debuggerStatusTool,
    "debugger-evaluate": debuggerEvaluateTool,
    "debugger-reload-metro": debuggerReloadMetroTool,
    "debugger-component-tree": debuggerComponentTreeTool,
    "debugger-inspect-element": debuggerInspectElementTool,
    "debugger-log-registry": debuggerLogRegistryTool,
    "view-network-logs": networkLogsTool,
    "view-network-request-details": networkRequestTool,
    "describe": createDescribeTool(registry),
    "react-profiler-start": createReactProfilerStartTool(registry),
    "react-profiler-stop": createReactProfilerStopTool(registry),
    "react-profiler-status": createReactProfilerStatusTool(registry),
    "react-profiler-analyze": reactProfilerAnalyzeTool,
    "react-profiler-component-source": reactProfilerComponentSourceTool,
    "react-profiler-cpu-summary": reactProfilerCpuSummaryTool,
    "react-profiler-renders": reactProfilerRendersTool,
    "react-profiler-fiber-tree": reactProfilerFiberTreeTool,
    "native-profiler-start": nativeProfilerStartTool,
    "native-profiler-stop": nativeProfilerStopTool,
    "native-profiler-analyze": nativeProfilerAnalyzeTool,
    "profiler-cpu-query": profilerCpuQueryTool,
    "profiler-commit-query": profilerCommitQueryTool,
    "profiler-stack-query": profilerStackQueryTool,
    "profiler-combined-report": profilerCombinedReportTool,
    "profiler-load": profilerLoadTool,
    "gather-workspace-data": gatherWorkspaceDataTool,
    "native-devtools-status": nativeDevtoolsStatusTool,
    "native-network-logs": nativeNetworkLogsTool,
    "native-find-views": nativeFindViewsTool,
    "native-full-hierarchy": nativeFullHierarchyTool,
    "native-describe-screen": nativeDescribeScreenTool,
    "native-view-at-point": nativeViewAtPointTool,
    "native-user-interactable-view-at-point": nativeUserInteractableViewAtPointTool,
    "stop-simulator-server": createStopSimulatorServerTool(registry),
    "stop-all-simulator-servers": createStopAllSimulatorServersTool(registry),
    "stop-metro": stopMetroTool,
    "flow-start-recording": flowStartRecordingTool,
    "flow-add-step": createFlowAddStepTool(registry),
    "flow-add-echo": flowInsertEchoTool,
    "flow-finish-recording": flowFinishRecordingTool,
    "flow-read-prerequisite": flowReadPrerequisiteTool,
    "flow-execute": createRunFlowTool(registry),
    "update-argent": updateArgentTool,
    "dismiss-update": dismissUpdateTool,
  } as const;
}

/**
 * Tool-id → fully-typed ToolDefinition map. The SDK derives its entire typed
 * surface (param + result types per tool) from this single type.
 */
export type AllTools = ReturnType<typeof createAllTools>;
