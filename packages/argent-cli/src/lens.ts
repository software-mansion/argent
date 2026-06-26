/**
 * `argent lens` — open Argent Lens bound to a fresh coding-agent session.
 *
 * The problem this solves: the Lens preview window and the agent talk through a
 * shared, process-wide tool-server that carries no per-agent identity, so when
 * the user requests changes in the window there is no way to know WHICH agent to
 * route them to. This command sidesteps that entirely by inverting ownership —
 * the human launches Lens, and Lens spawns (and therefore owns) exactly one
 * agent terminal. The binding is 1:1 by construction.
 *
 * Flow — the foreground command does the minimum, then DETACHES so the terminal
 * is freed:
 *   1. Ensure a tool-server is up; decide the agent (resolved now for `--agent`
 *      or a single install, otherwise the window's picker chooses among the
 *      installed ones; see `lens-agents.ts`).
 *   2. Mark a CLI Lens session so the tool-server opens the preview window now
 *      (no `await_user_selection` needed), handing it the picker choices.
 *   3. Fork a detached background BRIDGE and return. The bridge ensures a device
 *      is streaming, resolves the agent (a given one, or whichever the human
 *      clicks in the window), spawns its terminal seeded to use `propose_variant`
 *      without blocking, and watches the tool-server for submitted feedback —
 *      typing a one-line summary into the terminal as the agent's next prompt.
 *
 * macOS only: the terminal spawn/track/write path drives `osascript` (see
 * `lens-terminal.ts`).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createToolsClient, type ToolsServerPaths } from "@argent/tools-client";
import { isFlagEnabled } from "@argent/configuration-core";
import {
  resolveTerminal,
  spawnTerminalSession,
  writeToSession,
  readSessionText,
  pressEnter,
  isSessionAlive,
  shellQuote,
  flattenLine,
  type TerminalApp,
  type TerminalSession,
} from "./lens-terminal.js";
import {
  AGENTS,
  detectInstalledAgents,
  findAgentById,
  isAgentInstalled,
  agentIds,
  type AgentSpec,
} from "./lens-agents.js";

type ToolsClient = ReturnType<typeof createToolsClient>;

export interface LensCommandOptions {
  paths: ToolsServerPaths;
}

/** Shape of the completed-round outcome returned by `GET /preview/outcome`. */
interface LensOutcome {
  status: "completed";
  round: number;
  selections: Array<{
    element: string;
    match: { by: string; value: string };
    chosenVariant: { name: string; summary?: string; filePath?: string } | null;
    comment?: string;
  }>;
  unselected: Array<{ element: string }>;
  annotations: Array<{ target: string; match: { by: string; value: string }; comment: string }>;
  globalComment?: string;
  completedAt: number;
}

const POLL_INTERVAL_MS = 1_200;
// A just-spawned session may not show in `ps` for a beat; don't call it dead
// inside this window. Mirrors the applet's grace interval.
const SPAWN_GRACE_MS = 8_000;
// Require this many consecutive "tty gone" reads (after the grace window) before
// concluding the terminal closed — guards against a transient `ps` miss.
const DEATH_CONFIRMATIONS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A first-run agent often opens on a "trust this folder?" confirmation whose
// default option is "Yes, I trust" — match its on-screen text so we only press
// Enter when it's actually showing (never on the agent's own later output).
const TRUST_PROMPT_RE = /trust this folder|do you trust|yes,? i trust|trust the files in this/i;

/**
 * Briefly watch the spawned session for a first-run "trust this folder?" prompt
 * and press Enter (its default is the trust-and-continue option) so the seeded
 * session starts without the user babysitting it. No-op when no such prompt
 * shows. If the terminal's text can't be read, falls back to a single best-
 * effort Enter once (harmless on an idle composer). Bounded so it never lingers.
 */
async function dismissTrustPrompt(session: TerminalSession): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    await sleep(700);
    const text = readSessionText(session);
    if (text == null) {
      // Can't introspect this terminal — one blind Enter, then stop.
      pressEnter(session);
      return;
    }
    if (TRUST_PROMPT_RE.test(text)) {
      pressEnter(session);
      return;
    }
  }
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Decide how the agent gets chosen. With `--agent`, validate it's known and
 * installed and resolve it now. Otherwise auto-resolve the only installed agent,
 * or defer to the window's picker when several are present (returning the
 * choices). Exits (nothing is open yet) when there's no usable agent.
 */
function planAgent(agentId: string | undefined): { agent: AgentSpec } | { choose: AgentSpec[] } {
  if (agentId) {
    const want = findAgentById(agentId);
    if (!want) {
      process.stderr.write(
        `lens: unknown agent "${agentId}". Choose one of: ${agentIds().join(", ")}\n`
      );
      process.exit(2);
    }
    if (!isAgentInstalled(want)) {
      process.stderr.write(
        `lens: ${want.displayName} (${want.bin}) is not installed or not on PATH.\n`
      );
      process.exit(1);
    }
    return { agent: want };
  }

  const installed = detectInstalledAgents();
  if (installed.length === 0) {
    process.stderr.write(
      "lens: no supported coding-agent CLI found on PATH.\n" +
        `  Install one of: ${AGENTS.map((a) => a.bin).join(", ")}, then re-run argent lens.\n`
    );
    process.exit(1);
  }
  if (installed.length === 1) return { agent: installed[0] };
  return { choose: installed };
}

/** Shape of a `list-devices` entry we care about (the tool returns more). */
interface ListedDevice {
  platform?: string;
  state?: string;
  udid?: string;
  name?: string;
  serial?: string;
}

function isDeviceReady(d: ListedDevice): boolean {
  if (d.platform === "ios") return d.state === "Booted";
  if (d.platform === "android") return d.state === "device";
  if (d.platform === "vega") return d.state === "running" || d.state === "device";
  if (d.platform === "chromium") return true; // only listed when its CDP is live
  return false;
}

function deviceLabel(d: ListedDevice): string {
  return d.name || d.udid || d.serial || "device";
}

/**
 * Ensure a device is running so the preview window can stream. Uses the already
 * up tool-server: if nothing is booted, boots an iOS simulator (or an Android
 * AVD). Entirely best-effort — every failure path just prints a note and lets
 * the session start anyway (the agent can still target a device by udid later).
 */
async function ensureDevice(client: ToolsClient): Promise<void> {
  let data: { devices?: ListedDevice[]; avds?: Array<{ name?: string }> } | undefined;
  try {
    data = (await client.callTool("list-devices", {})).data as typeof data;
  } catch (err) {
    process.stdout.write(
      `  (couldn't list devices: ${errMsg(err)}; the preview streams once a device is up)\n`
    );
    return;
  }
  const devices = Array.isArray(data?.devices) ? data.devices : [];
  const avds = Array.isArray(data?.avds) ? data.avds : [];

  const ready = devices.find(isDeviceReady);
  if (ready) {
    process.stdout.write(`  Device ready: ${deviceLabel(ready)}.\n`);
    return;
  }

  const iosSim = devices.find((d) => d.platform === "ios" && d.udid);
  try {
    if (iosSim) {
      process.stdout.write(`  Booting iOS simulator "${deviceLabel(iosSim)}"…\n`);
      await client.callTool("boot-device", { udid: iosSim.udid });
      process.stdout.write("  Simulator booted.\n");
    } else if (avds.length && avds[0].name) {
      process.stdout.write(`  Booting Android emulator "${avds[0].name}"…\n`);
      await client.callTool("boot-device", { avdName: avds[0].name });
      process.stdout.write("  Emulator booted.\n");
    } else {
      process.stdout.write(
        "  No simulator or emulator found — start one (or create an iOS simulator) so the\n" +
          "  preview can stream the device.\n"
      );
    }
  } catch (err) {
    process.stdout.write(
      `  (couldn't boot a device: ${errMsg(err)}; continuing — the agent can target one by udid)\n`
    );
  }
}

/** Seed an inject-mode agent (its TUI takes no initial-prompt arg) by typing the
 * CLI-Lens prompt in once the terminal has settled after boot. */
async function injectSeedAfterBoot(session: TerminalSession): Promise<void> {
  await sleep(5_000);
  writeToSession(session, buildSeedPrompt());
}

/** The instruction the spawned `claude` starts with, establishing CLI-Lens
 * behaviour. Kept short and explicit. */
export function buildSeedPrompt(): string {
  return [
    "You are running inside an Argent Lens CLI session. The user has the Argent Lens",
    "preview window open and bound to THIS terminal.",
    "",
    "When the user asks you to redesign or restyle UI, use the `propose_variant` Argent",
    "tool to stage at least two visual variants per element. Do NOT call",
    "`await_user_selection` — in this session you never block waiting for a pick. After",
    "proposing, end your turn.",
    "",
    "The user reviews the variants in the Lens window; their feedback arrives here as a",
    'normal message prefixed "[Argent Lens]" (which variants they chose, comments, and',
    "change requests). Act on it by proposing refined variants the same way.",
    "",
    "Wait for the user's first instruction.",
  ].join(" ");
}

/** Build the one-line prompt typed into the agent's terminal for a submitted
 * round. Pure + exported for testing. */
export function formatLensFeedback(o: LensOutcome): string {
  const parts: string[] = [];
  // The element's match selector — how the agent locates it on screen and in
  // source (e.g. [text=Sign in]). Always include it so feedback is actionable.
  const sel = (m: { by: string; value: string }): string => `[${m.by}=${m.value}]`;

  const chosen = o.selections.filter((s) => s.chosenVariant);
  if (chosen.length) {
    parts.push(
      "Chosen variants — " +
        chosen
          .map((s) => {
            const v = s.chosenVariant!;
            const summary = v.summary ? ` (${v.summary})` : "";
            const where = v.filePath ? ` [src: ${v.filePath}]` : "";
            const note = s.comment ? ` (note: ${s.comment})` : "";
            return `"${s.element}" ${sel(s.match)} → "${v.name}"${summary}${where}${note}`;
          })
          .join("; ")
    );
  }

  const notedNoPick = o.selections.filter((s) => !s.chosenVariant && s.comment);
  if (notedNoPick.length) {
    parts.push(
      "Element notes — " +
        notedNoPick.map((s) => `"${s.element}" ${sel(s.match)}: ${s.comment}`).join("; ")
    );
  }

  // Elements that were proposed but neither picked nor commented — surfaced so
  // the agent knows they were reviewed and deliberately left as-is, rather than
  // re-proposing them blindly.
  const touched = new Set([...chosen, ...notedNoPick].map((s) => s.element));
  const leftAsIs = o.unselected.map((u) => u.element).filter((e) => !touched.has(e));
  if (leftAsIs.length) {
    parts.push("Left as-is (reviewed, no change) — " + leftAsIs.map((e) => `"${e}"`).join(", "));
  }

  if (o.annotations.length) {
    parts.push(
      "Comments on the screen — " +
        o.annotations.map((a) => `"${a.target}" ${sel(a.match)}: ${a.comment}`).join("; ")
    );
  }

  if (o.globalComment) parts.push("Overall direction — " + o.globalComment);

  const body = parts.length
    ? parts.join(". ")
    : "No specific picks were made; review the current variants in the preview window.";

  return flattenLine(
    `[Argent Lens] Feedback from the preview window (round ${o.round}). ${body}. ` +
      "Apply the chosen variants to their source files where given, then refine the design with " +
      "propose_variant (at least two variants per element; do not call await_user_selection)."
  );
}

function parseArgs(argv: string[]): {
  terminal: TerminalApp | undefined;
  agent: string | undefined;
  help: boolean;
} {
  let terminal: TerminalApp | undefined;
  let agent: string | undefined;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--help" || tok === "-h") help = true;
    else if (tok === "--terminal" || tok === "-t") {
      const v = argv[++i];
      if (v === "iterm" || v === "terminal") terminal = v;
      else {
        process.stderr.write(`lens: --terminal expects "iterm" or "terminal", got "${v ?? ""}"\n`);
        process.exit(2);
      }
    } else if (tok === "--agent" || tok === "-a") {
      agent = argv[++i];
      if (!agent) {
        process.stderr.write(`lens: --agent expects one of: ${agentIds().join(", ")}\n`);
        process.exit(2);
      }
    }
  }
  return { terminal, agent, help };
}

function printHelp(): void {
  process.stdout.write(
    `Usage: argent lens [--agent <id>] [--terminal iterm|terminal]\n\n` +
      `Open Argent Lens bound to a fresh coding-agent session.\n\n` +
      `  Opens the Lens preview window and runs a detached background bridge (this\n` +
      `  terminal stays free). Ensures a simulator is running, then spawns your agent\n` +
      `  in the current directory — you pick it in the window when more than one is\n` +
      `  installed, or pass --agent. When you request changes in the window they are\n` +
      `  typed into that agent session as its next prompt. The bridge ends when you\n` +
      `  close the agent terminal (or kill its pid).\n\n` +
      `Options:\n` +
      `  -a, --agent <id>       Agent to bind: ${agentIds().join(", ")}\n` +
      `  -t, --terminal <app>   Terminal to spawn (iterm preferred, else terminal)\n` +
      `  -h, --help             Show this help\n`
  );
}

export async function lens(argv: string[], options: LensCommandOptions): Promise<void> {
  // Internal re-entry: the detached background bridge runs the rest of the
  // session (agent pick, spawn, relay) so the foreground command can return.
  const bridgeIdx = argv.indexOf("--__bridge");
  if (bridgeIdx !== -1) return runBridge(argv[bridgeIdx + 1], options);

  const { terminal: preferred, agent: agentId, help } = parseArgs(argv);
  if (help) {
    printHelp();
    return;
  }

  if (process.platform !== "darwin") {
    process.stderr.write(
      "argent lens is macOS-only — it drives Terminal/iTerm via osascript to spawn and\n" +
        "feed the agent session. (The preview window itself works elsewhere via the MCP\n" +
        "propose_variant / await_user_selection flow.)\n"
    );
    process.exit(1);
  }

  if (!isFlagEnabled("argent-lens")) {
    process.stderr.write(
      "Argent Lens is behind a feature flag. Enable it first:\n\n  argent enable argent-lens\n\n"
    );
    process.exit(1);
  }

  // Resolve (spawning if needed) the shared tool-server. `/preview/*` is
  // token-exempt, so the handle's token isn't needed for the calls below.
  const client = createToolsClient({ paths: options.paths });
  let baseUrl: string;
  try {
    baseUrl = (await client.baseUrl()).url;
  } catch (err) {
    process.stderr.write(
      `lens: could not reach the tool-server: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  }

  const previewUrl = `${baseUrl}/preview/`;

  // Decide the agent: resolved now for --agent / a single install, otherwise the
  // window's picker chooses. Fails cleanly here with nothing open yet.
  const plan = planAgent(agentId);
  const choices = "choose" in plan ? plan.choose : [];

  // Begin the CLI session — opens the preview window and, when the user must
  // choose, hands it the agent list to render the picker.
  try {
    const res = await fetch(`${baseUrl}/preview/cli-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        active: true,
        agents: choices.map((a) => ({ id: a.id, name: a.displayName })),
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    process.stderr.write(`lens: failed to start the Lens session: ${errMsg(err)}\n`);
    process.exit(1);
  }

  // Hand the rest — device-ensure, the agent pick, spawn, trust dismissal, and
  // the feedback relay — to a DETACHED background bridge, so this terminal is
  // freed instead of being held by the watch loop.
  const term = resolveTerminal(preferred);
  const state: BridgeState = {
    baseUrl,
    cwd: process.cwd(),
    terminal: term,
    agentId: "agent" in plan ? plan.agent.id : null,
  };
  const stamp = `${process.pid}-${Date.now()}`;
  const stateFile = path.join(os.tmpdir(), `argent-lens-bridge-${stamp}.json`);
  const logFile = path.join(os.tmpdir(), `argent-lens-bridge-${stamp}.log`);
  fs.writeFileSync(stateFile, JSON.stringify(state), "utf8");

  const logFd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [process.argv[1], "lens", "--__bridge", stateFile], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: process.cwd(),
  });
  child.unref();
  fs.closeSync(logFd);

  const agentLine =
    "agent" in plan
      ? `    • Agent:           ${plan.agent.displayName}\n`
      : `    • Agent:           choose in the preview window\n`;
  process.stdout.write(
    `\n  Argent Lens is live — running in the background (this terminal is free).\n\n` +
      agentLine +
      `    • Preview window:  ${previewUrl}\n` +
      `    • Bridge:          pid ${child.pid ?? "?"}  ·  log ${logFile}\n\n` +
      ("choose" in plan ? "  Pick an agent in the preview window to start.\n" : "") +
      `  Ask the agent to redesign something; review the variants in the window and\n` +
      `  request changes — they're queued to the agent automatically.\n\n` +
      `  End it by closing the agent terminal${child.pid ? `, or: kill ${child.pid}` : ""}.\n\n`
  );
}

/** Persisted hand-off from the foreground command to the detached bridge. */
interface BridgeState {
  baseUrl: string;
  cwd: string;
  terminal: TerminalApp;
  /** The pre-chosen agent id, or null when the window's picker decides. */
  agentId: string | null;
}

/**
 * The detached background bridge. Ensures a device, resolves the agent (a given
 * one, or whichever the human clicks in the window's picker), spawns its
 * terminal, dismisses the trust prompt, and runs the feedback relay until the
 * terminal closes. Its stdout/stderr go to the log file the parent opened.
 */
async function runBridge(stateFile: string, options: LensCommandOptions): Promise<void> {
  let state: BridgeState;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as BridgeState;
  } catch (err) {
    process.stderr.write(`lens bridge: unreadable state: ${errMsg(err)}\n`);
    process.exit(1);
  }
  const { baseUrl, cwd, terminal, agentId } = state;

  let stopping = false;
  let seedFile = "";
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void endSession(baseUrl).finally(() => {
      for (const f of [stateFile, seedFile]) {
        if (!f) continue;
        try {
          fs.rmSync(f, { force: true });
        } catch {
          /* best-effort */
        }
      }
      process.exit(0);
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // Ensure a device is streaming before we spawn (best-effort).
  await ensureDevice(createToolsClient({ paths: options.paths }));

  // Resolve the agent: a pre-chosen one, or whichever the human clicks.
  let agent = agentId ? findAgentById(agentId) : undefined;
  if (!agent) {
    const id = await awaitAgentChoice(baseUrl, () => stopping);
    if (id) agent = findAgentById(id);
  }
  if (!agent) {
    stop(); // picker abandoned / server gone — tear the session down
    return;
  }

  seedFile = path.join(os.tmpdir(), `argent-lens-seed-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(seedFile, buildSeedPrompt(), "utf8");
  const launchCmd = agent.launch(shellQuote(cwd), shellQuote(seedFile));

  let session: TerminalSession;
  try {
    session = spawnTerminalSession(launchCmd, terminal);
  } catch (err) {
    process.stderr.write(`lens bridge: failed to spawn the agent: ${errMsg(err)}\n`);
    stop();
    return;
  }

  void dismissTrustPrompt(session);
  if (agent.injectSeed) void injectSeedAfterBoot(session);

  await watchAndRelay(baseUrl, session, () => stopping);
  stop(); // the watch loop returns only when the agent terminal closed
}

/**
 * Poll the window snapshot until the human picks an agent. Returns the picked id,
 * or null when stopping or the server has been unreachable for too long.
 */
async function awaitAgentChoice(
  baseUrl: string,
  isStopping: () => boolean
): Promise<string | null> {
  let failStreak = 0;
  while (!isStopping()) {
    await sleep(POLL_INTERVAL_MS);
    try {
      const res = await fetch(`${baseUrl}/preview/variants`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const snap = (await res.json()) as { lensAgentChoice?: string | null };
      failStreak = 0;
      if (snap.lensAgentChoice) return snap.lensAgentChoice;
    } catch {
      if (++failStreak >= 30) return null; // ~36s with no server → give up
    }
  }
  return null;
}

/** Poll the tool-server for submitted feedback and type each new round's
 * summary into the agent terminal. Returns when the terminal closes. Exported
 * for integration tests (the relay is the command's core data path). */
export async function watchAndRelay(
  baseUrl: string,
  session: TerminalSession,
  isStopping: () => boolean
): Promise<void> {
  const spawnedAt = Date.now();
  let lastCompletedAt = 0;
  let deathStreak = 0;
  let fetchFailStreak = 0;

  // Don't relay anything submitted before this watcher started (a stale outcome
  // from a previous session shouldn't fire on launch).
  try {
    const seed = await fetchOutcome(baseUrl);
    if (seed) lastCompletedAt = seed.completedAt;
  } catch {
    /* tolerate — first real poll will catch up */
  }

  while (!isStopping()) {
    await sleep(POLL_INTERVAL_MS);
    if (isStopping()) return;

    // Liveness: a closed agent terminal ends the bridge.
    if (Date.now() - spawnedAt > SPAWN_GRACE_MS) {
      if (!isSessionAlive(session)) {
        if (++deathStreak >= DEATH_CONFIRMATIONS) {
          process.stdout.write("\n  Agent terminal closed.\n");
          return;
        }
      } else {
        deathStreak = 0;
      }
    }

    let outcome: LensOutcome | null;
    try {
      outcome = await fetchOutcome(baseUrl);
      fetchFailStreak = 0;
    } catch {
      // Tolerate transient errors; give up only if the server is gone for a while.
      if (++fetchFailStreak >= 10) {
        process.stderr.write("\n  Lost contact with the tool-server — ending the bridge.\n");
        return;
      }
      continue;
    }

    if (outcome && outcome.completedAt > lastCompletedAt) {
      lastCompletedAt = outcome.completedAt;
      const prompt = formatLensFeedback(outcome);
      const ok = writeToSession(session, prompt);
      if (ok) {
        const n = outcome.selections.filter((s) => s.chosenVariant).length;
        process.stdout.write(`  → relayed feedback to the agent (${n} pick(s)).\n`);
      } else {
        process.stderr.write("  ! could not reach the agent terminal (it may have closed).\n");
      }
    }
  }
}

async function fetchOutcome(baseUrl: string): Promise<LensOutcome | null> {
  const res = await fetch(`${baseUrl}/preview/outcome`, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { outcome: LensOutcome | null };
  return body.outcome && body.outcome.status === "completed" ? body.outcome : null;
}

async function endSession(baseUrl: string): Promise<void> {
  try {
    await fetch(`${baseUrl}/preview/cli-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: false }),
    });
  } catch {
    /* best-effort cleanup */
  }
}
