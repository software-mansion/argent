/**
 * `argent lens` — open Argent Lens bound to a fresh `claude` session.
 *
 * The problem this solves: the Lens preview window and the agent talk through a
 * shared, process-wide tool-server that carries no per-agent identity, so when
 * the user requests changes in the window there is no way to know WHICH agent to
 * route them to. This command sidesteps that entirely by inverting ownership —
 * the human launches Lens, and Lens spawns (and therefore owns) exactly one
 * `claude` terminal. The binding is 1:1 by construction.
 *
 * Flow:
 *   1. Ensure a tool-server is up; mark it as a CLI Lens session so it opens the
 *      preview window now (no `await_user_selection` needed) and keeps it open
 *      across rounds.
 *   2. Spawn a tracked `claude` terminal in the current directory, seeded to use
 *      `propose_variant` without blocking.
 *   3. Watch the tool-server for submitted feedback and type a one-line summary
 *      into that terminal — queuing it to the agent as its next prompt.
 *
 * macOS only: the terminal spawn/track/write path drives `osascript` (see
 * `lens-terminal.ts`).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
  terminalAppName,
  type TerminalApp,
  type TerminalSession,
} from "./lens-terminal.js";

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

function parseArgs(argv: string[]): { terminal: TerminalApp | undefined; help: boolean } {
  let terminal: TerminalApp | undefined;
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
    }
  }
  return { terminal, help };
}

function printHelp(): void {
  process.stdout.write(
    `Usage: argent lens [--terminal iterm|terminal]\n\n` +
      `Open Argent Lens bound to a fresh claude session.\n\n` +
      `  Spawns a claude terminal in the current directory and opens the Lens\n` +
      `  preview window. When you request changes in the window, they are typed\n` +
      `  into that claude session — queued as its next prompt. Ctrl-C ends the\n` +
      `  bridge (the claude terminal keeps running).\n\n` +
      `Options:\n` +
      `  -t, --terminal <app>   Terminal to spawn (iterm preferred, else terminal)\n` +
      `  -h, --help             Show this help\n`
  );
}

export async function lens(argv: string[], options: LensCommandOptions): Promise<void> {
  const { terminal: preferred, help } = parseArgs(argv);
  if (help) {
    printHelp();
    return;
  }

  if (process.platform !== "darwin") {
    process.stderr.write(
      "argent lens is macOS-only — it drives Terminal/iTerm via osascript to spawn and\n" +
        "feed the claude session. (The preview window itself works elsewhere via the MCP\n" +
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

  // Begin the CLI session — the tool-server opens the preview window now and
  // keeps it open across rounds.
  try {
    const res = await fetch(`${baseUrl}/preview/cli-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: true }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    process.stderr.write(
      `lens: failed to start the Lens session: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  }

  // Spawn the tracked claude terminal in the current directory. The prompt is
  // staged in a temp file and read back with $(cat …) so a multi-line seed never
  // has to survive nested shell + AppleScript quoting (the applet's trick).
  const term = resolveTerminal(preferred);
  const seedFile = path.join(os.tmpdir(), `argent-lens-seed-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(seedFile, buildSeedPrompt(), "utf8");
  // `$(cat <file>)` stays double-quoted so the seed reaches claude as one
  // argument; the file path is single-quoted so it survives the shell. The
  // command-substitution itself must run unquoted-by-us, hence the literal "$(…)".
  const launchCmd = `cd ${shellQuote(process.cwd())} 2>/dev/null; claude "$(cat ${shellQuote(seedFile)})"`;

  let session: TerminalSession;
  try {
    session = spawnTerminalSession(launchCmd, term);
  } catch (err) {
    await endSession(baseUrl);
    process.stderr.write(
      `lens: failed to spawn the ${terminalAppName(term)} session: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  }

  // A fresh agent in an un-trusted directory opens on a "trust this folder?"
  // prompt that blocks it from reading the seed. Dismiss it hands-free in the
  // background (the user shouldn't have to babysit the spawned terminal).
  void dismissTrustPrompt(session);

  process.stdout.write(
    `\n  Argent Lens is live.\n\n` +
      `    • Preview window:  ${previewUrl}\n` +
      `    • Agent terminal:  ${terminalAppName(term)} (tty ${session.tty || "?"})\n\n` +
      `  Ask the agent to redesign something; review the variants in the window and\n` +
      `  request changes — they'll be queued to the agent automatically.\n\n` +
      `  Press Ctrl-C to end the bridge (the agent terminal keeps running).\n\n`
  );

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void endSession(baseUrl).finally(() => {
      try {
        fs.rmSync(seedFile, { force: true });
      } catch {
        /* best-effort */
      }
      process.stdout.write("\n  Lens session ended.\n");
      process.exit(0);
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await watchAndRelay(baseUrl, session, () => stopping);

  // The watch loop only returns when the agent terminal closed.
  stop();
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
