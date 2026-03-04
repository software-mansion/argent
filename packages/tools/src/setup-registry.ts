import { Registry } from "@radon-lite/registry";
import { simulatorServerBlueprint } from "./blueprints/simulator-server";
import { metroDebuggerBlueprint } from "./blueprints/metro-debugger";
import { listSimulatorsTool } from "./tools/list-simulators";
import { bootSimulatorTool } from "./tools/boot-simulator";
import { simulatorServerTool } from "./tools/simulator-server";
import { launchAppTool } from "./tools/launch-app";
import { openUrlTool } from "./tools/open-url";
import { screenshotTool } from "./tools/screenshot";
import { tapTool } from "./tools/tap";
import { swipeTool } from "./tools/swipe";
import { gestureTool } from "./tools/gesture";
import { buttonTool } from "./tools/button";
import { keyboardTool } from "./tools/keyboard";
import { rotateTool } from "./tools/rotate";
import { metroConnectTool } from "./tools/metro-connect";
import { metroStatusTool } from "./tools/metro-status";
import { metroEvaluateTool } from "./tools/metro-evaluate";
import { metroSetBreakpointTool } from "./tools/metro-set-breakpoint";
import { metroRemoveBreakpointTool } from "./tools/metro-remove-breakpoint";
import { metroPauseTool } from "./tools/metro-pause";
import { metroResumeTool } from "./tools/metro-resume";
import { metroStepTool } from "./tools/metro-step";
import { metroComponentTreeTool } from "./tools/metro-component-tree";
import { metroInspectElementTool } from "./tools/metro-inspect-element";
import { describeTool } from "./tools/describe";
import { activateLicenseKeyTool } from "./tools/activate-license-key";
import { activateSsoTool } from "./tools/activate-sso";
import { getLicenseStatusTool } from "./tools/get-license-status";
import { removeLicenseTool } from "./tools/remove-license";

export function createRegistry(): Registry {
  const registry = new Registry();

  registry.registerBlueprint(simulatorServerBlueprint);
  registry.registerBlueprint(metroDebuggerBlueprint);

  registry.registerTool(listSimulatorsTool);
  registry.registerTool(bootSimulatorTool);
  registry.registerTool(launchAppTool);
  registry.registerTool(openUrlTool);
  registry.registerTool(simulatorServerTool);
  registry.registerTool(screenshotTool);
  registry.registerTool(tapTool);
  registry.registerTool(swipeTool);
  registry.registerTool(gestureTool);
  registry.registerTool(buttonTool);
  registry.registerTool(keyboardTool);
  registry.registerTool(rotateTool);
  registry.registerTool(metroConnectTool);
  registry.registerTool(metroStatusTool);
  registry.registerTool(metroEvaluateTool);
  registry.registerTool(metroSetBreakpointTool);
  registry.registerTool(metroRemoveBreakpointTool);
  registry.registerTool(metroPauseTool);
  registry.registerTool(metroResumeTool);
  registry.registerTool(metroStepTool);
  registry.registerTool(metroComponentTreeTool);
  registry.registerTool(metroInspectElementTool);
  registry.registerTool(describeTool);
  registry.registerTool(activateLicenseKeyTool);
  registry.registerTool(activateSsoTool);
  registry.registerTool(getLicenseStatusTool);
  registry.registerTool(removeLicenseTool);

  return registry;
}
