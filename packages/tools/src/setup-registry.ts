import { Registry } from "@radon-lite/registry";
import { simulatorServerBlueprint } from "./blueprints/simulator-server";
import { listSimulatorsTool } from "./tools/list-simulators";
import { bootSimulatorTool } from "./tools/boot-simulator";
import { simulatorServerTool } from "./tools/simulator-server";
import { screenshotTool } from "./tools/screenshot";
import { tapTool } from "./tools/tap";
import { swipeTool } from "./tools/swipe";
import { gestureTool } from "./tools/gesture";
import { buttonTool } from "./tools/button";
import { pasteTool } from "./tools/paste";
import { rotateTool } from "./tools/rotate";
import { activateLicenseKeyTool } from "./tools/activate-license-key";
import { activateSsoTool } from "./tools/activate-sso";
import { getLicenseStatusTool } from "./tools/get-license-status";
import { removeLicenseTool } from "./tools/remove-license";

export function createRegistry(): Registry {
  const registry = new Registry();

  registry.registerBlueprint(simulatorServerBlueprint);

  registry.registerTool(listSimulatorsTool);
  registry.registerTool(bootSimulatorTool);
  registry.registerTool(simulatorServerTool);
  registry.registerTool(screenshotTool);
  registry.registerTool(tapTool);
  registry.registerTool(swipeTool);
  registry.registerTool(gestureTool);
  registry.registerTool(buttonTool);
  registry.registerTool(pasteTool);
  registry.registerTool(rotateTool);
  registry.registerTool(activateLicenseKeyTool);
  registry.registerTool(activateSsoTool);
  registry.registerTool(getLicenseStatusTool);
  registry.registerTool(removeLicenseTool);

  return registry;
}
