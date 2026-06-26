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
import type { DescribeTreeData } from "./tools/describe/contract";
import { describeIos } from "./tools/describe/platforms/ios";
import { describeAndroid } from "./tools/describe/platforms/android";

// Resolve a file from the preview-UI directory. Candidate roots (first match
// wins): (1) bundled `preview-ui/` sibling to the compiled bundle, (2) built
// tool-server's `packages/ui/`, (3) ts-node `src` run's `packages/ui/`. Used
// for both index.html and its externalised theme.css with identical
// resolution, so the stylesheet is always found right next to the page.
function findUiFile(name: string): string | null {
  const candidates = [
    path.join(__dirname, "preview-ui", name),
    path.resolve(__dirname, "..", "..", "..", "ui", name),
    path.resolve(__dirname, "..", "..", "ui", name),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Serve a resolved preview-UI file. We go through `sendFile` with an explicit
// `root` instead of passing the absolute path directly: Express 5's `send`
// defaults to `dotfiles: "ignore"`, which 404s any path containing a dot-segment.
// argent is routinely installed under one (nvm's `~/.nvm/...`, fnm, volta,
// asdf), so `sendFile(absolutePath)` silently fails there and the Lens preview
// window can't load. Scoping to `{ root: dir }` makes the request path just the
// basename — no dot-segment — so the file is served regardless of install path.
export function serveUiFile(res: Response, filePath: string, contentType: string): void {
  res.set("Cache-Control", "no-store, must-revalidate");
  res.type(contentType).sendFile(path.basename(filePath), { root: path.dirname(filePath) });
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
          | { platform: "chromium"; id: string; title: string; port: number }
        >;
      }>(listDevicesTool.id);
      // The preview UI keys off `udid` and `state === "Booted"`, which are
      // iOS terminology. Map Android serials to the same shape so the same
      // dropdown can target both platforms — `simulator-server/:udid` already
      // accepts Android serials via `resolveDevice(udid)`.
      //
      // Chromium is intentionally excluded: the preview UI streams frames
      // through simulator-server's WebSocket, which only exists for iOS /
      // Android. Surfacing chromium entries would let the UI offer a target
      // it can't actually drive. Chromium consumers should use the MCP tools
      // (screenshot, describe, gesture-*) directly.
      type PreviewEntry = {
        udid: string;
        name: string;
        state: string;
        runtime: string;
        isAvailable: boolean;
        platform: "ios" | "android";
      };
      const simulators = data.devices.flatMap<PreviewEntry>((d) => {
        if (d.platform === "ios") {
          return [
            {
              udid: d.udid,
              name: d.name,
              state: d.state,
              runtime: d.runtime,
              isAvailable: true,
              platform: "ios",
            },
          ];
        }
        if (d.platform === "android") {
          return [
            {
              udid: d.serial,
              name: d.avdName ?? d.model ?? d.serial,
              state: d.state === "device" ? "Booted" : d.state,
              runtime: d.sdkLevel != null ? `Android API ${d.sdkLevel}` : "Android",
              isAvailable: true,
              platform: "android",
            },
          ];
        }
        return [];
      });
      res.json({ simulators });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/simulator-server/:udid", async (req: Request, res: Response) => {
    const udid = req.params.udid as string;
    const device = resolveDevice(udid);
    if (device.platform === "chromium") {
      // The preview UI only knows how to render simulator-server's frame stream,
      // and Chromium drives the renderer over CDP instead. Fail loudly here so a
      // forged URL doesn't quietly spawn a simulator-server process for an
      // Chromium device id.
      res.status(400).json({
        error: `Preview is not available for Chromium devices (id "${udid}"). Use the MCP tools (screenshot, describe, gesture-*) directly.`,
      });
      return;
    }
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
      const { urn, options } = simulatorServerRef(device);
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

  // ── CLI-driven Lens session (`argent lens`) ──────────────────────────
  // `argent lens` toggles this when it opens/closes. begin ⇒ the window
  // manager opens the preview window up front (no await needed) and stops
  // auto-closing it on submit; the UI relabels its submit action. Tokenless
  // like the rest of /preview (localhost-only) and state-changing exactly as
  // /variants/selection already is — the spawned window URL is computed server
  // side, never caller-supplied.
  // The optional `agents` array is the choices the window's picker offers (when
  // more than one agent is installed); the bridge polls `lensAgentChoice` to
  // learn which one the human clicked.
  router.post("/cli-session", (req: Request, res: Response) => {
    const active = Boolean(req.body?.active);
    const agents = Array.isArray(req.body?.agents)
      ? (req.body.agents as unknown[])
          .map((a) => a as { id?: unknown; name?: unknown })
          .filter((a) => typeof a.id === "string" && typeof a.name === "string")
          .map((a) => ({ id: String(a.id).slice(0, 64), name: String(a.name).slice(0, 64) }))
      : [];
    variantProposalStore.setCliSession(active, agents);
    res.json({ ok: true, cliSession: active });
  });

  // The human clicked an agent in the window's picker — record which one so the
  // bridge can spawn it. Tokenless and state-changing exactly like the rest of
  // /preview; the id is matched against the offered choices on the bridge side.
  router.post("/cli-agent", (req: Request, res: Response) => {
    const id = typeof req.body?.id === "string" ? req.body.id.slice(0, 64) : "";
    variantProposalStore.setLensAgentChoice(id);
    res.json({ ok: true, choice: id });
  });

  // The frozen outcome of the last submitted round (selections + comments +
  // annotations + globalComment), or null since the last reset. The `argent
  // lens` watcher polls this and, on each new `completedAt`, types a flattened
  // summary of the feedback into the bound agent terminal.
  router.get("/outcome", (_req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    res.json({ outcome: variantProposalStore.getLastOutcome() });
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
    // `/tmp` in addition to os.tmpdir(): on macOS os.tmpdir() is a per-user
    // `/var/folders/…` path, so agents that drop screenshots under `/tmp`
    // (a very common choice) would otherwise 404 and show "No preview".
    for (const r of [os.tmpdir(), process.cwd(), "/tmp"]) {
      try {
        roots.add(fs.realpathSync(r));
      } catch {
        /* skip unresolvable root */
      }
    }
    return [...roots];
  })();
  router.get("/variant-image/:elementId/:variantId", (req: Request, res: Response) => {
    const v = variantProposalStore.findVariant(
      req.params.elementId as string,
      req.params.variantId as string
    );
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
  // floating variant bubble to its element's on-screen frame, and the
  // comment-mode spotlight to a hovered element.
  //
  // `describe`'s public tool output is now a token-efficient *text* rendering
  // (the JSON tree is dropped before it replies — see describe/index.ts). The
  // preview UI needs the structured tree, so this route calls the same
  // per-platform adapter the `describe` tool uses, minus the text formatter,
  // and returns the structured `DescribeTreeData` ({ tree, source }) the UI
  // parses. The `describe` tool itself is intentionally left untouched.
  // Failures are non-fatal for the UI (it falls back to corner notifications).
  router.get("/describe/:udid", async (req: Request, res: Response) => {
    const udid = req.params.udid as string;
    const device = resolveDevice(udid);
    if (device.platform === "chromium") {
      // No structured tree for Chromium here: this route only dispatches the
      // iOS / Android describe adapters. Reject loudly instead of letting a
      // chromium id fall through to describeAndroid (which would shell `adb`
      // against a non-existent serial and 500 with a misleading message).
      res.status(400).json({
        error: `describe is not available for Chromium devices (id "${udid}"). Use the MCP tools (screenshot, describe, gesture-*) directly.`,
      });
      return;
    }
    try {
      // Like /simulator-server/:udid, this route is reachable without the auth
      // token. `describeIos`/`describeAndroid` shell out to `xcrun`/`adb`, so
      // bind the dispatch to an actually-present device — otherwise an
      // unauthenticated caller could flood distinct ids and amplify into
      // unbounded subprocess spawns. The UI only ever requests ids returned by
      // /preview/simulators — no regression.
      const deviceList = await registry.invokeTool<{
        devices: Array<{ platform: "ios"; udid: string } | { platform: "android"; serial: string }>;
      }>(listDevicesTool.id);
      const known = deviceList.devices.some(
        (d) => (d.platform === "ios" ? d.udid : d.serial) === udid
      );
      if (!known) {
        res
          .status(400)
          .json({ error: `Unknown device "${udid}". Use a udid/serial from /preview/simulators.` });
        return;
      }
      const data: DescribeTreeData =
        device.platform === "ios"
          ? await describeIos(registry, device, {})
          : await describeAndroid(registry, udid);
      res.set("Cache-Control", "no-store");
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Externalised stylesheet — the single theme source. Same path resolution
  // and no-cache as index.html so edits show on reload. `GET "/"` only matches
  // the exact root, so this is not shadowed by it.
  router.get("/theme.css", (_req: Request, res: Response) => {
    const p = findUiFile("theme.css");
    if (!p) {
      res.status(404).type("text/plain").send("theme.css not found");
      return;
    }
    serveUiFile(res, p, "text/css");
  });

  router.get("/", (req: Request, res: Response) => {
    // The index references theme.css with a relative URL. Without a trailing
    // slash on /preview, browsers resolve that against /, hitting /theme.css
    // (404) instead of /preview/theme.css. Canonicalise to the trailing-slash
    // form so relative sub-resources resolve under the mount.
    if (!req.originalUrl.split("?")[0].endsWith("/")) {
      const [pathPart, ...queryParts] = req.originalUrl.split("?");
      const target = pathPart + "/" + (queryParts.length ? "?" + queryParts.join("?") : "");
      res.redirect(301, target);
      return;
    }
    const p = findUiFile("index.html");
    if (!p) {
      res.status(404).type("text/plain").send("Preview UI not found");
      return;
    }
    serveUiFile(res, p, "text/html");
  });

  return router;
}
