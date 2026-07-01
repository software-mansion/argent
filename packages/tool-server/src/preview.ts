import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Request, Response, Router } from "express";
import express from "express";
import { isFlagEnabled } from "@argent/configuration-core";
import type { Registry } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "./blueprints/simulator-server";
import { resolveDevice } from "./utils/device-info";
import { shutdownDevice } from "./utils/device-shutdown";
import { listDevicesTool, type ListDevicesResult } from "./tools/devices/list-devices";
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

type PreviewEntry = {
  udid: string;
  name: string;
  state: string;
  runtime: string;
  isAvailable: boolean;
  platform: "ios" | "android";
};

/**
 * Map the `list-devices` result to the targets the preview UI can actually
 * drive. The UI keys off `udid` and `state === "Booted"` (iOS terminology), so
 * Android serials are remapped to that shape — `simulator-server/:udid` already
 * accepts Android serials via `resolveDevice(udid)`.
 *
 * Chromium and physical iOS devices are intentionally excluded: the preview UI
 * streams frames through simulator-server's WebSocket, which only exists for
 * simulators / Android. simulator-server outright refuses physical iOS
 * (kind === "device", driven over CoreDevice instead), so surfacing either
 * would let the UI offer a target it can't drive. Those consumers should use
 * the MCP tools (screenshot, describe, gesture-*) directly.
 */
export function devicesToPreviewEntries(devices: ListDevicesResult["devices"]): PreviewEntry[] {
  return devices.flatMap<PreviewEntry>((d) => {
    if (d.platform === "ios") {
      if (d.kind === "device") return [];
      return [
        {
          udid: d.udid,
          name: d.name,
          state: d.state,
          runtime: d.runtime ?? "",
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
}

export function createPreviewRouter(registry: Registry): Router {
  const router = express.Router();

  // The lens-specific routes below (cli-session / cli-agent / boot / shutdown)
  // are tokenless like the rest of /preview but STATE-CHANGING — they open the
  // window and can spawn/kill simulators. They're only ever driven by an
  // `argent lens` session, which is itself gated on the `argent-lens` flag. Gate
  // them behind the same flag (re-read per request, like http.ts does for tools)
  // so a user who never enabled Lens gains no new unauthenticated localhost
  // surface: with the flag off they 404 as if absent. Read-only routes (variants
  // / outcome / lens-stream / describe / simulators) stay ungated — they existed
  // before this feature and only report state.
  const requireLensFlag = (res: Response): boolean => {
    if (isFlagEnabled("argent-lens")) return true;
    res.status(404).end();
    return false;
  };

  // ── Known-device cache ────────────────────────────────────────────────
  // Both /describe/:udid and /simulator-server/:udid validate the :udid against
  // the live device list before dispatching, so this auth-exempt route can't
  // amplify forged ids into unbounded `xcrun`/`adb` subprocess spawns. But the
  // preview UI polls /describe ~3×/s while variants are on screen, and `argent
  // lens` holds the window open across rounds — so invoking `list-devices`
  // (which itself shells `xcrun`/`adb`/`ps` + probes Chromium CDP) per request
  // turns the guard into a spawn storm. Cache the known-id set for a short
  // window: the guard stays O(1) on the hot path and `list-devices` runs at most
  // ~once per window. This also tightens the guard — a flood of forged ids now
  // shares one refresh instead of triggering a `list-devices` spawn each.
  // /simulators refreshes the cache as a side effect, so a device the UI just
  // listed is immediately connectable without waiting out the TTL.
  const KNOWN_DEVICES_TTL_MS = 5_000;
  let knownDevices: { ids: Set<string>; at: number } | null = null;
  let knownDevicesInFlight: Promise<Set<string>> | null = null;

  // Mirror the original `.some()` guard exactly: an iOS device is keyed by its
  // udid, every other platform by its serial (a chromium entry has neither, so
  // it's skipped — it was never a valid preview target anyway).
  function deviceIdSet(
    devices: ReadonlyArray<{ platform: string; udid?: string; serial?: string | null }>
  ): Set<string> {
    const ids = new Set<string>();
    for (const d of devices) {
      const id = d.platform === "ios" ? d.udid : d.serial;
      if (typeof id === "string") ids.add(id);
    }
    return ids;
  }

  // Record a freshly-resolved device list into the cache (used by both the
  // dedicated refresh below and the /simulators handler, which already fetches
  // the full list for its dropdown).
  function rememberDevices(
    devices: ReadonlyArray<{ platform: string; udid?: string; serial?: string | null }>
  ): void {
    knownDevices = { ids: deviceIdSet(devices), at: Date.now() };
  }

  // Resolve the set of known device ids, refreshing via `list-devices` only when
  // the cache is cold or stale. Concurrent callers within one refresh share a
  // single in-flight invocation. Rejections propagate (the routes 500 on them,
  // as they did when calling `list-devices` inline).
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
      // Reuse list-devices' own result type rather than a hand-rolled copy, so
      // the preview's view of a device can't silently drift from what the tool
      // actually returns (e.g. physical-iOS entries carrying `kind`/no runtime).
      const data = await registry.invokeTool<ListDevicesResult>(listDevicesTool.id);
      // This is the authoritative fresh device list — prime the validation
      // cache so the immediately-following connect (/simulator-server/:udid)
      // and the describe poll loop hit a warm, correct set instead of each
      // re-running `list-devices`.
      rememberDevices(data.devices);
      // devicesToPreviewEntries maps iOS/Android into the UI's udid/Booted shape
      // and excludes targets the preview can't stream — chromium (no
      // simulator-server WebSocket) and physical iOS (kind: "device").
      res.json({ simulators: devicesToPreviewEntries(data.devices) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/simulator-server/:udid", async (req: Request, res: Response) => {
    const udid = req.params.udid as string;
    const device = resolveDevice(udid);
    if (device.platform !== "ios" && device.platform !== "android") {
      // The preview UI only knows how to render simulator-server's frame stream,
      // which exists only for iOS / Android. Chromium drives its renderer over
      // CDP; Vega has no simulator-server. Fail loudly for any such platform so a
      // forged URL doesn't quietly spawn a simulator-server process (Chromium),
      // nor fall through to `simulatorServerRef` for an unsupported device (Vega).
      res.status(400).json({
        error: `Preview is not available for ${device.platform} devices (id "${udid}"). Use the MCP tools (screenshot, describe, gesture-*) directly.`,
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
      // regression. Validation goes through the short-lived known-device cache
      // (see top of createPreviewRouter) so the describe poll loop doesn't
      // re-run `list-devices` on every tick.
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
  // bridge can spawn it. Tokenless and state-changing exactly like the rest of
  // /preview; the id is matched against the offered choices on the bridge side.
  router.post("/cli-agent", (req: Request, res: Response) => {
    if (!requireLensFlag(res)) return;
    const id = typeof req.body?.id === "string" ? req.body.id.slice(0, 64) : "";
    const remember = Boolean(req.body?.remember);
    variantProposalStore.setLensAgentChoice(id, remember);
    res.json({ ok: true, choice: id, remember });
  });

  // Boot a device from the preview window's picker (the "boot it first" rows).
  // Tokenless like the rest of /preview, but state-changing: it can spawn a
  // simulator. To keep it from being abused into an unbounded spawn, the :udid
  // is validated against the live device list (same known-device cache as the
  // describe/connect routes) before dispatching.
  //
  // Headless: booted via `boot-device { headless: true }` so the simulator core
  // streams through simulator-server WITHOUT popping the Simulator.app GUI.
  // Ownership: a device this route actually boots (it was not already running)
  // is recorded as Lens-owned, so the tool-server shuts it down when the CLI
  // session ends. A device that was already running is left unowned — Lens must
  // never shut down a simulator the user started themselves.
  router.post("/boot", async (req: Request, res: Response) => {
    if (!requireLensFlag(res)) return;
    const udid = typeof req.body?.udid === "string" ? req.body.udid : "";
    if (!udid) {
      res.status(400).json({ error: "Missing `udid`." });
      return;
    }
    // Booting is iOS-only here: a stopped iOS simulator still appears in
    // `list-devices` (state "Shutdown") and boots by udid, but a stopped
    // Android AVD does not appear at all (adb only lists running emulators) —
    // it would need an avdName this route never has. So Android entries in the
    // picker are always already-running; reject any non-iOS boot request loudly.
    const device = resolveDevice(udid);
    if (device.platform !== "ios") {
      res.status(400).json({
        error: `Booting from the preview is only supported for iOS simulators (got "${device.platform}"). Start other devices via the boot-device MCP tool.`,
      });
      return;
    }
    try {
      // Cheaply reject ids absent from the short-lived known-device cache before
      // the fresh `list-devices` below. This route is tokenless and boot-device
      // spawns a simulator, so a forged-id flood must not amplify 1 request → 1
      // full `list-devices` (xcrun + adb + ps + Chromium probes) each — mirror
      // the connect/describe/shutdown routes' cache guard. A stopped-but-real
      // iOS sim is still in the cache (keyed by udid regardless of state), so a
      // legitimate boot target is never rejected here.
      if (!(await knownDeviceIds()).has(udid)) {
        res
          .status(400)
          .json({ error: `Unknown device "${udid}". Use a udid/serial from /preview/simulators.` });
        return;
      }
      // One fresh `list-devices` (boot is a rare, user-initiated action, never
      // hot-polled) drives the already-running check below; it also re-warms the
      // cache for the connect/describe poll that follows a successful boot.
      const data = await registry.invokeTool<{
        devices: Array<{ platform: string; udid?: string; serial?: string; state?: string }>;
      }>(listDevicesTool.id);
      rememberDevices(data.devices); // warm the connect/describe validation cache
      const entry = data.devices.find((d) => (d.platform === "ios" ? d.udid : d.serial) === udid);
      if (!entry) {
        res
          .status(400)
          .json({ error: `Unknown device "${udid}". Use a udid/serial from /preview/simulators.` });
        return;
      }
      // Only a fully "Shutdown" simulator is a safe boot target we may own. Any
      // other state — "Booted", or a transient "Booting"/"Shutting Down" the
      // USER just triggered externally — must NOT be re-booted or marked
      // Lens-owned: owning it would let session-end teardown shut down a device
      // the user started themselves (the invariant this route must never break).
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

  // Shut down a running device from the preview window's right-click menu.
  // Tokenless like the rest of /preview, but state-changing: it drives
  // `simctl`/`adb`, so the :udid is validated against the live device list
  // (same known-device cache as connect/boot) before dispatching — a forged id
  // can't be turned into an arbitrary shell invocation. Unlike `/boot`, this
  // acts on a device regardless of whether Lens owns it: the user explicitly
  // asked to shut down a simulator they can see in the picker.
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
      // It's no longer running — drop any Lens ownership so session-end
      // teardown doesn't try to shut down an already-dead device, and forget
      // the stale device-list cache so a re-list reflects the new state.
      variantProposalStore.releaseDevice(udid);
      knownDevices = null;
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // The frozen outcome of the last submitted round (selections + comments +
  // annotations + globalComment), or null since the last reset. `argent lens`
  // reads this ONCE at startup to seed its baseline `completedAt`; live updates
  // arrive over /lens-stream (below), so there is no steady-state poll here.
  router.get("/outcome", (_req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    res.json({ outcome: variantProposalStore.getLastOutcome() });
  });

  // Server-sent events for `argent lens`. PUSH replaces the old 1.2s poll: the
  // foreground `argent lens` process subscribes here and the tool-server emits
  //   event: agent-choice  data: "<id>"            (human picked an agent)
  //   event: outcome       data: <completed JSON>  (a round was submitted)
  //   event: session-end   data: {}                (the CLI session ended)
  // the instant the underlying store event fires — so feedback reaches the
  // agent terminal with no fixed-interval latency. The browser UI keeps its own
  // polling of /variants; this stream is only for the CLI relay.
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
        /* client gone — the close handler will tear the listeners down */
      }
    };

    // Replay the current agent pick on connect so a CLI that subscribes AFTER
    // the human clicked still learns the choice (the pick is a one-shot event).
    // The payload carries the remember flag so the CLI can persist it.
    let lastChoiceSent = variantProposalStore.getLensAgentChoice();
    if (lastChoiceSent) {
      send("agent-choice", {
        id: lastChoiceSent,
        remember: variantProposalStore.getLensAgentRemember(),
      });
    }

    // Replay the last completed outcome on connect too. The CLI relay re-reads
    // /outcome only ONCE at startup and otherwise relies on this stream, so if
    // the connection drops (transient socket / brief server restart) and the
    // human submits during the reconnect gap, that round's `outcome` event would
    // fire with no listener attached and be lost forever. Replaying it here (the
    // CLI dedups by `completedAt`, so a stale replay is a harmless no-op while a
    // missed one silently drops the user's feedback) closes that gap.
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

    // Heartbeat so an idle stream isn't dropped by a proxy or half-open socket;
    // a comment line is ignored by the SSE parser.
    const heartbeat = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        /* ignore */
      }
    }, 15_000);
    // Don't let the heartbeat keep the process alive on its own.
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
    if (device.platform !== "ios" && device.platform !== "android") {
      // This route only dispatches the iOS / Android describe adapters. Reject
      // any other platform loudly instead of letting it fall through to the
      // `else` (describeAndroid), which for a Chromium or Vega id would shell
      // `adb -s <id>` against a non-existent serial and 500 with a misleading
      // message. (The /simulators dropdown only ever emits ios/android ids, so
      // this is defense against forged tokenless requests, not the UI.)
      res.status(400).json({
        error: `describe is not available for ${device.platform} devices (id "${udid}"). Use the MCP tools (screenshot, describe, gesture-*) directly.`,
      });
      return;
    }
    try {
      // Like /simulator-server/:udid, this route is reachable without the auth
      // token. `describeIos`/`describeAndroid` shell out to `xcrun`/`adb`, so
      // bind the dispatch to an actually-present device — otherwise an
      // unauthenticated caller could flood distinct ids and amplify into
      // unbounded subprocess spawns. The UI only ever requests ids returned by
      // /preview/simulators — no regression. Validation goes through the
      // short-lived known-device cache (see top of createPreviewRouter): this
      // route is polled ~3×/s, so re-running `list-devices` per tick would
      // storm `xcrun`/`adb`/`ps`.
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
