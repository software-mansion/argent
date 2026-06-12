import { REMOTE_KEYCODES, NAMED_KEYCODES, type RemoteButton } from "./vega-input";
import { getOrStartVegaAgent, invalidateVegaAgent } from "./vega-agent-manager";
import { VegaAgentTransportError } from "./vega-agent-client";

/** Outcome of a `getPageSource` fetch. An empty/closed toolkit is a typed
 * `ok:false` rather than a throw, so the describe adapter can hint a relaunch. */
export type VegaPageSourceResult =
  | { ok: true; xml: string }
  | { ok: false; reason: "toolkit-unavailable" };

// A served `getPageSource` is multi-KB; anything shorter than this is an empty
// root (app not attached) and is treated the same as a closed connection.
const PAGE_SOURCE_EMPTY_LENGTH = 50;

/**
 * Vega input/inspection transport — always the on-device HTTP agent.
 *
 * The agent holds an `inputd-cli` REPL open, so presses cost ~3-6ms (vs ~1.6s
 * for `vega device run-cmd`). It is deployed + started on first use by
 * `vega-agent-manager`. There is intentionally no adb/vega-cli fallback: if the
 * agent can't be brought up the call throws. A dropped connection (agent died)
 * is self-healed once by restarting the agent and retrying the command.
 *
 * Each tool maps its vocabulary (RemoteButton / named key) to KEY_ codes via the
 * shared maps in `vega-input`, so there is no shell-injection surface.
 */

export interface VegaDeviceTransport {
  readonly backend: "agent";
  /** Press a path of TV-remote buttons (one round-trip). Returns the count. */
  pressButtons(buttons: RemoteButton[]): Promise<number>;
  /** Press a single named key (enter/arrows/f1…/back). */
  pressNamedKey(name: string): Promise<void>;
  /** Type free text into the focused field. Returns the character count. */
  sendText(text: string): Promise<number>;
  /**
   * Fetch the current screen's accessibility XML (the agent proxies the on-device
   * automation toolkit). Returns a typed unavailable result — rather than
   * throwing — when the toolkit is off or returns an empty root, so the describe
   * adapter can hint the user to relaunch.
   */
  getPageSource(): Promise<VegaPageSourceResult>;
}

function namedKeyToCode(name: string): string {
  const key = NAMED_KEYCODES[name.toLowerCase()];
  if (!key) {
    throw new Error(
      `Unknown key "${name}" for Vega. Supported: ${Object.keys(NAMED_KEYCODES).join(", ")}`
    );
  }
  return key;
}

/**
 * Run a command against the agent, restarting it once if the connection is dead.
 * The agent lives in tmpfs and can be killed (reboot, OOM, manual) — a single
 * transparent restart keeps the tools working without a slower fallback path.
 *
 * Only *transport* faults (agent unreachable/unhealthy) trigger the restart.
 * A logical command error (bad op/args → HTTP 200 `{ok:false}`) is rethrown as
 * is: restarting wouldn't help and would needlessly pay a redeploy/restart.
 */
async function withAgent<T>(
  udid: string,
  fn: (cmd: VegaAgentCmd) => Promise<T>
): Promise<T> {
  const handle = await getOrStartVegaAgent(udid);
  try {
    return await fn(handle.client.cmd.bind(handle.client));
  } catch (err) {
    if (!(err instanceof VegaAgentTransportError)) throw err;
    invalidateVegaAgent(udid);
    const fresh = await getOrStartVegaAgent(udid);
    return fn(fresh.client.cmd.bind(fresh.client));
  }
}

type VegaAgentCmd = <T = unknown>(
  op: string,
  args?: Record<string, unknown>,
  timeoutMs?: number
) => Promise<T>;

/** Resolve the agent-backed transport, deploying/starting the agent if needed. */
export async function resolveVegaTransport(udid: string): Promise<VegaDeviceTransport> {
  // Surface a start failure here rather than on the first command.
  await getOrStartVegaAgent(udid);

  return {
    backend: "agent",
    async pressButtons(buttons) {
      const keys = buttons.map((b) => REMOTE_KEYCODES[b]);
      await withAgent(udid, (cmd) => cmd("button", { keys }));
      return buttons.length;
    },
    async pressNamedKey(name) {
      const key = namedKeyToCode(name);
      await withAgent(udid, (cmd) => cmd("button", { keys: [key] }));
    },
    async sendText(text) {
      await withAgent(udid, (cmd) => cmd("text", { text }));
      return [...text].length;
    },
    async getPageSource() {
      const result = await withAgent(udid, (cmd) => cmd<{ xml?: string }>("getPageSource"));
      const xml = result?.xml ?? "";
      if (xml.length < PAGE_SOURCE_EMPTY_LENGTH) {
        return { ok: false, reason: "toolkit-unavailable" };
      }
      return { ok: true, xml };
    },
  };
}
