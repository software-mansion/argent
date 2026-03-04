import { Registry } from "@radon-lite/registry";
import { simulatorServerBlueprint } from "./blueprints/simulator-server";
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
import { describeTool } from "./tools/describe";
import { activateLicenseKeyTool } from "./tools/activate-license-key";
import { activateSsoTool } from "./tools/activate-sso";
import { getLicenseStatusTool } from "./tools/get-license-status";
import { removeLicenseTool } from "./tools/remove-license";

export function createRegistry(): Registry {
  const registry = new Registry();

  registry.registerBlueprint(simulatorServerBlueprint);

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
  registry.registerTool(describeTool);
  registry.registerTool(activateLicenseKeyTool);
  registry.registerTool(activateSsoTool);
  registry.registerTool(getLicenseStatusTool);
  registry.registerTool(removeLicenseTool);

  return registry;
}
