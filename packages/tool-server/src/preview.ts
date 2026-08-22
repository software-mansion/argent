import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Request, Response, Router } from "express";
import express from "express";
import { isFlagEnabled } from "@argent/configuration-core";
import type { Registry } from "@argent/registry";
import { track } from "@argent/telemetry";
import { simulatorServerRef, type SimulatorServerApi } from "./blueprints/simulator-server";
import { resolveDevice } from "./utils/device-info";
import { classifyDeviceForTelemetry } from "./utils/telemetry-platform";
import { shutdownDevice } from "./utils/device-shutdown";
import { listDevicesTool } from "./tools/devices/list-devices";
import {
  variantProposalStore,
  type StoreSnapshot,
  type SubmittedSelection,
  type ElementAnnotation,
  type VariantMatch,
} from "./utils/variant-proposals";
import type { DescribeTreeData } from "./tools/describe/contract";
import { describeIos } from "./tools/describe/platforms/ios";
import { describeAndroid } from "./tools/describe/platforms/android";

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

// `sendFile` with an explicit `root`, not an absolute path: Express 5's `send`
// defaults to `dotfiles: "ignore"` and 404s any dot-segment, which argent is
// routinely installed under (nvm, fnm, volta, asdf). Scoping to the dirname
// leaves only the basename in the request path.
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

  // Last round for which `lens:preview_opened` was emitted. Round numbers only
  // ever increase, so "!= last" collapses repeated signals for one round (several
  // open tabs, or the same tab re-reporting) into a single event.
  let lastOpenedRound = -1;

  // Emit `lens:preview_opened` at most once per round, triggered by the client's
  // `POST /opened` — sent only when it renders a new round in a visible window.
  // Server-side inference misreports: `GET /` fires once per `argent lens`
  // session (its window is reused across rounds), and the `/variants` poll keeps
  // ticking in a forgotten background tab. The payload is read from the live
  // snapshot here, never taken from the unauthenticated client.
  const trackPreviewOpenedOnce = (snap: StoreSnapshot): void => {
    if (!(snap.proposals.length > 0 || snap.cliSession) || snap.round === lastOpenedRound) return;
    lastOpenedRound = snap.round;
    track("lens:preview_opened", {
      round: snap.round,
      element_count: snap.proposals.length,
      variant_count: snap.proposals.reduce((n, p) => n + p.variants.length, 0),
      is_cli_session: snap.cliSession,
      // `device` deliberately survives the store's reset(), so a CLI up-front
      // open (no proposals staged yet) would otherwise report a prior flow's
      // platform.
      platform:
        snap.proposals.length > 0 && snap.device
          ? classifyDeviceForTelemetry(snap.device)
          : undefined,
    });
  };

  // cli-session / cli-agent / boot / shutdown are tokenless like the rest of
  // /preview but can spawn or kill simulators, and are only ever driven by an
  // `argent lens` session. Gating them on the same flag (re-read per request)
  // means a user who never enabled Lens gains no unauthenticated localhost
  // surface. The read-only routes stay ungated.
  const requireLensFlag = (res: Response): boolean => {
    if (isFlagEnabled("argent-lens")) return true;
    res.status(404).end();
    return false;
  };

  // Known-device cache. The tokenless routes below validate their :udid against
  // the live device list so forged ids can't amplify into unbounded
  // `xcrun`/`adb` spawns — but /describe is polled ~3×/s, and `list-devices`
  // itself shells `xcrun`/`adb`/`ps` and probes Chromium CDP, so running it per
  // request would turn the guard into the spawn storm it exists to prevent.
  // /simulators re-primes the cache, so a just-listed device is connectable
  // without waiting out the TTL.
  const KNOWN_DEVICES_TTL_MS = 5_000;
  let knownDevices: { ids: Set<string>; at: number } | null = null;
  let knownDevicesInFlight: Promise<Set<string>> | null = null;

  // A chromium entry has neither udid nor serial, so it drops out — it was never
  // a valid preview target anyway.
  function deviceIdSet(
    devices: ReadonlyArray<{ platform: string; udid?: string; serial?: string }>
  ): Set<string> {
    const ids = new Set<string>();
    for (const d of devices) {
      const id = d.platform === "ios" ? d.udid : d.serial;
      if (typeof id === "string") ids.add(id);
    }
    return ids;
  }

  function rememberDevices(
    devices: ReadonlyArray<{ platform: string; udid?: string; serial?: string }>
  ): void {
    knownDevices = { ids: deviceIdSet(devices), at: Date.now() };
  }

  // Concurrent callers share one in-flight refresh; rejections propagate to the
  // routes, which 500 on them.
  async function knownDeviceIds(): Promise<Set<string>> {
    if (knownDevices && Date.now() - knownDevices.at < KNOWN_DEVICES_TTL_MS) {
      return knownDevices.ids;
    }
    if (knownDevicesInFlight) return knownDevicesInFlight;
    knownDevicesInFlight = registry
      .invokeTool<{
        devices: Array<{ platform: string; udid?: string; serial?: string }>;
      }>(listDevicesTool.id)
      .then((data) => {
        rememberDevices(data.devices);
        return knownDevices!.ids;
      })
      .finally(() => {
        knownDevicesInFlight = null;
      });
    return knownDevicesInFlight;
  }

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
      // The preview UI keys off `udid` and `state === "Booted"` — iOS
      // terminology — so Android serials are mapped onto the same shape for one
      // dropdown. Chromium is excluded: the UI can only render simulator-server's
      // frame stream, which exists for iOS / Android only.
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
      // Fresh and authoritative — prime the validation cache so the connect and
      // describe calls that follow hit a warm set.
      rememberDevices(data.devices);
      res.json({ simulators });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/simulator-server/:udid", async (req: Request, res: Response) => {
    const udid = req.params.udid as string;
    const device = resolveDevice(udid);
    if (device.platform !== "ios" && device.platform !== "android") {
      // Chromium drives its renderer over CDP and Vega has no simulator-server,
      // so failing here keeps a forged URL from spawning a simulator-server
      // process or falling through to `simulatorServerRef` for a device it can't
      // serve.
      res.status(400).json({
        error: `Preview is not available for ${device.platform} devices (id "${udid}"). Use the MCP tools (screenshot, describe, gesture-*) directly.`,
      });
      return;
    }
    try {
      // Reachable without the auth token, so bind the spawn to an
      // actually-present device: an unauthenticated caller must not be able to
      // spawn unbounded simulator-server processes with arbitrary distinct ids,
      // nor inject argv into the binary via a crafted id.
      const known = (await knownDeviceIds()).has(udid);
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

  // Live proposal state for the UI to poll. Invisible to MCP (only /tools).
  router.get("/variants", (_req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    res.json(variantProposalStore.snapshot());
  });

  // `lens:preview_opened` trigger, posted by the UI's `reportPreviewOpened` when
  // it renders a round in a visible window (see `trackPreviewOpenedOnce`).
  // Tokenless like the rest of /preview and effectively read-only — the request
  // body is ignored and no store state changes.
  router.post("/opened", (_req: Request, res: Response) => {
    trackPreviewOpenedOnce(variantProposalStore.snapshot());
    res.json({ ok: true });
  });

  // `argent lens` toggles this when it opens/closes. Active ⇒ the preview window
  // is opened up front and no longer auto-closed on submit, and the UI relabels
  // its submit action. The spawned window URL is computed server side, never
  // caller-supplied. The optional `agents` array is the choices the window's
  // picker offers when more than one agent is installed.
  router.post("/cli-session", (req: Request, res: Response) => {
    if (!requireLensFlag(res)) return;
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
  // bridge can spawn it. The id is matched against the known agents bridge-side.
  router.post("/cli-agent", (req: Request, res: Response) => {
    if (!requireLensFlag(res)) return;
    const id = typeof req.body?.id === "string" ? req.body.id.slice(0, 64) : "";
    const remember = Boolean(req.body?.remember);
    variantProposalStore.setLensAgentChoice(id, remember);
    res.json({ ok: true, choice: id, remember });
  });

  // Boot a device from the preview window's picker (the "boot it first" rows).
  // Headless so the simulator core streams through simulator-server without
  // popping the Simulator.app GUI. A device this route actually boots is marked
  // Lens-owned and shut down at CLI-session end; one that was already running is
  // left unowned — Lens must never shut down a simulator the user started.
  router.post("/boot", async (req: Request, res: Response) => {
    if (!requireLensFlag(res)) return;
    const udid = typeof req.body?.udid === "string" ? req.body.udid : "";
    if (!udid) {
      res.status(400).json({ error: "Missing `udid`." });
      return;
    }
    // iOS-only: a stopped iOS simulator still appears in `list-devices` (state
    // "Shutdown") and boots by udid, but a stopped Android AVD is absent from
    // `adb devices` entirely and would need an avdName this route never has.
    const device = resolveDevice(udid);
    if (device.platform !== "ios") {
      res.status(400).json({
        error: `Booting from the preview is only supported for iOS simulators (got "${device.platform}"). Start other devices via the boot-device MCP tool.`,
      });
      return;
    }
    try {
      // Cheap cache guard before the fresh `list-devices` below, so a forged-id
      // flood can't amplify one tokenless request into one full `list-devices`
      // each. A stopped-but-real iOS sim is cached by udid regardless of state,
      // so a legitimate boot target is never rejected here.
      if (!(await knownDeviceIds()).has(udid)) {
        res
          .status(400)
          .json({ error: `Unknown device "${udid}". Use a udid/serial from /preview/simulators.` });
        return;
      }
      // The already-running check needs live state, and boot is rare and
      // user-initiated — never hot-polled — so one fresh list is affordable.
      const data = await registry.invokeTool<{
        devices: Array<{ platform: string; udid?: string; serial?: string; state?: string }>;
      }>(listDevicesTool.id);
      rememberDevices(data.devices);
      const entry = data.devices.find((d) => (d.platform === "ios" ? d.udid : d.serial) === udid);
      if (!entry) {
        res
          .status(400)
          .json({ error: `Unknown device "${udid}". Use a udid/serial from /preview/simulators.` });
        return;
      }
      // Only a fully "Shutdown" simulator is a safe boot target we may own. A
      // transient "Booting"/"Shutting Down" may be one the user just triggered
      // externally, and owning it would let session-end teardown kill it.
      if (entry.state !== "Shutdown") {
        res.json({ ok: true, booted: true, alreadyRunning: true, owned: false });
        return;
      }
      await registry.invokeTool("boot-device", { udid, headless: true });
      variantProposalStore.markDeviceOwned(udid);
      res.json({ ok: true, booted: true, alreadyRunning: false, owned: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Shut down a running device from the preview window's right-click menu. The
  // :udid is validated against the known-device cache first — this route is
  // tokenless and drives `simctl`/`adb`. Unlike `/boot` it acts regardless of
  // Lens ownership: the user explicitly asked for this device.
  router.post("/shutdown/:udid", async (req: Request, res: Response) => {
    if (!requireLensFlag(res)) return;
    const udid = req.params.udid as string;
    try {
      const known = (await knownDeviceIds()).has(udid);
      if (!known) {
        res
          .status(400)
          .json({ error: `Unknown device "${udid}". Use a udid/serial from /preview/simulators.` });
        return;
      }
      const result = await shutdownDevice(udid);
      if (!result.ok) {
        res.status(400).json({ error: result.error ?? "Shutdown failed." });
        return;
      }
      // No longer running — drop any Lens ownership so session-end teardown
      // doesn't retry a dead device, and drop the now-stale cache.
      variantProposalStore.releaseDevice(udid);
      knownDevices = null;
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Frozen outcome of the last submitted round, or null since the last reset.
  // `argent lens` reads it ONCE at startup to seed its baseline `completedAt`;
  // live updates arrive over /lens-stream, so there is no steady-state poll.
  router.get("/outcome", (_req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    res.json({ outcome: variantProposalStore.getLastOutcome() });
  });

  // Server-sent events for the `argent lens` relay, emitted the instant the
  // underlying store event fires:
  //   event: agent-choice  data: { id, remember }  (human picked an agent)
  //   event: outcome       data: <completed JSON>  (a round was submitted)
  //   event: session-end   data: {}                (the CLI session ended)
  // The browser UI polls /variants instead; this stream is only for the CLI.
  router.get("/lens-stream", (req: Request, res: Response) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
    });
    res.flushHeaders?.();

    const send = (event: string, data: unknown): void => {
      // A dead/backed-up socket must not throw into the event emitter.
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        /* client gone — the close handler tears the listeners down */
      }
    };

    // Replay the current pick on connect: it is a one-shot event, so a CLI that
    // subscribes after the click would otherwise never learn it.
    let lastChoiceSent = variantProposalStore.getLensAgentChoice();
    if (lastChoiceSent) {
      send("agent-choice", {
        id: lastChoiceSent,
        remember: variantProposalStore.getLensAgentRemember(),
      });
    }

    // Replay the last outcome too: the CLI reads /outcome only at startup, so a
    // submit landing during a reconnect gap would fire with no listener and be
    // lost. The CLI dedups by `completedAt`, making a stale replay a no-op.
    const lastOutcome = variantProposalStore.getLastOutcome();
    if (lastOutcome) send("outcome", lastOutcome);

    const onChanged = (): void => {
      const choice = variantProposalStore.getLensAgentChoice();
      if (choice && choice !== lastChoiceSent) {
        lastChoiceSent = choice;
        send("agent-choice", { id: choice, remember: variantProposalStore.getLensAgentRemember() });
      }
    };
    const onSubmitted = (): void => {
      const outcome = variantProposalStore.getLastOutcome();
      if (outcome) send("outcome", outcome);
    };
    const onCliSessionChanged = (active: boolean): void => {
      if (!active) send("session-end", {});
    };
    variantProposalStore.events.on("changed", onChanged);
    variantProposalStore.events.on("selectionSubmitted", onSubmitted);
    variantProposalStore.events.on("cliSessionChanged", onCliSessionChanged);

    // Keeps an idle stream from being dropped by a proxy or half-open socket; an
    // SSE comment line is ignored by the parser.
    const heartbeat = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        /* ignore */
      }
    }, 15_000);
    // Don't let the heartbeat alone keep the process alive.
    heartbeat.unref?.();

    req.on("close", () => {
      clearInterval(heartbeat);
      variantProposalStore.events.off("changed", onChanged);
      variantProposalStore.events.off("selectionSubmitted", onSubmitted);
      variantProposalStore.events.off("cliSessionChanged", onCliSessionChanged);
    });
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
        // The round the UI built this submit against, if it sent one. The store
        // rejects it once the round has rolled, so a click from a stale tab can't
        // mint a phantom completion.
        round: typeof body.round === "number" ? body.round : undefined,
        selections,
        annotations,
        globalComment: typeof body.globalComment === "string" ? body.globalComment : undefined,
        // UI usage signals for `lens:round_completed`. Coerced to strict booleans
        // so a malformed field from this unauthenticated route can't carry
        // anything else into telemetry.
        inspectorUsed: body.inspectorUsed === true,
        offscreenRevealed: body.offscreenRevealed === true,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Streams a variant's local preview-image file. This route has no auth and its
  // ids are enumerable, so the containment check below — path stored on a live
  // variant, resolving (after symlinks) under an allowlisted root, known image
  // extension, size cap — is the real protection. http(s)/data: previews are
  // loaded by the browser directly and never reach here.
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
    // `/tmp` on top of os.tmpdir(): on macOS the latter is a per-user
    // `/var/folders/…` path, so agents writing screenshots to `/tmp` would
    // otherwise 404 and show "No preview".
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

  // Accessibility tree for the streamed device, so the UI can anchor each
  // floating variant bubble to its element's on-screen frame and the
  // comment-mode spotlight to a hovered element. The `describe` TOOL drops the
  // JSON tree in favour of a token-efficient text rendering, so this route calls
  // the same per-platform adapters minus the formatter. Failures are non-fatal
  // for the UI (it falls back to corner notifications).
  router.get("/describe/:udid", async (req: Request, res: Response) => {
    const udid = req.params.udid as string;
    const device = resolveDevice(udid);
    if (device.platform !== "ios" && device.platform !== "android") {
      // Without this, a Chromium or Vega id would fall through to the
      // `describeAndroid` branch below and shell `adb -s <id>` against a
      // non-existent serial, 500ing with a misleading message.
      res.status(400).json({
        error: `describe is not available for ${device.platform} devices (id "${udid}"). Use the MCP tools (screenshot, describe, gesture-*) directly.`,
      });
      return;
    }
    try {
      // Reachable without the auth token, and the adapters shell out to
      // `xcrun`/`adb`, so bind the dispatch to an actually-present device: a
      // flood of distinct ids must not amplify into unbounded subprocess spawns.
      const known = (await knownDeviceIds()).has(udid);
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

  // `GET "/"` below matches only the exact root, so it does not shadow this.
  router.get("/theme.css", (_req: Request, res: Response) => {
    const p = findUiFile("theme.css");
    if (!p) {
      res.status(404).type("text/plain").send("theme.css not found");
      return;
    }
    serveUiFile(res, p, "text/css");
  });

  router.get("/", (req: Request, res: Response) => {
    // The index references theme.css relatively. Without a trailing slash on
    // /preview a browser resolves that against /, hitting /theme.css (404), so
    // canonicalise to the form under which sub-resources resolve.
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
    // `lens:preview_opened` is deliberately NOT emitted here — a page load alone
    // doesn't prove a human is looking. See `trackPreviewOpenedOnce`.
    serveUiFile(res, p, "text/html");
  });

  return router;
}
