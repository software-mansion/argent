import type { DeviceInfo } from "@argent/registry";
import { getDescribeTapPoint, type DescribeNode } from "../describe/contract";
import { frameContains, includesCI, isVisible, nodeText } from "../../utils/ui-tree-match";
import { adbShell, shellQuote } from "../../utils/adb";
import { sleepOrAbort } from "../../utils/timing";
import { fetchFlowTree } from "./flow-tree";
import { invokeOnDevice, type ActionEnv } from "./flow-actions";

/**
 * The expo-dev-client launcher — the "DEVELOPMENT SERVERS" chooser a dev build
 * shows instead of the app — and how a `launch` step gets past it unattended.
 *
 * A dev client renders the chooser whenever it cold-starts with no bundle URL
 * and cannot silently reconnect to the server it opened last. A flow's `launch`
 * step cold-starts by construction (it terminates and relaunches, so a copy
 * left running by a prior run can't leak state in), so the only thing standing
 * between a run and the chooser is whether that remembered URL still resolves.
 *
 * That is why the chooser looks intermittent, and why it is worse on Android:
 * an iOS simulator reaches Metro at a stable `localhost:<port>`, while an
 * Android build's remembered URL rotates between the emulator's host-loopback
 * alias (`10.0.2.2`), `localhost` (only reachable through `adb reverse`) and
 * whatever LAN address the machine had when the build was last opened — each of
 * which goes stale independently of the app.
 *
 * Left alone the run does not fail cleanly: every selector resolves against the
 * chooser instead of the app, so the first directive fails on a screen that
 * looks nothing like the flow. Recovering costs an agent several turns of
 * describing and tapping, which is exactly the time this module exists to save.
 *
 * The recovery is a tap on the row for the Metro server the RUN is targeting —
 * `metroPort`, which the caller passes because only it knows which bundler it
 * started. Nothing here guesses: with no matching row the launch reports what
 * it saw and which URL it wanted, rather than opening an arbitrary server and
 * running the flow against the wrong bundle.
 */

/** Metro's default port — the same default every other argent tool takes. */
export const DEFAULT_METRO_PORT = 8081;

/**
 * The chooser is recognized by its section heading plus ONE of the launcher's
 * own marks. The heading alone is ordinary enough wording for an app's own
 * settings screen to carry; pairing it keeps a real app screen from being
 * mistaken for the chooser and tapped at.
 *
 * The marks are alternatives because the chooser has two faces. With a packager
 * discovered it lists the rows under a "new server" affordance; with none
 * discovered it replaces that whole list with an instruction card offering to
 * fetch — so requiring the "new server" wording recognized only the face that
 * already has what the run needs, and left the other one unhandled: the launch
 * passed, and every later step read the chooser. That second face is the common
 * one (it is what the client shows whenever it has not found a running
 * packager), and it is exactly where the "no reachable server on port N"
 * message has to come from. The build's own header subtitle is listed too: it is
 * on both faces, so it still identifies the launcher if either affordance is
 * reworded.
 */
const SECTION_HEADING = "DEVELOPMENT SERVERS";
const LAUNCHER_MARKS = ["Development Build", "New development server", "Fetch development servers"];

/**
 * The chooser's second section. Its rows are a HISTORY — entries survive the
 * server that wrote them, so a stale one can carry the run's port on a host
 * that stopped answering. Rows above it are the servers the client currently
 * sees, so the heading's position is the boundary a candidate must sit above.
 */
const HISTORY_HEADING = "RECENTLY OPENED";

/**
 * How long the chooser has to leave the screen after the tap. Generous because
 * what follows the tap is a cold Metro bundle, not a screen transition: the
 * chooser stays up while the bundler builds, and the wait is what keeps the
 * next step from resolving selectors against it.
 */
const EXIT_TIMEOUT_MS = 60_000;
const EXIT_POLL_MS = 500;

/**
 * Hosts that reach the tool-server's Metro FROM the device, best first.
 *
 * An Android emulator reaches its host machine at the `10.0.2.2` alias;
 * `localhost` means the emulator itself and only reaches Metro when an
 * `adb reverse` tunnel is up, so it ranks second. A physical Android device has
 * no alias and depends on that tunnel entirely, which puts `localhost` first.
 * The last branch is a fallback the gate never reaches — {@link isExpoDevBuild}
 * answers false off Android — kept so the helper stays total; loopback is what it
 * would mean on an iOS simulator, which shares the host's network stack.
 *
 * A LAN address is deliberately absent: it is the spelling most likely to be
 * stale (it changes with the network the machine is on, not with the app), and
 * preferring a reachable-by-construction host over one we would have to probe
 * keeps this a single tree read.
 */
function candidateHosts(device: DeviceInfo): string[] {
  if (device.platform === "android") {
    return device.kind === "emulator"
      ? ["10.0.2.2", "localhost", "127.0.0.1"]
      : ["localhost", "127.0.0.1", "10.0.2.2"];
  }
  return ["localhost", "127.0.0.1"];
}

function flatten(root: DescribeNode): DescribeNode[] {
  const all: DescribeNode[] = [];
  const collect = (node: DescribeNode): void => {
    all.push(node);
    for (const child of node.children) collect(child);
  };
  for (const child of root.children) collect(child);
  return all;
}

function area(node: DescribeNode): number {
  return node.frame.width * node.frame.height;
}

/**
 * The tightest node whose OWN text carries `needle`.
 *
 * Own text, not `subtreeText`: the flow adapters hoist descendant text onto
 * every ancestor, so the chooser's scroll container repeats each heading and
 * every row URL. Reading hoisted text here would place a heading at the
 * container's y — above the rows it is supposed to sit below — and collapse the
 * live/history split this module depends on. The smallest match is then the
 * heading itself rather than a wrapper that merely contains it.
 */
function tightestOwning(nodes: DescribeNode[], needle: string): DescribeNode | undefined {
  return nodes
    .filter((n) => includesCI(nodeText(n), needle))
    .reduce<
      DescribeNode | undefined
    >((best, n) => (best === undefined || area(n) < area(best) ? n : best), undefined);
}

/**
 * Is the expo-dev-client chooser the visible screen? Returns the y coordinate
 * of the history heading (or the bottom of the screen when the client has no
 * history yet) so the caller can tell a live server row from a remembered one,
 * and null when this is not the chooser.
 */
export function detectDevLauncher(root: DescribeNode): { historyY: number } | null {
  const nodes = flatten(root).filter(isVisible);
  if (!tightestOwning(nodes, SECTION_HEADING)) return null;
  if (!LAUNCHER_MARKS.some((mark) => tightestOwning(nodes, mark))) return null;
  return { historyY: tightestOwning(nodes, HISTORY_HEADING)?.frame.y ?? 1 };
}

/**
 * Candidate rows: what is on screen ABOVE the history boundary, minus the
 * chooser's address box and the text inside it.
 *
 * The address box is a text INPUT the launcher prefills with a URL
 * (`http://localhost:8081` on a client that has discovered nothing), paired with
 * a `Connect` button. It is not an offer — it holds an address the client merely
 * SUGGESTS, live or not — and a tap on it opens a keyboard rather than an app,
 * after which the exit wait would spend its whole budget and then blame a
 * bundler the run never opened. The no-servers face of the chooser is made
 * mostly of that box, so recognizing that face (see {@link LAUNCHER_MARKS})
 * means excluding it.
 *
 * By TAP POINT, not by the node's own role: the adapters give the input an empty
 * label and render its URL as a text leaf inside it, so the node that matches an
 * origin is the leaf, not the box. Excluding anything whose centre falls in a
 * box states the rule that actually matters — we would be pressing the address
 * box — and reads geometrically, the way every other flow container scope does
 * (see `Selector.within`), which is all a flattened tree preserves.
 */
function candidateRows(nodes: DescribeNode[], historyY: number): DescribeNode[] {
  const boxes = nodes.filter((n) => isVisible(n) && includesCI(n.role, "TextField"));
  return nodes.filter((n) => {
    if (!isVisible(n) || n.frame.y >= historyY) return false;
    const point = getDescribeTapPoint(n.frame);
    return !boxes.some((box) => frameContains(box.frame, point.x, point.y));
  });
}

/**
 * The row that opens Metro on `port`, or null when the chooser lists no server
 * this run can use.
 *
 * Only rows ABOVE the history heading are eligible — see {@link HISTORY_HEADING}
 * for why a remembered row carrying the same port is not the same offer. Among
 * those, hosts are tried in reachability order, and the match is on the whole
 * `http://<host>:<port>` origin: matching the port alone would happily open a
 * dead LAN address that shares it.
 */
export function pickDevServerRow(
  root: DescribeNode,
  device: DeviceInfo,
  port: number,
  historyY: number
): { node: DescribeNode; url: string } | null {
  const live = candidateRows(flatten(root), historyY);
  for (const host of candidateHosts(device)) {
    const url = `http://${host}:${port}`;
    // A trailing-digit guard, so port 808 cannot open the row for 8081. Plain
    // substring matching is otherwise right: the row label wraps the URL in
    // decorations (a chevron, the project name) that vary by client version.
    const origin = new RegExp(`${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![0-9])`, "i");
    // OWN text only — the rule {@link tightestOwning} follows, and for a sharper
    // reason here. The hoist repeats EVERY row's URL, the history's included, on
    // the scroll container that wraps the whole list, and that container's top
    // edge sits above the history boundary. Reading hoisted text would therefore
    // match the container for a port only a remembered row carries, and the
    // launch would tap the middle of the list — an arbitrary point — instead of
    // reporting that no live row exists. Nothing is lost by ignoring the hoist:
    // it is additive, so the leaf that renders the URL still carries it itself.
    // Tightest match still wins, since a row card whose own label spells the URL
    // also wraps the leaf that renders it.
    const row = live
      .filter((n) => origin.test(nodeText(n)))
      .reduce<
        DescribeNode | undefined
      >((best, n) => (best === undefined || area(n) < area(best) ? n : best), undefined);
    if (row) return { node: row, url };
  }
  return null;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** What {@link dismissDevLauncher} did, for the launch step's report. */
type DevLauncherOutcome =
  | { handled: false }
  | { handled: true; ok: true; url: string }
  | { handled: true; ok: false; reason: string };

/**
 * Is this app an expo dev build — one that can show the chooser at all?
 *
 * The gate that keeps every OTHER app from paying for this. The chooser draws
 * seconds after the launch step's read (see {@link APPEAR_TIMEOUT_MS}), so
 * catching it means waiting; making an ordinary app wait out that window on
 * every launch would be a tax it can never benefit from.
 *
 * A dev build is identified by the launcher itself: `expo-dev-launcher` declares
 * its activities in a DEBUG-variant manifest, so the installed package mentions
 * them only when the build can actually show a chooser. On Android that is one
 * `dumpsys package` read.
 *
 * Deliberately NOT the `exp+<slug>` scheme the chooser's own rows open: the
 * `expo-dev-client` config plugin writes that into the MAIN manifest, which
 * merges into every variant, so a release build of any project that has
 * `expo-dev-client` in its dependencies carries it too — and would pay the
 * appear-wait on every launch step for a chooser it can never show.
 *
 * iOS would need the installed bundle's Info.plist and is not probed: there the
 * remembered server is a stable `localhost`, which is why the chooser is a rarity
 * there and an Android routine (see the module comment). An unprobeable app
 * answers false — the launch then behaves exactly as it did before this module
 * existed.
 */
async function isExpoDevBuild(device: DeviceInfo, bundleId: string): Promise<boolean> {
  if (device.platform !== "android") return false;
  try {
    const dump = await adbShell(device.id, `dumpsys package ${shellQuote(bundleId)}`, {
      timeoutMs: 10_000,
    });
    // Either spelling the debug manifest contributes: a launcher activity's own
    // class name, and the scheme its auth activity registers.
    return /expo\.modules\.devlauncher|Scheme:\s*"expo-dev-launcher"/i.test(dump);
  } catch {
    return false;
  }
}

/**
 * Does this tree show a screen that has drawn its own content yet?
 *
 * The launch step reads within ~2s of the relaunch, and a dev client on a cold
 * start needs several seconds more to draw the chooser — so a single read
 * almost always lands on the splash and concludes, wrongly, that there is no
 * chooser. What separates "the app is up, nothing to do here" from "still
 * starting, the chooser may yet appear" is text: a splash is a logo on a blank
 * ground, and both the chooser and a real first screen are full of words.
 *
 * Gating the wait on this keeps the cost off an app that has already rendered:
 * it pays one read, and only a screen that has drawn nothing waits — the one
 * state the chooser can still emerge from.
 */
export function hasDrawnContent(root: DescribeNode): boolean {
  return (
    flatten(root)
      .filter(isVisible)
      .filter((n) => nodeText(n).trim() !== "").length >= 2
  );
}

/**
 * How long a blank, still-starting screen is given to become something. Only a
 * launch that has drawn nothing at all waits, and it stops the moment the
 * screen draws — so this bounds the pathological case (an app whose first
 * screen is genuinely wordless) rather than describing the normal one.
 */
const APPEAR_TIMEOUT_MS = 12_000;
const APPEAR_POLL_MS = 500;

/**
 * Wait for the screen to show either the dev-client chooser or the app, and
 * if it is the chooser, open the run's Metro server and wait for it to go away.
 *
 * A tree read that throws is reported as "not the chooser": the launch's own
 * tree-source gate has already vouched for the source, so a failure here is
 * transient, and treating it as a chooser we could not dismiss would fail
 * launches that had nothing to do with one.
 */
export async function dismissDevLauncher(
  env: ActionEnv,
  bundleId: string,
  port: number
): Promise<DevLauncherOutcome> {
  const { registry, device, signal } = env;
  if (!(await isExpoDevBuild(device, bundleId))) return { handled: false };

  const readTree = async (): Promise<DescribeNode | null> => {
    try {
      return (await fetchFlowTree(registry, device)).tree;
    } catch {
      return null;
    }
  };

  let root: DescribeNode | null;
  let launcher: { historyY: number } | null;
  const appearBy = Date.now() + APPEAR_TIMEOUT_MS;
  for (;;) {
    root = await readTree();
    launcher = root ? detectDevLauncher(root) : null;
    // Settled on something: the chooser to dismiss, or a drawn screen that
    // isn't one. Either way there is nothing left to wait for.
    if (launcher || (root && hasDrawnContent(root))) break;
    if (Date.now() >= appearBy) break;
    if (!(await sleepOrAbort(APPEAR_POLL_MS, signal))) return { handled: false };
  }
  if (!root || !launcher) return { handled: false };

  const target = pickDevServerRow(root, device, port, launcher.historyY);
  if (!target) {
    return {
      handled: true,
      ok: false,
      reason:
        `the expo dev-client launcher is showing and lists no reachable server on port ${port}. ` +
        `Start Metro on that port, or pass \`metroPort\` for the bundler this run should use.`,
    };
  }

  // Re-check the signal before acting: the probe and the tree reads above take
  // seconds, so a run cancelled during them would otherwise still tap.
  if (signal?.aborted) return { handled: false };
  try {
    await invokeOnDevice(env, "gesture-tap", getDescribeTapPoint(target.node.frame));
  } catch (err) {
    // A rejection here must not leave the launch step: `runLaunch` and
    // `execLeafStep`'s launch case both let a throw through, so it would abort
    // the whole `flow-execute` call — losing every step collected so far and
    // booking the failure as a tool failure rather than a step error. A
    // cancellation makes the sub-tool itself reject, and that is the abort, not
    // a failed dismissal (`runLaunch` re-checks the signal on return).
    if (signal?.aborted) return { handled: false };
    return {
      handled: true,
      ok: false,
      reason:
        `the expo dev-client launcher is showing and the tap that opens ${target.url} failed: ` +
        `${errMsg(err)}`,
    };
  }

  const deadline = Date.now() + EXIT_TIMEOUT_MS;
  for (;;) {
    if (signal?.aborted) return { handled: true, ok: true, url: target.url };
    try {
      const next = (await fetchFlowTree(registry, device)).tree;
      if (!detectDevLauncher(next)) return { handled: true, ok: true, url: target.url };
    } catch {
      // Transient read failure mid-bundle — retry until the deadline.
    }
    if (Date.now() >= deadline) {
      return {
        handled: true,
        ok: false,
        reason:
          `opened ${target.url} from the expo dev-client launcher, but it was still showing ` +
          `${EXIT_TIMEOUT_MS / 1000}s later — the bundler at that address did not serve this app.`,
      };
    }
    if (!(await sleepOrAbort(EXIT_POLL_MS, signal))) {
      return { handled: true, ok: true, url: target.url };
    }
  }
}
