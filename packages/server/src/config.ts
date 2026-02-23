import { Config } from "./types/index";

function parseBool(value: string | undefined, defaultVal: boolean): boolean {
  if (value === undefined) return defaultVal;
  return value.toLowerCase() === "true" || value === "1";
}

function parseArgs(): Config {
  const args = process.argv.slice(2);

  let port = parseInt(process.env["PORT"] ?? "3000", 10);
  let replay = parseBool(process.env["REPLAY"], true);
  let showTouches = parseBool(process.env["SHOW_TOUCHES"], true);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--port" && args[i + 1]) {
      port = parseInt(args[++i]!, 10);
    } else if (arg === "--replay") {
      replay = true;
    } else if (arg === "--no-replay") {
      replay = false;
    } else if (arg === "--show-touches") {
      showTouches = true;
    } else if (arg === "--no-show-touches") {
      showTouches = false;
    }
  }

  return { port, replay, showTouches };
}

export const config: Config = parseArgs();
