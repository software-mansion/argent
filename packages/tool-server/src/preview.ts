import fs from "node:fs";
import path from "node:path";
import type { Request, Response, Router } from "express";
import express from "express";
import type { Registry } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "./blueprints/simulator-server";
import { resolveDevice } from "./utils/device-info";
import { listDevicesTool } from "./tools/devices/list-devices";

function findUiHtml(): string | null {
  // Candidate paths (first match wins):
  //   1. bundled: sibling `preview-ui/index.html` next to the compiled bundle
  //   2. dev (built tool-server): `packages/ui/index.html` at workspace root
  //   3. dev (ts-node src): `packages/ui/index.html` at workspace root
  const candidates = [
    path.join(__dirname, "preview-ui", "index.html"),
    path.resolve(__dirname, "..", "..", "..", "ui", "index.html"),
    path.resolve(__dirname, "..", "..", "ui", "index.html"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function wsUrlFromHttp(httpUrl: string): string {
  const u = new URL(httpUrl);
  const scheme = u.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${u.host}/ws`;
}

export function createPreviewRouter(registry: Registry): Router {
  const router = express.Router();

  router.get("/simulators", async (_req: Request, res: Response) => {
    try {
      const data = await registry.invokeTool<{
        devices: Array<
          | { platform: "ios"; udid: string; name: string; state: string; runtime: string }
          | {
              platform: "android";
              serial: string;
              state: string;
              avdName?: string;
              model?: string;
              sdkLevel?: number | null;
            }
        >;
      }>(listDevicesTool.id);
      // The preview UI keys off `udid` and `state === "Booted"`, which are
      // iOS terminology. Map Android serials to the same shape so the same
      // dropdown can target both platforms — `simulator-server/:udid` already
      // accepts Android serials via `resolveDevice(udid)`.
      const simulators = data.devices.map((d) => {
        if (d.platform === "ios") {
          return {
            udid: d.udid,
            name: d.name,
            state: d.state,
            runtime: d.runtime,
            isAvailable: true,
            platform: "ios" as const,
          };
        }
        return {
          udid: d.serial,
          name: d.avdName ?? d.model ?? d.serial,
          state: d.state === "device" ? "Booted" : d.state,
          runtime: d.sdkLevel != null ? `Android API ${d.sdkLevel}` : "Android",
          isAvailable: true,
          platform: "android" as const,
        };
      });
      res.json({ simulators });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/simulator-server/:udid", async (req: Request, res: Response) => {
    const udid = req.params.udid!;
    try {
      // This endpoint is reachable without the auth token (the preview UI is
      // browser-loaded and tokenless). Bind the spawn to an actually-present
      // device so an unauthenticated caller can't (a) spawn an unbounded
      // number of simulator-server processes with arbitrary distinct ids
      // (DoS), nor (b) inject argv into the binary via a crafted id. The UI
      // only ever requests ids returned by /preview/simulators — no
      // regression.
      const data = await registry.invokeTool<{
        devices: Array<{ platform: "ios"; udid: string } | { platform: "android"; serial: string }>;
      }>(listDevicesTool.id);
      const known = data.devices.some((d) => (d.platform === "ios" ? d.udid : d.serial) === udid);
      if (!known) {
        res
          .status(400)
          .json({ error: `Unknown device "${udid}". Use a udid/serial from /preview/simulators.` });
        return;
      }
      const { urn, options } = simulatorServerRef(resolveDevice(udid));
      const api = await registry.resolveService<SimulatorServerApi>(urn, options);
      res.json({
        udid,
        apiUrl: api.apiUrl,
        streamUrl: api.streamUrl,
        wsUrl: wsUrlFromHttp(api.apiUrl),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/", (_req: Request, res: Response) => {
    const p = findUiHtml();
    if (!p) {
      res.status(404).type("text/plain").send("Preview UI not found");
      return;
    }
    // Dev-style no-cache so edits to packages/ui/index.html are picked up on
    // reload without the user having to hard-refresh.
    res.set("Cache-Control", "no-store, must-revalidate");
    res.type("text/html").sendFile(p);
  });

  return router;
}
