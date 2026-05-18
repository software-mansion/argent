import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Request, Response, Router } from "express";
import express from "express";
import type { Registry } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "./blueprints/simulator-server";
import { resolveDevice } from "./utils/device-info";
import { listDevicesTool } from "./tools/devices/list-devices";
import {
  variantProposalStore,
  type SubmittedSelection,
  type ElementAnnotation,
  type VariantMatch,
} from "./utils/variant-proposals";
import type { DescribeResult } from "./tools/describe/contract";

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

  // ── Variant proposals ────────────────────────────────────────────────
  // Live proposal state for the UI to poll. Invisible to MCP (only /tools).
  router.get("/variants", (_req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    res.json(variantProposalStore.snapshot());
  });

  // Human pressed "Complete selection" in the UI — unblocks await_user_selection.
  router.post("/variants/selection", (req: Request, res: Response) => {
    const body = req.body ?? {};
    const rawSelections = Array.isArray(body.selections) ? body.selections : [];
    const selections: SubmittedSelection[] = [];
    for (const s of rawSelections) {
      if (!s || typeof s.elementId !== "string") continue;
      selections.push({
        elementId: s.elementId,
        variantId: typeof s.variantId === "string" ? s.variantId : null,
        comment: typeof s.comment === "string" && s.comment.trim() ? s.comment.trim() : undefined,
      });
    }
    const matchKinds = new Set(["text", "label", "identifier", "role"]);
    const rawAnn = Array.isArray(body.annotations) ? body.annotations : [];
    const annotations: ElementAnnotation[] = [];
    for (const a of rawAnn) {
      if (!a || typeof a.comment !== "string" || !a.comment.trim()) continue;
      const m = a.match;
      const match: VariantMatch =
        m && matchKinds.has(m.by) && typeof m.value === "string" && m.value
          ? { by: m.by, value: String(m.value) }
          : { by: "text", value: String(a.target ?? "") };
      annotations.push({
        target: typeof a.target === "string" && a.target ? a.target : "(element)",
        match,
        comment: a.comment,
      });
    }
    try {
      const result = variantProposalStore.submitSelection({
        selections,
        annotations,
        globalComment: typeof body.globalComment === "string" ? body.globalComment : undefined,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Streams a variant's local preview-image file (e.g. a screenshot path the
  // agent attached). Only serves a path currently stored on a variant AND
  // resolving (after symlinks) under an allowlisted root (OS temp dir — where
  // the screenshot tool writes — or the tool-server cwd), with a known image
  // extension and a size cap. http(s)/data: previews are used directly by the
  // browser and never hit this route. This route has no auth and IDs are
  // enumerable, so the containment check is the real protection.
  const IMG_MIME: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
  };
  const MAX_PREVIEW_BYTES = 25 * 1024 * 1024;
  const allowedRoots = (() => {
    const roots = new Set<string>();
    for (const r of [os.tmpdir(), process.cwd()]) {
      try {
        roots.add(fs.realpathSync(r));
      } catch {
        /* skip unresolvable root */
      }
    }
    return [...roots];
  })();
  router.get("/variant-image/:elementId/:variantId", (req: Request, res: Response) => {
    const v = variantProposalStore.findVariant(req.params.elementId!, req.params.variantId!);
    const src = v?.previewImage;
    if (!src || /^(https?:|data:)/i.test(src)) {
      res.status(404).end();
      return;
    }
    let real: string;
    let size: number;
    try {
      real = fs.realpathSync(src);
      const st = fs.statSync(real);
      if (!st.isFile()) throw new Error("not a file");
      size = st.size;
    } catch {
      res.status(404).end();
      return;
    }
    const contained = allowedRoots.some(
      (root) => real === root || real.startsWith(root + path.sep)
    );
    const mime = IMG_MIME[path.extname(real).toLowerCase()];
    if (!contained || !mime || size > MAX_PREVIEW_BYTES) {
      res.status(404).end();
      return;
    }
    res.set("Cache-Control", "no-store");
    res.type(mime);
    fs.createReadStream(real)
      .on("error", () => {
        if (!res.headersSent) res.status(404).end();
      })
      .pipe(res);
  });

  // Accessibility tree for the streamed device so the UI can anchor each
  // floating variant bubble to its element's on-screen frame. Thin proxy over
  // the `describe` tool; failures are non-fatal for the UI (it falls back to
  // corner notifications).
  router.get("/describe/:udid", async (req: Request, res: Response) => {
    const udid = req.params.udid!;
    try {
      const data = await registry.invokeTool<DescribeResult>("describe", { udid });
      res.set("Cache-Control", "no-store");
      res.json(data);
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
