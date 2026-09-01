import { describe, it, expect } from "vitest";
import { Registry } from "@argent/registry";
import { createBootDeviceTool } from "../src/tools/devices/boot-device";
import { reinstallAppTool } from "../src/tools/reinstall-app/index";
import { createRestartAppTool } from "../src/tools/restart-app/index";
import { createDescribeTool } from "../src/tools/describe/index";
import { createLaunchAppTool } from "../src/tools/launch-app/index";

/**
 * The MCP client aborts a tool call at FETCH_TIMEOUT_MS (30s) unless the tool
 * declares `longRunning`, and `fetchWithReconnect` then REPLAYS the same POST
 * up to MAX_RETRIES more times — see packages/argent-mcp/src/mcp-server.ts.
 * The server does not cancel the work an aborted request started, so a tool
 * whose own budget outlives the cap is not merely cut short: it is re-entered,
 * concurrently, against the same device.
 *
 * So a tool that can legitimately run past 30s MUST declare `longRunning`,
 * otherwise its server-side budget is unreachable by construction — the client
 * always gives up first. Each entry below names the budget the tool's own code
 * declares.
 */
const CAN_OUTLIVE_THE_CLIENT_CAP: ReadonlyArray<{
  name: string;
  budget: string;
  longRunning: boolean | undefined;
}> = [
  {
    name: "boot-device",
    // bootTimeoutMs default 480_000, max 900_000 (tools/devices/boot-device.ts)
    budget: "8 min default, 15 min max",
    longRunning: createBootDeviceTool(new Registry()).longRunning,
  },
  {
    name: "reinstall-app",
    // 30_000 uninstall + 180_000 install (reinstall-app/platforms/android.ts)
    budget: "210s on Android",
    longRunning: reinstallAppTool.longRunning,
  },
  {
    name: "restart-app",
    // 15_000 force-stop + 30_000 start + settle (restart-app/platforms/android.ts)
    budget: "~65s on Android",
    longRunning: createRestartAppTool(new Registry()).longRunning,
  },
  {
    name: "describe",
    // 30_000 android-devtools spawn + 20_000 uiautomator dump
    budget: "~50s on Android",
    longRunning: createDescribeTool(new Registry()).longRunning,
  },
  {
    name: "launch-app",
    // 10_000 resolve-activity + 30_000 am start (launch-app/platforms/android.ts)
    budget: "~40s on Android",
    longRunning: createLaunchAppTool(new Registry()).longRunning,
  },
];

describe("tools whose own budget outlives the MCP client's 30s cap declare longRunning", () => {
  it.each(CAN_OUTLIVE_THE_CLIENT_CAP)(
    "$name ($budget) is longRunning, so the client cannot abort and replay it",
    ({ longRunning }) => {
      expect(longRunning).toBe(true);
    }
  );
});
