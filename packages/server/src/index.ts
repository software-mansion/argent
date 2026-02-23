import { config } from "./config";
import { createServer } from "./server";

const { app, shutdown } = createServer(config);

app.listen(config.port, () => {
  console.log(`radon-lite listening on port ${config.port}`);
  console.log(`  replay:      ${config.replay}`);
  console.log(`  showTouches: ${config.showTouches}`);
});

process.on("SIGTERM", () => { shutdown(); process.exit(0); });
process.on("SIGINT",  () => { shutdown(); process.exit(0); });
