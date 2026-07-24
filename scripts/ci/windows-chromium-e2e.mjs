// End-to-end smoke for Argent's Chromium (CDP) control plane on a host with no
// virtualization — the path that makes "Argent on Windows" real for Electron /
// Chrome apps. Chromium control is pure host-side TypeScript + CDP (the Rust
// simulator-server is not involved), so it runs anywhere Node + Chrome run,
// which is exactly what lets a hosted Windows runner verify it.
//
// Drives the running tool-server over HTTP exactly as an MCP client would:
//   list-devices → screenshot → describe → gesture-tap → describe (observe the
//   DOM change the tap caused).
//
// Cross-platform: also runnable on macOS/Linux for local debugging. Env:
//   ARGENT_E2E_URL   base tool-server URL (default http://127.0.0.1:3033)
//   ARGENT_E2E_OUT   directory for screenshot artifacts (default os.tmpdir())

import { mkdirSync, copyFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.ARGENT_E2E_URL ?? "http://127.0.0.1:3033";
const OUT = process.env.ARGENT_E2E_OUT ?? tmpdir();
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg, extra) {
  console.error(`\n❌ E2E FAILED: ${msg}`);
  if (extra !== undefined)
    console.error(typeof extra === "string" ? extra : JSON.stringify(extra, null, 2));
  process.exit(1);
}

/** POST /tools/<name>; returns the tool's `data` payload, or throws on error. */
async function callTool(name, body = {}) {
  const res = await fetch(`${BASE}/tools/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${name}: non-JSON response (${res.status}): ${text.slice(0, 300)}`);
  }
  if (!res.ok || json.error) {
    throw new Error(
      `${name}: HTTP ${res.status} ${json.error ? `- ${json.error}` : text.slice(0, 300)}`
    );
  }
  return json.data ?? json;
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/tools`);
      if (res.ok) {
        console.log(`✓ tool-server up at ${BASE} (t+${i}s)`);
        return;
      }
    } catch {
      // not up yet
    }
    await sleep(1000);
  }
  fail(`tool-server never responded at ${BASE}/tools within 60s`);
}

async function main() {
  await waitForServer();

  // 1) Discover the running Chromium instance via CDP port probing.
  const devices = await callTool("list-devices");
  const list = devices.devices ?? [];
  console.log(
    `list-devices → ${list.length} device(s): ${list.map((d) => `${d.platform}:${d.id ?? d.udid ?? d.serial}`).join(", ") || "(none)"}`
  );
  const chromium = list.find((d) => d.platform === "chromium");
  if (!chromium)
    fail(
      "no chromium device discovered — is Chrome running with --remote-debugging-port?",
      devices
    );
  const udid = chromium.id;
  console.log(`✓ discovered chromium device: ${udid}`);

  // 2) Screenshot returns real pixels (not an empty/0-byte frame).
  const shot = await callTool("screenshot", { udid });
  const hostPath = shot?.image?.hostPath;
  if (!hostPath || !existsSync(hostPath)) fail("screenshot returned no readable hostPath", shot);
  const size = statSync(hostPath).size;
  console.log(`✓ screenshot: ${hostPath} (${size} bytes)`);
  if (size < 1000) fail(`screenshot suspiciously small (${size} bytes) — likely a blank frame`);
  copyFileSync(hostPath, join(OUT, "chromium-before.png"));

  // 3) describe surfaces the DOM — the tap target must be present.
  const before = await callTool("describe", { udid });
  const beforeText =
    typeof before === "string" ? before : (before.description ?? JSON.stringify(before));
  if (!/ArgentTapTarget/i.test(beforeText)) {
    fail(
      "describe did not surface the page's tap target (ArgentTapTarget)",
      beforeText.slice(0, 800)
    );
  }
  console.log("✓ describe surfaced the DOM (found ArgentTapTarget)");

  // 4) gesture-tap dispatches a real click; the page mutates the DOM in
  //    response, which proves the tap actually landed (not just a 200).
  const tap = await callTool("gesture-tap", { udid, x: 0.5, y: 0.5 });
  if (!(tap?.tapped === true)) fail("gesture-tap did not report tapped:true", tap);
  console.log("✓ gesture-tap reported tapped:true");

  // 5) Observe the effect: the click handler rewrites the button to TAPPED-OK.
  let observed = false;
  for (let i = 0; i < 10; i++) {
    const after = await callTool("describe", { udid });
    const afterText =
      typeof after === "string" ? after : (after.description ?? JSON.stringify(after));
    if (/TAPPED-OK/i.test(afterText)) {
      observed = true;
      break;
    }
    await sleep(500);
  }
  const finalShot = await callTool("screenshot", { udid });
  if (finalShot?.image?.hostPath && existsSync(finalShot.image.hostPath)) {
    copyFileSync(finalShot.image.hostPath, join(OUT, "chromium-after.png"));
  }
  if (!observed) fail("tap did not mutate the DOM (TAPPED-OK never appeared in describe)");
  console.log("✓ tap mutated the DOM (TAPPED-OK observed) — real interaction confirmed");

  console.log(
    "\n✅ Chromium E2E passed on this host — discover, screenshot, describe, and tap all work."
  );
}

main().catch((err) => fail(err.message ?? String(err), err.stack));
