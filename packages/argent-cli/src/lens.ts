/**
 * `argent lens` — open Argent Lens bound to a fresh coding-agent session.
 *
 * The problem this solves: the Lens preview window and the agent talk through a
 * shared, process-wide tool-server that carries no per-agent identity, so when
 * the user requests changes in the window there is no way to know WHICH agent to
 * route them to. This command sidesteps that by inverting ownership — the human
 * launches Lens, and Lens spawns (and therefore owns) exactly one agent. The
 * binding is 1:1 by construction.
 *
 * Flow — there is NO detached bridge. The foreground process does everything and
 * lingers as a thin owner of the agent until it exits:
 *   1. Ensure a tool-server is up; decide the agent (resolved now for `--agent`
 *      or a single install, otherwise the window's picker chooses).
 *   2. Mark a CLI Lens session so the tool-server opens the preview window now
 *      (no `await_user_selection` needed). No device is force-booted — the window
 *      streams a running device or offers an in-window picker (which can boot one
 *      headless; see the tool-server's /preview/boot).
 *   3. TAKE OVER this terminal by running the agent inside a PTY this process
 *      proxies (see `lens-pty.ts`): stdin → PTY, PTY → stdout, resize → PTY. The
 *      agent's TUI appears right here in ANY terminal — Warp, VS Code, tmux,
 *      iTerm, Terminal — because we never depend on the host app being
 *      scriptable. Fallback (no interactive tty, or native `node-pty` missing):
 *      spawn a new iTerm/Terminal window via `osascript` (`lens-terminal.ts`).
 *   4. Relay feedback by PUSH: subscribe to the tool-server's SSE stream and, on
 *      each submitted round, inject a one-line summary into the agent over the
 *      same channel as the user's keystrokes (PTY write), or AppleScript
 *      `write text` in the fallback. Liveness is the agent's exit (the PTY child,
 *      or a `ps` poll for the fallback window).
 *
 * macOS only: the new-window fallback drives `osascript`, and the PTY proxy uses
 * `node-pty` (an optional native dependency that degrades to the fallback).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createToolsClient, type ToolsServerPaths } from "@argent/tools-client";
import {
  isFlagEnabled,
  getRememberedAgent,
  setRememberedAgent,
  clearRememberedAgent,
} from "@argent/configuration-core";
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
import { loadNodePty, startPtyProxy, type PtyProxy } from "./lens-pty.js";
import { lensEvents } from "./lens-stream.js";
import {
  AGENTS,
  detectInstalledAgents,
  findAgentById,
  isAgentInstalled,
  agentIds,
  type AgentSpec,
} from "./lens-agents.js";

export interface LensCommandOptions {
  paths: ToolsServerPaths;
}

/** Shape of the completed-round outcome the SSE stream / `GET /preview/outcome`
 * carry. */
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

// New-window fallback liveness poll cadence (used ONLY there — the PTY path
// observes the agent child's exit directly, with no poll).
const LIVENESS_POLL_MS = 1_200;
// A just-spawned session may not show in `ps` for a beat; don't call it dead
// inside this window.
const SPAWN_GRACE_MS = 8_000;
// Require this many consecutive "tty gone" reads (after the grace window) before
// concluding the terminal closed — guards against a transient `ps` miss.
const DEATH_CONFIRMATIONS = 3;
// After an SSE drop while the agent is still alive, wait this long before
// reconnecting (the tool-server may be briefly restarting).
const SSE_RECONNECT_MS = 1_000;

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

/**
 * PTY equivalent of `dismissTrustPrompt`: watch the agent's OUTPUT stream for a
 * first-run "trust this folder?" prompt and send a lone Enter (its default is
 * trust-and-continue) so the seeded session starts unattended. Unlike the
 * AppleScript path, we always have the real output here, so we only ever press
 * Enter on a clear match — never a blind one. Bounded so it can't linger or fire
 * on the agent's own later output.
 */
function dismissTrustPromptViaPty(proxy: PtyProxy): void {
  let acc = "";
  let done = false;
  const deadline = Date.now() + 12_000;
  proxy.onData((chunk) => {
    if (done) return;
    if (Date.now() > deadline) {
      done = true;
      return;
    }
    acc += chunk;
    if (TRUST_PROMPT_RE.test(acc)) {
      done = true;
      proxy.write("\r");
    }
  });
}

/** Seed an inject-mode agent running under the PTY proxy: type the CLI-Lens
 * prompt once its TUI has settled after boot (mirrors `injectSeedAfterBoot`). */
async function injectSeedViaPty(proxy: PtyProxy): Promise<void> {
  await sleep(5_000);
  proxy.inject(buildSeedPrompt());
}

/** Whether we're attached to a real interactive terminal on both ends — the
 * precondition for the PTY proxy. Piped/CI/non-tty invocations fall back to a
 * new window. */
function isInteractiveTty(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Decide how the agent gets chosen. With `--agent`, validate it's known and
 * installed and resolve it now. Otherwise auto-resolve the only installed agent,
 * or defer to the window's picker when several are present (returning the
 * choices). Exits (nothing is open yet) when there's no usable agent.
 */
export function planAgent(
  agentId: string | undefined
): { agent: AgentSpec } | { choose: AgentSpec[] } {
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
  // A remembered pick (the picker's "Remember this choice") skips the window
  // picker on later runs — but only if that agent is still installed. Clear
  // `argent lens --forget` to choose again.
  const remembered = getRememberedAgent();
  if (remembered) {
    const found = installed.find((a) => a.id === remembered);
    if (found) return { agent: found };
  }
  if (installed.length === 1) return { agent: installed[0] };
  return { choose: installed };
}

/** Seed an inject-mode agent (its TUI takes no initial-prompt arg) by typing the
 * CLI-Lens prompt in once the terminal has settled after boot. */
async function injectSeedAfterBoot(session: TerminalSession): Promise<void> {
  await sleep(5_000);
  writeToSession(session, buildSeedPrompt());
}

/** The instruction the spawned agent starts with, establishing CLI-Lens
 * behaviour. Kept short and explicit. */
export function buildSeedPrompt(): string {
  return [
    "You are running inside an Argent Lens CLI session. The user has the Argent Lens",
    "preview window open and bound to THIS terminal.",
    "",
    "Match your response to the request. If it has a single obvious outcome — moving or",
    "renaming something, tweaking one value, or anything with no meaningful design",
    "alternatives — just make the change directly and report what you did; do not",
    'manufacture variants. Only when the request is genuinely open-ended ("restyle",',
    '"redesign", "make it nicer", or anything with a real design space) should you stage',
    "variants with the `propose_variant` Argent tool — at least two per element so the",
    "user has a real choice.",
    "",
    "Either way, end your turn when you're done — you never block waiting for a pick in",
    "this session (feedback comes back to you as a message).",
    "",
    "The user reviews any staged variants in the Lens window; their feedback arrives here",
    'as a normal message prefixed "[Argent Lens]" (the variants they chose, comments, and',
    "change requests). Act on it the same way — direct edits for concrete fixes, fresh",
    "variants only where the design is still open.",
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

  // Steer the next turn by what the feedback actually asks for, rather than
  // demanding a fresh batch of variants every round. A pick with no attached
  // direction is an approval — apply it and stop; only open-ended direction
  // (a comment on a pick, an element note, or an on-screen annotation)
  // warrants staging new variants.
  const chosenWithComment = chosen.filter((s) => s.comment);
  const hasDirection =
    chosenWithComment.length > 0 ||
    notedNoPick.length > 0 ||
    o.annotations.length > 0 ||
    Boolean(o.globalComment);

  const applyChosen = chosen.length
    ? "Apply the chosen variants to their source files where given. "
    : "";

  const closing = hasDirection
    ? "Handle each request with the smallest change that satisfies it: for a single " +
      "obvious outcome (a move, rename, or one-value tweak) just make the edit and report " +
      "it; stage fresh propose_variant options (at least two per element) only where the " +
      "direction is genuinely open-ended. Then end your turn."
    : "Nothing further is requested — make no other changes unless the user asks, and end " +
      "your turn.";

  return flattenLine(
    `[Argent Lens] Feedback from the preview window (round ${o.round}). ${body}. ` +
      applyChosen +
      closing
  );
}

function parseArgs(argv: string[]): {
  terminal: TerminalApp | undefined;
  agent: string | undefined;
  help: boolean;
  forget: boolean;
} {
  let terminal: TerminalApp | undefined;
  let agent: string | undefined;
  let help = false;
  let forget = false;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--help" || tok === "-h") help = true;
    else if (tok === "--forget") forget = true;
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
  return { terminal, agent, help, forget };
}

function printHelp(): void {
  process.stdout.write(
    `Usage: argent lens [--agent <id>] [--terminal iterm|terminal]\n\n` +
      `Open Argent Lens bound to a fresh coding-agent session.\n\n` +
      `  Opens the Lens preview window and runs your agent IN THIS terminal (it takes\n` +
      `  over the current window). When you request changes in the preview window they\n` +
      `  are typed into that agent session as its next prompt. Pick the agent in the\n` +
      `  window when more than one is installed, or pass --agent. The window streams a\n` +
      `  running simulator, or offers an in-window picker to boot one. Lens ends when\n` +
      `  you close the agent.\n\n` +
      `  If this terminal isn't iTerm or Terminal.app (e.g. tmux / VS Code), the agent\n` +
      `  opens in a new window instead.\n\n` +
      `Options:\n` +
      `  -a, --agent <id>       Agent to bind: ${agentIds().join(", ")}\n` +
      `  -t, --terminal <app>   Terminal for the new-window fallback (iterm preferred)\n` +
      `      --forget           Forget the remembered agent, then exit\n` +
      `  -h, --help             Show this help\n`
  );
}

export async function lens(argv: string[], options: LensCommandOptions): Promise<void> {
  const { terminal: preferred, agent: agentId, help, forget } = parseArgs(argv);
  if (help) {
    printHelp();
    return;
  }

  if (forget) {
    const had = getRememberedAgent();
    clearRememberedAgent();
    process.stdout.write(
      had
        ? `  Forgot the remembered agent ("${had}"). The picker will show again next run.\n`
        : "  No agent was remembered.\n"
    );
    return;
  }

  if (process.platform !== "darwin") {
    process.stderr.write(
      "argent lens is macOS-only — it drives Terminal/iTerm via osascript to run and\n" +
        "feed the agent session.\n"
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
    process.stderr.write(`lens: could not reach the tool-server: ${errMsg(err)}\n`);
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

  // Resolve the agent: a pre-chosen one, or whichever the human clicks in the
  // window's picker (delivered over the SSE stream — no polling).
  let agent = "agent" in plan ? plan.agent : undefined;
  if (!agent) {
    process.stdout.write(
      `\n  Argent Lens window is open: ${previewUrl}\n  Pick an agent in the window to start…\n`
    );
    const picked = await awaitAgentChoiceViaStream(baseUrl);
    if (picked) {
      agent = findAgentById(picked.id);
      // Persist the pick only once it resolved to a real agent, so a bad id
      // can't poison the remembered value.
      if (agent && picked.remember) setRememberedAgent(agent.id);
    }
  }
  if (!agent) {
    process.stderr.write("lens: no agent was chosen — closing the Lens session.\n");
    await endSession(baseUrl);
    process.exit(1);
  }

  // Seed prompt for the agent (arg-mode CLIs read it on boot; inject-mode CLIs
  // get it typed in after the TUI is up).
  const seedFile = path.join(os.tmpdir(), `argent-lens-seed-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(seedFile, buildSeedPrompt(), "utf8");
  const launchCmd = agent.launch(shellQuote(process.cwd()), shellQuote(seedFile));

  // Spawn the agent. Preferred path: a PTY this process proxies, which takes
  // over THIS terminal in ANY app (Warp / VS Code / tmux / iTerm / Terminal) and
  // lets the relay inject feedback over the same channel as the user's keys.
  // Fallback (no interactive tty, or node-pty unavailable): a new iTerm/Terminal
  // window driven by AppleScript. `quiet` suppresses our own stdout once the
  // agent owns this terminal, so we don't corrupt its TUI.
  const ptyMod = isInteractiveTty() ? loadNodePty() : null;

  // The relay's two terminal-specific seams: how feedback is injected, and how
  // the agent's death is observed. Filled in per spawn path below.
  let inject: (text: string) => boolean;
  let registerDeath: (onDeath: () => void) => void;
  let quiet = false;
  // Bring the agent down with us on a signal, restoring the terminal first.
  let killAgent: () => void = () => {};

  if (ptyMod) {
    let proxy: PtyProxy;
    try {
      proxy = startPtyProxy({ pty: ptyMod, command: launchCmd, cwd: process.cwd() });
    } catch (err) {
      process.stderr.write(`lens: failed to start the agent PTY: ${errMsg(err)}\n`);
      await endSession(baseUrl);
      process.exit(1);
    }
    quiet = true; // the agent owns this terminal now
    dismissTrustPromptViaPty(proxy);
    if (agent.injectSeed) void injectSeedViaPty(proxy);
    inject = (text) => proxy.inject(text);
    registerDeath = (onDeath) => proxy.onExit(() => onDeath());
    killAgent = () => proxy.dispose();
  } else {
    const term = resolveTerminal(preferred);
    let session: TerminalSession;
    try {
      session = spawnTerminalSession(launchCmd, term);
    } catch (err) {
      process.stderr.write(`lens: failed to spawn the agent: ${errMsg(err)}\n`);
      await endSession(baseUrl);
      process.exit(1);
    }
    process.stdout.write(
      `\n  Argent Lens is live.\n\n` +
        `    • Agent:           ${agent.displayName} (new window)\n` +
        `    • Preview window:  ${previewUrl}\n\n` +
        `  Ask the agent to redesign something; review the variants in the window and\n` +
        `  request changes — they're queued to the agent automatically. End it by\n` +
        `  closing the agent terminal.\n\n`
    );
    void dismissTrustPrompt(session);
    if (agent.injectSeed) void injectSeedAfterBoot(session);
    inject = (text) => writeToSession(session, text);
    registerDeath = (onDeath) => pollSessionDeath(session, onDeath);
  }

  // Teardown is idempotent and reachable from three places: the agent exiting,
  // a fatal relay condition, or a signal. It ends the server-side session (which
  // closes the window and shuts down any Lens-booted simulator) and exits.
  let tearingDown = false;
  const teardown = (code: number): void => {
    if (tearingDown) return;
    tearingDown = true;
    void endSession(baseUrl).finally(() => {
      try {
        fs.rmSync(seedFile, { force: true });
      } catch {
        /* best-effort */
      }
      process.exit(code);
    });
  };
  // A signal should bring the agent down with us. `killAgent` synchronously
  // restores the terminal (PTY path) before we exit; the new-window path is a
  // no-op here and tears down directly.
  const onSignal = (): void => {
    killAgent();
    teardown(0);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  await runRelaySession(baseUrl, inject, registerDeath, quiet);
  teardown(0);
}

/**
 * Wait for the human to pick an agent in the window, delivered over the SSE
 * stream. Returns the picked id, or null if the stream ends / errors before a
 * pick (e.g. the window was closed, or the server went away).
 */
async function awaitAgentChoiceViaStream(
  baseUrl: string
): Promise<{ id: string; remember: boolean } | null> {
  const ac = new AbortController();
  try {
    for await (const ev of lensEvents(baseUrl, ac.signal)) {
      if (ev.event === "session-end") return null;
      if (ev.event === "agent-choice") {
        try {
          const payload = JSON.parse(ev.data) as { id?: unknown; remember?: unknown };
          if (payload && typeof payload.id === "string" && payload.id) {
            return { id: payload.id, remember: Boolean(payload.remember) };
          }
        } catch {
          /* malformed frame — keep waiting */
        }
      }
    }
  } catch {
    /* stream error → give up (caller closes the session) */
  } finally {
    ac.abort();
  }
  return null;
}

/**
 * Watch a new-window fallback session for the agent's death by polling `ps` for
 * its tty, calling `onDeath` once it's confirmed gone. Used only when the agent
 * runs in a separate window (the PTY path observes the child's exit directly).
 */
function pollSessionDeath(session: TerminalSession, onDeath: () => void): void {
  const spawnedAt = Date.now();
  let deathStreak = 0;
  const timer = setInterval(() => {
    if (Date.now() - spawnedAt <= SPAWN_GRACE_MS) return;
    if (!isSessionAlive(session)) {
      if (++deathStreak >= DEATH_CONFIRMATIONS) {
        clearInterval(timer);
        onDeath();
      }
    } else {
      deathStreak = 0;
    }
  }, LIVENESS_POLL_MS);
  timer.unref?.();
}

/**
 * Relay submitted feedback into the agent by PUSH: subscribe to the SSE stream
 * and inject each new round's summary. `inject` and `registerDeath` are the
 * terminal-specific seams the caller fills (PTY write + child exit, or
 * AppleScript write + `ps` poll). Returns once the agent dies. Reconnects the
 * stream if it drops while the agent is still alive.
 */
export async function runRelaySession(
  baseUrl: string,
  inject: (text: string) => boolean,
  registerDeath: (onDeath: () => void) => void,
  quiet: boolean
): Promise<void> {
  const log = (s: string): void => {
    if (!quiet) process.stdout.write(s);
  };
  const ac = new AbortController();
  let alive = true;
  const stop = (): void => {
    if (!alive) return;
    alive = false;
    ac.abort();
  };

  registerDeath(() => {
    log("\n  Agent exited.\n");
    stop();
  });

  // Don't relay anything submitted before now (a stale outcome from a previous
  // session must not fire on launch).
  let lastCompletedAt = 0;
  try {
    const seed = await fetchOutcomeOnce(baseUrl);
    if (seed) lastCompletedAt = seed.completedAt;
  } catch {
    /* tolerate — the first pushed outcome past `now` will still relay */
  }

  while (alive && !ac.signal.aborted) {
    try {
      for await (const ev of lensEvents(baseUrl, ac.signal)) {
        if (!alive) break;
        if (ev.event === "session-end") return;
        if (ev.event !== "outcome") continue;
        let outcome: LensOutcome | null = null;
        try {
          outcome = JSON.parse(ev.data) as LensOutcome;
        } catch {
          continue;
        }
        if (outcome && outcome.status === "completed" && outcome.completedAt > lastCompletedAt) {
          lastCompletedAt = outcome.completedAt;
          const ok = inject(formatLensFeedback(outcome));
          if (ok) {
            const n = outcome.selections.filter((s) => s.chosenVariant).length;
            log(`  → relayed feedback to the agent (${n} pick(s)).\n`);
          } else {
            log("  ! could not reach the agent (it may have exited).\n");
          }
        }
      }
      // Stream ended cleanly (server closed it). If the agent is still alive,
      // reconnect after a short pause.
    } catch {
      // Transient stream/network error — reconnect while the agent lives.
    }
    if (alive && !ac.signal.aborted) await sleep(SSE_RECONNECT_MS);
  }
}

async function fetchOutcomeOnce(baseUrl: string): Promise<LensOutcome | null> {
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
