import { createHttpApp } from "./http";
import { registry } from "./registry";
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

registry.register(listSimulatorsTool);
registry.register(bootSimulatorTool);
registry.register(simulatorServerTool);
registry.register(screenshotTool);
registry.register(tapTool);
registry.register(swipeTool);
registry.register(gestureTool);
registry.register(buttonTool);
registry.register(pasteTool);
registry.register(rotateTool);

const PORT = parseInt(process.env.PORT ?? "3001", 10);
const app = createHttpApp();

app.listen(PORT, () => {
  console.log(`Tools server listening on http://localhost:${PORT}`);
  console.log(`  GET  http://localhost:${PORT}/tools`);
  console.log(`  POST http://localhost:${PORT}/tools/:name`);
});
