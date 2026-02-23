import { config } from "./config";
import { createServer } from "./server";

const app = createServer(config);

app.listen(config.port, () => {
  console.log(`radon-lite listening on port ${config.port}`);
  console.log(`  replay:      ${config.replay}`);
  console.log(`  showTouches: ${config.showTouches}`);
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
