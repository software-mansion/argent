import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolContext, ToolDefinition } from "@argent/registry";
import type { MacosAppApi } from "../../blueprints/macos-app";
import { InvalidToolInputError, assertSupported } from "../../utils/capability";
import { resolveDevice } from "../../utils/device-info";
import { getTrackedMacosApp, issueSandboxExtension } from "../../utils/macos-apps";
import { macosAppServices, requireMacosApp } from "../../utils/macos-input";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_PANEL_TIMEOUT_MS = 5000;
const MAX_PANEL_TIMEOUT_MS = 30_000;
const PANEL_POLL_MS = 100;

const zodSchema = z.object({
  udid: z.string().describe("Mac app id from `list-devices` (macos-app-<bundle id>)."),
  action: z
    .enum(["list", "choose", "cancel", "stub"])
    .describe(
      "list: the open file panels. choose: answer a panel with path or paths. cancel: cancel a panel. " +
        "stub: arm an answer or a cancel for the next panel the app presents (stubMode)."
    ),
  path: z
    .string()
    .min(1)
    .optional()
    .describe(
      "For choose and stub: the absolute path to answer with (a leading ~/ is your home folder). " +
        "An open panel takes an existing file or folder; a save panel takes the file to write, in an existing folder."
    ),
  paths: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe(
      "For choose and stub: several absolute paths, for an open panel that allows a multiple selection. Instead of path."
    ),
  panel: z
    .number()
    .int()
    .optional()
    .describe(
      "For choose and cancel: the panel's number from list. Needed only when more than one panel is open."
    ),
  stubMode: z
    .enum(["answer", "cancel", "off"])
    .optional()
    .describe(
      "For stub: answer the next panel with path or paths (default), cancel it, or off to disarm a stub that is still armed."
    ),
  panelKind: z
    .enum(["open", "save"])
    .optional()
    .describe(
      "For stub with stubMode answer: the kind of the next panel, which decides the path checks. Default: open when " +
        "every path exists, save when the one path does not exist yet."
    ),
  timeoutMs: z
    .number()
    .int()
    .min(0)
    .max(MAX_PANEL_TIMEOUT_MS)
    .optional()
    .describe(
      "For choose and cancel: how long to wait for a panel to appear after the click that opens it (default 5000)."
    ),
});

type Params = z.infer<typeof zodSchema>;

/** A panel as the app lists it; `list` returns its other fields (title, folder, options) as they come. */
interface MacosPanel {
  number: number;
  kind: "open" | "save";
  allowsMultiple?: boolean;
}

type Result =
  | { panels: MacosPanel[] }
  | { chosen: true; panel: number; kind: MacosPanel["kind"]; paths: string[] }
  | { cancelled: true; panel: number }
  | { armed: boolean; mode: "answer" | "cancel" | "off"; panelKind?: MacosPanel["kind"] };

const capability: ToolCapability = {
  macos: { app: true },
};

const invalid = (message: string, stage: string) =>
  new InvalidToolInputError(message, { failure_stage: stage });

/** `path` or `paths`, absolute after `~/` expansion. */
function requestedPaths(params: Params, action: string): string[] {
  if (params.path !== undefined && params.paths !== undefined) {
    throw invalid(`file-panel ${action} takes path or paths, not both.`, "file_panel_paths");
  }
  const raw = params.paths ?? (params.path !== undefined ? [params.path] : []);
  if (raw.length === 0) {
    throw invalid(`file-panel ${action} needs path (or paths).`, "file_panel_paths");
  }
  return raw.map((p) => {
    const expanded = p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
    if (!path.isAbsolute(expanded)) {
      throw invalid(
        `file-panel needs an absolute path, got "${p}". The app resolves no relative path.`,
        "file_panel_paths"
      );
    }
    return path.resolve(expanded);
  });
}

async function statOrNull(p: string): Promise<Stats | null> {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

/**
 * Checks the paths against the panel, before anything is sent to the app. The
 * panel's allowed file types are checked by the app: matching a file against them
 * needs the type conformance that only the app's process knows.
 */
async function checkPathsFor(
  panel: Pick<MacosPanel, "kind" | "allowsMultiple">,
  paths: string[]
): Promise<void> {
  if (panel.kind === "save") {
    if (paths.length > 1) {
      throw invalid("A save panel takes one path, the file to write.", "file_panel_save_paths");
    }
    const target = paths[0]!;
    // The app would replace the folder, and everything in it, with the document,
    // whatever the folder's name.
    if ((await statOrNull(target))?.isDirectory()) {
      throw invalid(
        `${target} is a folder, not a file to write. Pass a path inside it for a save panel, ` +
          `such as ${path.join(target, "<name>")}.`,
        "file_panel_save_paths"
      );
    }
    if (!(await statOrNull(path.dirname(target)))?.isDirectory()) {
      throw invalid(
        `The folder ${path.dirname(target)} does not exist. A save panel writes into an existing folder.`,
        "file_panel_save_paths"
      );
    }
    return;
  }
  if (paths.length > 1 && panel.allowsMultiple === false) {
    throw invalid(
      `This open panel takes one item, and ${paths.length} paths were given.`,
      "file_panel_open_paths"
    );
  }
  // The app refuses a folder for a files-only panel: only it can tell a folder
  // from a document package (.rtfd, .xcodeproj), which the panel takes as a file.
  for (const p of paths) {
    if (!(await statOrNull(p))) throw invalid(`${p} does not exist.`, "file_panel_open_paths");
  }
}

/**
 * A sandboxed app can read and write only what the user chose. The app is given
 * access to each chosen path, as the panel would give it, only when a panel
 * takes the answer: these tokens go with the answer. Read-only when the app may
 * only read the files a user chooses.
 */
async function sandboxTokens(app: MacosAppApi, paths: string[]): Promise<{ tokens?: string[] }> {
  const tracked = getTrackedMacosApp(app.bundleId);
  if (!tracked?.sandboxed) return {};
  // The sandbox checks the resolved path (/tmp is /private/tmp), so the grant names
  // it. A file to save does not exist yet: its folder is resolved.
  const resolved = await Promise.all(
    paths.map((p) =>
      fs
        .realpath(p)
        .catch(async () => path.join(await fs.realpath(path.dirname(p)), path.basename(p)))
    )
  );
  const tokens: string[] = [];
  // One token per path, in the order of the paths: the app matches them by position.
  for (const target of resolved) {
    tokens.push(await issueSandboxExtension(target, { readOnly: tracked.userSelectedReadOnly }));
  }
  return { tokens };
}

/** One path goes as `path`, several as `paths`, as the app takes them. */
const pathParams = (paths: string[]) => (paths.length === 1 ? { path: paths[0] } : { paths });

async function listPanels(app: MacosAppApi): Promise<MacosPanel[]> {
  return (await app.call<{ panels?: MacosPanel[] }>("Panel.list")).panels ?? [];
}

/**
 * The panel to act on. A click returns before the app presents its panel, so
 * this polls `Panel.list` up to `timeoutMs`.
 */
async function waitForPanel(
  app: MacosAppApi,
  params: Params,
  signal: AbortSignal | undefined
): Promise<MacosPanel> {
  const deadline = Date.now() + (params.timeoutMs ?? DEFAULT_PANEL_TIMEOUT_MS);
  for (;;) {
    const panels = await listPanels(app);
    if (params.panel !== undefined) {
      const match = panels.find((p) => p.number === params.panel);
      if (match) return match;
    } else if (panels.length > 1) {
      throw invalid(
        `${panels.length} file panels are open (numbers ${panels.map((p) => p.number).join(", ")}). ` +
          "Pass panel with one of these numbers; list describes each.",
        "file_panel_ambiguous"
      );
    } else if (panels.length === 1) {
      return panels[0]!;
    }
    if (signal?.aborted) {
      const err = new Error("file-panel aborted while it waited for a panel");
      err.name = "AbortError";
      throw err;
    }
    if (Date.now() >= deadline) {
      const which =
        params.panel !== undefined
          ? `File panel ${params.panel} is not open`
          : "No file panel is open";
      const open = panels.length > 0 ? ` (open: ${panels.map((p) => p.number).join(", ")})` : "";
      throw invalid(
        `${which}${open} in ${app.bundleId}. Open it in the app first (gesture-tap on the button that shows it), ` +
          "or arm an answer for the next one with action stub.",
        "file_panel_not_open"
      );
    }
    await sleep(PANEL_POLL_MS);
  }
}

async function choose(
  app: MacosAppApi,
  params: Params,
  ctx: ToolContext | undefined
): Promise<Result> {
  const paths = requestedPaths(params, "choose");
  const panel = await waitForPanel(app, params, ctx?.signal);
  await checkPathsFor(panel, paths);
  await app.call("Panel.complete", {
    ...pathParams(paths),
    ...(await sandboxTokens(app, paths)),
    panel: panel.number,
  });
  return { chosen: true, panel: panel.number, kind: panel.kind, paths };
}

async function stub(app: MacosAppApi, params: Params): Promise<Result> {
  const mode = params.stubMode ?? "answer";
  if (mode !== "answer") {
    if (params.path !== undefined || params.paths !== undefined || params.panelKind !== undefined) {
      throw invalid(`stubMode ${mode} takes no path and no panelKind.`, "file_panel_stub_paths");
    }
    const { armed } = await app.call<{ armed: boolean }>("Panel.stub", { mode });
    return { armed, mode };
  }
  const paths = requestedPaths(params, "stub");
  // The next panel is not shown yet, so its kind is declared or inferred: paths
  // that all exist are an open panel's answer, one new path is a file to save.
  let panelKind = params.panelKind;
  if (panelKind === undefined) {
    panelKind = paths.length === 1 && !(await statOrNull(paths[0]!)) ? "save" : "open";
    if (panelKind === "save" && !(await statOrNull(path.dirname(paths[0]!)))?.isDirectory()) {
      throw invalid(
        `${paths[0]} does not exist, and neither does its folder. An open panel needs an existing ` +
          "file or folder; a save panel needs a file in an existing folder.",
        "file_panel_stub_paths"
      );
    }
  }
  await checkPathsFor({ kind: panelKind }, paths);
  const { armed } = await app.call<{ armed: boolean }>("Panel.stub", {
    mode,
    ...pathParams(paths),
    ...(await sandboxTokens(app, paths)),
  });
  return { armed, mode, panelKind };
}

export const filePanelTool: ToolDefinition<Params, Result> = {
  id: "file-panel",
  featureFlag: "macos-apps",
  interaction: {
    startedMsg: ({ params }) =>
      params.action === "list" ? "Listing file panels" : `File panel: ${params.action}`,
    completedMsg: ({ params }) =>
      params.action === "list" ? "Listed file panels" : `File panel: ${params.action} done`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to ${params.action} a file panel: ${failureSignal.error_code}`,
  },
  description: `Complete or cancel the open and save panels (file dialogs) of a Mac app. describe cannot read a panel's file list and gesture-tap cannot pick a file in it; this tool completes the panel the way the user's choice would.
Use when a click in a Mac app opens an open or save panel (list shows whether one is open), or before such a click, to answer the next panel without it ever appearing.
Actions: list returns the open panels with their number, kind (open or save), title, folder and options. choose answers a panel with path, or paths for a multiple selection: an existing file or folder for an open panel, the file to write for a save panel; it waits up to timeoutMs for the panel to appear after the click. cancel cancels a panel. stub arms a one-shot answer (stubMode answer, with path) or a cancel (stubMode cancel) for the next panel the app presents; stubMode off disarms it.
For stub, panelKind names the kind of the next panel; without it, paths that exist mean an open panel and one path that does not exist yet means a save panel. A next panel that could not take the answer (several paths for a single selection, a folder for a panel of files or for a save panel) opens as usual.
A sandboxed app that argent started is given access to the chosen paths only. On a save panel that offers several file formats, the path's extension picks the format.
Returns { panels } for list, { chosen, panel, kind, paths } for choose, { cancelled, panel } for cancel, { armed, mode, panelKind? } for stub.
Fails if no panel appears within timeoutMs, if more than one panel is open and panel is not given, if a path is relative or does not exist (a save panel needs an existing folder), if the panel cannot take it (a folder for a panel of files, a file for a panel of folders, an existing folder for a save panel, an extension that matches none of a save panel's formats), or if the Mac app is not running.`,
  searchHint: "file panel dialog open save choose pick file folder nsopenpanel nssavepanel mac app",
  zodSchema,
  capability,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    return device.platform === "macos" ? macosAppServices(device) : {};
  },
  async execute(services, params, ctx) {
    const device = resolveDevice(params.udid);
    // A flow step skips the HTTP capability gate.
    assertSupported("file-panel", capability, device);
    const app = requireMacosApp(services, "file-panel", device);
    switch (params.action) {
      case "list":
        return { panels: await listPanels(app) };
      case "choose":
        return choose(app, params, ctx);
      case "cancel": {
        const panel = await waitForPanel(app, params, ctx?.signal);
        await app.call("Panel.cancel", { panel: panel.number });
        return { cancelled: true, panel: panel.number };
      }
      case "stub":
        return stub(app, params);
    }
  },
};
