#!/usr/bin/env node
/**
 * End-to-end smoke test for physical-iOS support (experimental branch).
 *
 * Drives the real tool registry against a connected iPhone/iPad:
 *   list-devices -> launch-app -> describe -> gesture-tap -> describe -> screenshot
 *
 * Prerequisites (see packages/ios-device-runner/README.md):
 *   - `argent enable ios-physical-devices`
 *   - device paired + trusted, Developer Mode on, UNLOCKED, connected over USB
 *   - an Apple Development identity in the keychain (ARGENT_IOS_TEAM_ID is
 *     required unless argent can detect the team from the keychain)
 *   - workspace built (`npm run build`)
 *
 * Usage:
 *   E2E_UDID=<udid> E2E_BUNDLE_ID=host.exp.Exponent node scripts/e2e-ios-physical-device.mjs
 * UDID defaults to the first physical device found; bundle id to Expo Go.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// Relative specifiers, resolved by `require` against this file: a URL
// `pathname` is percent-encoded, so a checkout under a path with spaces would
// hand `require` a `%20` that no file matches.
const TS = "../packages/tool-server/dist";
const { createRegistry } = require(`${TS}/utils/setup-registry.js`);
const { listIosPhysicalDevices } = require(`${TS}/utils/ios-device/devicectl.js`);

const BUNDLE_ID = process.env.E2E_BUNDLE_ID || "host.exp.Exponent";

async function main() {
  const registry = createRegistry();
  let udid = process.env.E2E_UDID;
  if (!udid) {
    const devices = await listIosPhysicalDevices();
    if (devices.length === 0) throw new Error("No physical iOS device visible to devicectl.");
    udid = devices[0].udid;
  }
  console.log(`target: ${udid}, app: ${BUNDLE_ID}`);

  console.log("== list-devices ==");
  const list = await registry.invokeTool("list-devices", {});
  const phone = list.devices.find((d) => d.udid === udid);
  if (!phone || phone.kind !== "device") throw new Error("device not listed as kind 'device'");
  console.log(`listed: ${phone.name} (${phone.runtime})`);

  console.log("== launch-app ==");
  console.log(
    JSON.stringify(await registry.invokeTool("launch-app", { udid, bundleId: BUNDLE_ID }))
  );

  console.log("== describe (first call builds/starts the on-device runner) ==");
  const described = await registry.invokeTool("describe", { udid });
  console.log(`source: ${described.source}, lines: ${described.description.split("\n").length}`);
  console.log(described.description.split("\n").slice(0, 20).join("\n"));

  console.log("== gesture-tap center ==");
  console.log(JSON.stringify(await registry.invokeTool("gesture-tap", { udid, x: 0.5, y: 0.5 })));

  console.log("== describe after tap ==");
  const after = await registry.invokeTool("describe", { udid });
  console.log(`source: ${after.source}, lines: ${after.description.split("\n").length}`);

  console.log("== screenshot ==");
  const shot = await registry.invokeTool("screenshot", { udid, scale: 0.4 });
  console.log(`screenshot: ${shot.image.hostPath ?? JSON.stringify(shot.image)}`);

  // Dispose services so the detached on-device runner is shut down; without
  // this the xcodebuild child outlives the script (the blueprint's stale-
  // runner sweep would reap it on the next start, but exiting clean is nicer).
  await registry.dispose();
  console.log("E2E OK");
  process.exit(0);
}

main().catch((e) => {
  console.error("E2E FAIL:", e.message);
  if (e.hint) console.error("hint:", e.hint);
  process.exit(1);
});
