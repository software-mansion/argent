/**
 * `argent map` — crawl an app on a booted simulator/emulator into a directed
 * graph of its reachable screens.
 *
 * The crawl itself runs in the tool-server (the long-running `map-app` tool);
 * this command is a thin driver: resolve the target device, invoke the tool
 * with NDJSON progress streaming, print progress lines as screens are
 * discovered, and finish with a summary plus the preview-window Map URL. The
 * graph renders live in the preview window's Map tab while the crawl runs
 * (suppress with --no-window), and `--json` additionally writes the full graph
 * state to a file. Repeatable `--deep-link <url>` flags seed extra entry points
 * (an app is a graph, not a tree), letting the crawl jump straight into
 * deep-linked screens rather than only tapping outward from the launch screen.
 *
 * Ctrl-C aborts the in-flight HTTP call — the server observes the client
 * abort, cancels the crawl, and keeps the partial graph — then this command
 * prints a partial summary and exits 130.
 *
 * The progress/graph shapes are the tool-server's map contract consumed as
 * JSON; minimal local mirrors are declared below rather than importing the
 * tool-server package.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import pc from "picocolors";
import { createToolsClient, type ToolsServerPaths } from "@argent/tools-client";
import { isFlagEnabled } from "@argent/configuration-core";
import { FlagParseException } from "./flag-parser.js";
import { exitAfterFlush } from "./flow.js";

export interface MapCommandOptions {
  paths: ToolsServerPaths;
}

// Mirrors MAP_DEFAULT_LIMITS.maxScreens in the tool-server's map contract
// (deliberately not imported — the CLI consumes the tool over HTTP). Only used
// for display: the `[n/max]` progress prefix and the --help text.
const DEFAULT_MAX_SCREENS = 30;

// Upper bounds, mirroring the tool-server's zod schema (map/index.ts). Enforced
// client-side so an over-cap flag fails with a one-line message here instead of
// the server bouncing it back as a multi-line ZodError blob.
const FLAG_MAX = {
  "--max-screens": 100,
  "--max-actions": 30,
  "--max-depth": 10,
  "--budget": 1800,
} as const;

// The repeatable --deep-link flag has a count cap too (the server schema is
// z.array(z.string()).max(20)); enforced here for the same reason as FLAG_MAX,
// so a 21st link fails with a one-line message instead of a ZodError blob.
const MAX_DEEP_LINKS = 20;

// Device-sourced text (screen titles, element labels) comes from an arbitrary,
// untrusted app and is printed to the user's terminal. Strip C0/C1 control
// bytes and DEL so a crafted accessibility label can't smuggle ANSI/OSC escape
// sequences (screen-clear, clipboard-write, title-set) through stdout. The
// --json path is already safe — JSON.stringify escapes these.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;
function sanitizeDeviceText(text: string): string {
  return text.replace(CONTROL_CHARS, "");
}

/** Minimal mirror of the tool-server's MapProgressEvent contract. */
type MapProgressEvent =
  | { kind: "screen"; nodeId: string; title: string; depth: number; screens: number }
  | { kind: "action"; nodeId: string; label: string; explored: number; total: number }
  | { kind: "restart"; reason: string }
  | { kind: "phase"; message: string };

/** Counts printed in the final summary (mirror of the contract's MapCrawlStats
 * slice the CLI reads; unknown fields are ignored). */
export interface MapSummaryStats {
  screens: number;
  edges: number;
  restarts: number;
  elapsedMs: number;
}

/** Trimmed result the `map-app` tool resolves with (summary only — the full
 * graph stays on `GET /preview/map`). */
interface MapAppResult {
  status?: string;
  stats?: unknown;
}

export interface MapArgs {
  bundleId: string | null;
  udid: string | null;
  maxScreens: number | null;
  maxActions: number | null;
  maxDepth: number | null;
  budgetS: number | null;
  /** Deep-link URLs (repeatable --deep-link) that seed extra crawl entry
   * points — an app is a graph, not a tree, so the crawl can jump straight into
   * deep-linked screens. Empty when none were passed. */
  deepLinks: string[];
  window: boolean;
  json: boolean;
  /** Output path for --json; null means the default ./argent-map.json. */
  jsonPath: string | null;
  help: boolean;
}

/**
 * Hand-rolled argv parser (same style as `argent lens`). Throws
 * FlagParseException on a usage error. `--json` takes an optional path, but the
 * explicit form is spelled attached — `--json=<path>` — the same `--flag=value`
 * convention the rest of the CLI uses (see run.ts / flow.ts). Bare `--json`
 * always means "write to the default path", so it never swallows a following
 * token: `argent map --json com.example.app` unambiguously targets the app, and
 * ordering (`--json` before or after the bundle id) no longer changes anything.
 * `--deep-link <url>` is repeatable (each collects into `deepLinks`) and also
 * accepts the attached `--deep-link=<url>` form, the same convention as
 * `--json=<path>`; an empty url in either form is rejected.
 */
export function parseMapArgs(argv: string[]): MapArgs {
  const args: MapArgs = {
    bundleId: null,
    udid: null,
    maxScreens: null,
    maxActions: null,
    maxDepth: null,
    budgetS: null,
    deepLinks: [],
    window: true,
    json: false,
    jsonPath: null,
    help: false,
  };

  const readValue = (flag: string, i: number): string => {
    const v = argv[i + 1];
    if (v === undefined) throw new FlagParseException(`${flag} requires a value`);
    // Don't swallow a following flag as the value (e.g. `--udid --max-screens`).
    // A `-`-leading token is only a legitimate value when it's a negative
    // number, which numeric flags may receive and then reject downstream with a
    // clearer "positive integer" message; anything else `-`-leading is a flag.
    if (v.startsWith("-") && !Number.isFinite(Number(v))) {
      throw new FlagParseException(`${flag} expects a value, but got the flag "${v}"`);
    }
    return v;
  };
  const readPositiveInt = (flag: keyof typeof FLAG_MAX, i: number): number => {
    const raw = readValue(flag, i);
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      throw new FlagParseException(`${flag} expects a positive integer, got "${raw}"`);
    }
    const max = FLAG_MAX[flag];
    if (n > max) {
      throw new FlagParseException(`${flag} must be at most ${max}, got ${n}`);
    }
    return n;
  };

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === "--help" || tok === "-h") {
      args.help = true;
    } else if (tok === "--udid") {
      args.udid = readValue(tok, i);
      i += 1;
    } else if (tok === "--max-screens") {
      args.maxScreens = readPositiveInt(tok, i);
      i += 1;
    } else if (tok === "--max-actions") {
      args.maxActions = readPositiveInt(tok, i);
      i += 1;
    } else if (tok === "--max-depth") {
      args.maxDepth = readPositiveInt(tok, i);
      i += 1;
    } else if (tok === "--budget") {
      args.budgetS = readPositiveInt(tok, i);
      i += 1;
    } else if (tok === "--deep-link") {
      // Repeatable: each --deep-link seeds an extra crawl entry point. The bare
      // form takes the next token as the url and reuses readValue's guard so a
      // following flag isn't swallowed; the attached --deep-link=<url> form is
      // handled just below (mirroring --json=<path>). Empty urls are rejected.
      const link = readValue(tok, i);
      if (link === "") throw new FlagParseException(`--deep-link requires a non-empty url`);
      args.deepLinks.push(link);
      i += 1;
    } else if (tok.startsWith("--deep-link=")) {
      const link = tok.slice("--deep-link=".length);
      if (link === "")
        throw new FlagParseException(`--deep-link expects a url when written as --deep-link=<url>`);
      args.deepLinks.push(link);
    } else if (tok === "--no-window") {
      args.window = false;
    } else if (tok === "--json") {
      // Bare `--json` writes to the default path — the optional path is only
      // ever taken attached (`--json=<path>`), so no following token is
      // consumed and flag ordering is irrelevant.
      args.json = true;
    } else if (tok.startsWith("--json=")) {
      args.json = true;
      const p = tok.slice("--json=".length);
      if (p === "")
        throw new FlagParseException(`--json expects a path when written as --json=<path>`);
      args.jsonPath = p;
    } else if (tok.startsWith("-")) {
      throw new FlagParseException(`Unknown flag: ${tok}`);
    } else if (args.bundleId === null) {
      args.bundleId = tok;
    } else {
      throw new FlagParseException(`Unexpected extra argument: "${tok}"`);
    }
  }

  if (args.deepLinks.length > MAX_DEEP_LINKS) {
    throw new FlagParseException(
      `--deep-link accepts at most ${MAX_DEEP_LINKS} urls, got ${args.deepLinks.length}`
    );
  }

  return args;
}

/** One device the crawl could target, as offered to the user. */
export interface MapDeviceCandidate {
  /** iOS simulator UDID or Android adb serial — what map-app's `udid` takes. */
  id: string;
  /** Human line for the "several devices — pick one" listing. */
  label: string;
}

/**
 * Booted mobile targets the crawler can drive, from a `list-devices` result's
 * `devices` array: iOS simulators (state "Booted") and Android
 * emulators/physical devices (state "device"). TV targets are excluded — the
 * crawler taps, TV UIs are focus-driven. Tolerates unknown shapes (a device
 * entry is whatever the connected tool-server version returns).
 */
export function bootedMapCandidates(devices: unknown): MapDeviceCandidate[] {
  if (!Array.isArray(devices)) return [];
  const out: MapDeviceCandidate[] = [];
  for (const entry of devices) {
    if (!entry || typeof entry !== "object") continue;
    const d = entry as Record<string, unknown>;
    if (d.runtimeKind === "tv") continue;
    if (d.platform === "ios" && d.state === "Booted" && typeof d.udid === "string") {
      const name = typeof d.name === "string" && d.name ? d.name : "iOS simulator";
      out.push({ id: d.udid, label: `${d.udid}  ${name} (ios)` });
    } else if (d.platform === "android" && d.state === "device" && typeof d.serial === "string") {
      const name =
        typeof d.avdName === "string" && d.avdName
          ? d.avdName
          : typeof d.model === "string" && d.model
            ? d.model
            : "Android device";
      out.push({ id: d.serial, label: `${d.serial}  ${name} (android)` });
    }
  }
  return out;
}

/**
 * Render one progress event as a printable line, or null for an unknown
 * shape. Discovered screens print prominently; action/restart/phase noise is
 * marked `dim` so the caller can de-emphasise it on a TTY.
 */
export function formatProgressLine(
  event: unknown,
  maxScreens: number
): { text: string; dim: boolean } | null {
  if (!event || typeof event !== "object" || !("kind" in event)) return null;
  const e = event as MapProgressEvent;
  switch (e.kind) {
    // `title`/`label` are device-sourced (an untrusted app's accessibility
    // text) — strip control bytes before they reach the terminal.
    case "screen":
      return {
        text: `[${e.screens}/${maxScreens}] ${sanitizeDeviceText(e.title)} (depth ${e.depth})`,
        dim: false,
      };
    case "action":
      return { text: `    · ${sanitizeDeviceText(e.label)} (${e.explored}/${e.total})`, dim: true };
    case "restart":
      return { text: `    ↻ restart: ${e.reason}`, dim: true };
    case "phase":
      return { text: `    ${e.message}`, dim: true };
    default:
      return null;
  }
}

/** Final summary line: counts + elapsed, worded by how the crawl ended. */
export function formatMapSummary(status: string, stats: MapSummaryStats): string {
  const plural = (n: number): string => (n === 1 ? "" : "s");
  const body =
    `${stats.screens} screen${plural(stats.screens)}, ` +
    `${stats.edges} edge${plural(stats.edges)}, ` +
    `${stats.restarts} restart${plural(stats.restarts)} ` +
    `in ${(stats.elapsedMs / 1000).toFixed(1)}s`;
  if (status === "cancelled") return `Cancelled — partial map: ${body}`;
  if (status === "failed") return `Failed — partial map: ${body}`;
  return `Mapped ${body}`;
}

// Coerce whatever stats shape the server returned into the summary slice,
// zero-filling anything missing (an older/newer server may drift).
function normalizeStats(stats: unknown, fallback: MapSummaryStats): MapSummaryStats {
  if (!stats || typeof stats !== "object") return fallback;
  const s = stats as Record<string, unknown>;
  const num = (v: unknown, dflt: number): number => (typeof v === "number" ? v : dflt);
  return {
    screens: num(s.screens, fallback.screens),
    edges: num(s.edges, fallback.edges),
    restarts: num(s.restarts, fallback.restarts),
    elapsedMs: num(s.elapsedMs, fallback.elapsedMs),
  };
}

// De-emphasise a line on an interactive TTY only — picocolors' own detection
// also colorizes when CI is set, which would leak escapes into piped output
// (same reasoning as flags.ts's colorState).
function dim(s: string): string {
  return process.stdout.isTTY ? pc.dim(s) : s;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Fetch the full crawl state from `GET <baseUrl>/preview/map` (the graph the
 * preview window renders), authenticating like the tools client does. */
async function fetchMapState(baseUrl: string, token: string): Promise<unknown> {
  const res = await fetch(`${baseUrl}/preview/map`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`GET /preview/map failed: ${res.status} ${res.statusText}`);
  return res.json();
}

/** Write an already-fetched map `state` to the `--json` output path (default
 * ./argent-map.json), creating parent directories as needed. Returns the
 * resolved path written. Shared by the normal-finish and cancel paths so a
 * cancelled crawl keeps the JSON artifact the user asked for. */
export function writeMapJson(state: unknown, jsonPath: string | null): string {
  const outPath = path.resolve(jsonPath ?? "argent-map.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(state, null, 2) + "\n");
  return outPath;
}

function printHelp(): void {
  process.stdout.write(
    `Usage: argent map <bundleId> [options]\n\n` +
      `Crawl an app on a booted simulator/emulator into a graph of reachable screens.\n\n` +
      `  Explores the app by tapping through its screens, deduplicating them by\n` +
      `  structure. Progress streams here while the graph renders live in the Argent\n` +
      `  preview window's Map tab.\n\n` +
      `Options:\n` +
      `      --udid <id>         Target device (iOS simulator UDID or Android adb serial).\n` +
      `                          Defaults to the single booted device.\n` +
      `      --max-screens <n>   Stop after discovering this many screens (default ${DEFAULT_MAX_SCREENS}, max ${FLAG_MAX["--max-screens"]})\n` +
      `      --max-actions <n>   Tappable elements explored per screen (default 12, max ${FLAG_MAX["--max-actions"]})\n` +
      `      --max-depth <n>     Maximum taps away from the start screen (default 5, max ${FLAG_MAX["--max-depth"]})\n` +
      `      --budget <seconds>  Overall time budget for the crawl (default 300, max ${FLAG_MAX["--budget"]})\n` +
      `      --deep-link <url>   Seed an extra entry point by deep-linking into the app (repeatable)\n` +
      `      --no-window         Do not open the preview window\n` +
      `      --json[=path]       Also write the full graph JSON (default ./argent-map.json)\n` +
      `  -h, --help              Show this help\n`
  );
}

export async function map(argv: string[], options: MapCommandOptions): Promise<void> {
  let args: MapArgs;
  try {
    args = parseMapArgs(argv);
  } catch (err) {
    if (err instanceof FlagParseException) {
      process.stderr.write(`map: ${err.message}\nRun \`argent map --help\` for usage.\n`);
      return exitAfterFlush(1);
    }
    throw err;
  }

  if (args.help) {
    printHelp();
    return;
  }

  if (!isFlagEnabled("argent-map")) {
    process.stderr.write(
      "Argent Map is behind a feature flag. Enable it first:\n\n  argent enable argent-map\n\n"
    );
    return exitAfterFlush(1);
  }

  if (!args.bundleId) {
    process.stderr.write(
      "argent map requires an app bundle id (e.g. com.example.app).\n" +
        "Run `argent map --help` for usage.\n"
    );
    return exitAfterFlush(1);
  }
  const bundleId = args.bundleId;

  const { callTool, baseUrl } = createToolsClient({ paths: options.paths });

  // Resolve the tool-server first (spawning it if needed): its base URL feeds
  // the Map link in every summary and the --json fetch.
  let url: string;
  let token: string;
  try {
    ({ url, token } = await baseUrl());
  } catch (err) {
    process.stderr.write(`map: could not reach the tool-server: ${errMsg(err)}\n`);
    return exitAfterFlush(1);
  }

  // Target device: --udid wins; otherwise exactly one booted mobile target
  // must be running — zero or several is an error listing what was found.
  let udid = args.udid;
  if (!udid) {
    let listed: unknown;
    try {
      listed = (await callTool("list-devices", {})).data;
    } catch (err) {
      process.stderr.write(`map: could not list devices: ${errMsg(err)}\n`);
      return exitAfterFlush(1);
    }
    const devices = (listed as { devices?: unknown } | null)?.devices;
    const candidates = bootedMapCandidates(devices);
    if (candidates.length === 0) {
      process.stderr.write(
        "map: no booted iOS simulator or Android device found. Boot one, or pass --udid <id>.\n"
      );
      return exitAfterFlush(1);
    }
    if (candidates.length > 1) {
      process.stderr.write(
        "map: several booted devices found — pass --udid <id> to pick one:\n" +
          candidates.map((c) => `  ${c.label}`).join("\n") +
          "\n"
      );
      return exitAfterFlush(1);
    }
    udid = candidates[0]!.id;
  }

  const mapUrl = `${url}/preview/?udid=${encodeURIComponent(udid)}&tab=map`;
  const maxScreens = args.maxScreens ?? DEFAULT_MAX_SCREENS;

  const payload: Record<string, unknown> = { udid, bundleId, openWindow: args.window };
  if (args.maxScreens !== null) payload.maxScreens = args.maxScreens;
  if (args.maxActions !== null) payload.maxActionsPerScreen = args.maxActions;
  if (args.maxDepth !== null) payload.maxDepth = args.maxDepth;
  if (args.budgetS !== null) payload.timeBudgetS = args.budgetS;
  // Each deep link becomes an additional crawl entry point on the server. Omit
  // the field entirely when none were passed (same as the other optionals).
  if (args.deepLinks.length > 0) payload.deepLinks = args.deepLinks;

  // Track what the progress stream reported so a cancelled run can still
  // print a summary when the aborted call yields no result and the map state
  // endpoint is unreachable.
  const seen: MapSummaryStats = { screens: 0, edges: 0, restarts: 0, elapsedMs: 0 };
  const startedAt = Date.now();
  const onProgress = (event: unknown): void => {
    const line = formatProgressLine(event, maxScreens);
    if (!line) return;
    const e = event as { kind?: unknown; screens?: unknown };
    if (e.kind === "screen" && typeof e.screens === "number") seen.screens = e.screens;
    if (e.kind === "restart") seen.restarts += 1;
    console.log(line.dim ? dim(line.text) : line.text);
  };

  // Ctrl-C: abort the in-flight HTTP call — that is the cancellation channel;
  // the server observes the client abort, cancels the crawl between steps, and
  // finalizes the partial graph. A second Ctrl-C exits immediately.
  const ac = new AbortController();
  let interrupted = false;
  const onSigint = (): void => {
    if (interrupted) process.exit(130);
    interrupted = true;
    process.stderr.write("\n  Cancelling the crawl…\n");
    ac.abort();
  };
  process.on("SIGINT", onSigint);

  let result: MapAppResult | null = null;
  let callError: unknown = null;
  try {
    const resp = await callTool("map-app", payload, { onProgress, signal: ac.signal });
    result = resp.data as MapAppResult;
    if (resp.note) console.error(resp.note);
  } catch (err) {
    callError = err;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }

  if (interrupted) {
    // The abort tore the call down, so no result arrived. The map state
    // endpoint has the authoritative partial stats (the server finalizes the
    // graph as "cancelled"); fall back to what the progress stream reported.
    seen.elapsedMs = Date.now() - startedAt;
    const state = (await fetchMapState(url, token).catch(() => null)) as {
      stats?: unknown;
    } | null;
    const stats = normalizeStats(state?.stats, seen);
    console.log(`\n  ${formatMapSummary("cancelled", stats)}`);
    console.log(`  Map: ${mapUrl}`);
    // Cancel is the supported "stop and keep the partial graph" path, so honour
    // a requested --json here too — reusing the state already fetched above
    // rather than fetching it a second time. A write failure doesn't change the
    // 130 exit; the crawl was still cancelled.
    if (args.json) {
      if (state !== null) {
        try {
          console.log(`  Wrote: ${writeMapJson(state, args.jsonPath)}`);
        } catch (err) {
          console.error(`map: failed to write the graph JSON: ${errMsg(err)}`);
        }
      } else {
        console.error("map: could not fetch the partial graph, so --json output was not written.");
      }
    }
    return exitAfterFlush(130);
  }

  if (callError) {
    console.error(errMsg(callError));
    if (seen.screens > 0) {
      // A partial graph exists on the server — point at it rather than
      // discarding what the crawl covered before failing.
      console.error(`Partial map (${seen.screens} screen${seen.screens === 1 ? "" : "s"}):`);
      console.error(`  ${mapUrl}`);
    }
    return exitAfterFlush(1);
  }

  const status = typeof result?.status === "string" ? result.status : "completed";
  seen.elapsedMs = Date.now() - startedAt;
  const stats = normalizeStats(result?.stats, seen);
  console.log(`\n  ${formatMapSummary(status, stats)}`);
  console.log(`  Map: ${mapUrl}`);

  if (args.json) {
    try {
      const state = await fetchMapState(url, token);
      console.log(`  Wrote: ${writeMapJson(state, args.jsonPath)}`);
    } catch (err) {
      console.error(`map: failed to write the graph JSON: ${errMsg(err)}`);
      return exitAfterFlush(1);
    }
  }

  return exitAfterFlush(status === "failed" ? 1 : 0);
}
