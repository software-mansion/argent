import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { DeviceInfo, Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";
import { adbShell } from "../../src/utils/adb";
import { fetchFlowTree } from "../../src/tools/flows/flow-tree";
import { createRunFlowTool, type StepReport } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";
import {
  detectDevLauncher,
  dismissDevLauncher,
  hasDrawnContent,
  pickDevServerRow,
} from "../../src/tools/flows/flow-dev-launcher";

vi.mock("../../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/adb")>()),
  adbShell: vi.fn(),
}));

vi.mock("../../src/tools/flows/flow-tree", () => ({ fetchFlowTree: vi.fn() }));

beforeEach(() => {
  vi.mocked(adbShell).mockReset();
  vi.mocked(fetchFlowTree).mockReset();
});

// The fixture is the real tree an expo-dev-client chooser produced on an
// Android emulator (Bluesky dev build, android-devtools source), frames
// included. It is the awkward case rather than a tidy one: TWO bundlers were
// live (8081 and 8082), and the history below them remembered a third address
// on the run's own port that had long stopped answering, plus a port (8085) no
// live row offers at all — which is exactly the shape that makes "just tap the
// row with the right port" wrong.

function node(role: string, label: string, frame: number[], children: DescribeNode[] = []) {
  const [x, y, width, height] = frame;
  const own: DescribeNode = { role, label, frame: { x, y, width, height }, children };
  // The flow tree adapters hoist descendant text onto every ancestor; the
  // module has to work against that, so the fixture reproduces it.
  const sub = [label, ...children.map((c) => c.subtreeText ?? c.label ?? "")]
    .filter(Boolean)
    .join(" ");
  if (sub !== label) own.subtreeText = sub;
  return own;
}

const chevron = (y: number) => node("View", "Chevron", [0.847, y, 0.051, 0.025]);

function launcherTree(): DescribeNode {
  return node(
    "ROOT",
    "Screen",
    [0, 0, 1, 1],
    [
      node(
        "ComposeView",
        "",
        [0, 0, 1, 1],
        [
          node("StaticText", "Bluesky", [0.214, 0.062, 0.152, 0.024]),
          node("StaticText", "Development Build", [0.214, 0.091, 0.299, 0.021]),
          node(
            "ScrollView",
            "",
            [0.061, 0.193, 0.878, 0.608],
            [
              node("StaticText", "DEVELOPMENT SERVERS", [0.061, 0.193, 0.352, 0.02]),
              node(
                "View",
                "http://10.0.2.2:8082 / Chevron",
                [0.061, 0.233, 0.878, 0.064],
                [chevron(0.253)]
              ),
              node(
                "View",
                "http://10.0.2.2:8081 / Chevron",
                [0.061, 0.307, 0.878, 0.064],
                [chevron(0.327)]
              ),
              node("View", "Plus / New development server", [0.061, 0.382, 0.878, 0.059]),
              node("StaticText", "RECENTLY OPENED", [0.061, 0.491, 0.278, 0.02]),
              node(
                "View",
                "Bluesky / http://10.0.2.2:8085 / Chevron",
                [0.061, 0.53, 0.878, 0.087],
                [chevron(0.561)]
              ),
              node(
                "View",
                "Bluesky / http://192.168.92.72:8081 / Chevron",
                [0.061, 0.622, 0.878, 0.087],
                [chevron(0.653)]
              ),
              node(
                "View",
                "Bluesky / http://10.0.2.2:8081 / Chevron",
                [0.061, 0.714, 0.878, 0.087],
                [chevron(0.745)]
              ),
            ]
          ),
        ]
      ),
    ]
  );
}

// The chooser's OTHER face, captured the same way on the same build: what the
// dev client draws when it has discovered no running packager. There is no
// server list at all — an instruction card, an address box prefilled with a URL
// and a fetch button stand in its place — and the history below it survives.
// This is the state a run most needs help with, and the one the actionable "no
// reachable server on port N" failure has to come from.
function noServersTree(): DescribeNode {
  return node(
    "ROOT",
    "Screen",
    [0, 0, 1, 1],
    [
      node(
        "ComposeView",
        "",
        [0, 0, 1, 1],
        [
          node("StaticText", "Bluesky", [0.214, 0.062, 0.152, 0.024]),
          node("StaticText", "Development Build", [0.214, 0.091, 0.299, 0.021]),
          node(
            "ScrollView",
            "",
            [0.061, 0.193, 0.878, 0.655],
            [
              node("StaticText", "DEVELOPMENT SERVERS", [0.061, 0.193, 0.352, 0.02]),
              node("StaticText", "INFO", [0.841, 0.173, 0.122, 0.059]),
              node(
                "StaticText",
                "Start a local development server with:",
                [0.102, 0.253, 0.519, 0.018]
              ),
              node("StaticText", "npx expo start", [0.143, 0.31, 0.298, 0.023]),
              node(
                "StaticText",
                "Then, select the local server when it appears here.",
                [0.102, 0.373, 0.692, 0.018]
              ),
              // The box carries no label of its own: the adapters render its URL
              // as a text leaf inside it, which is what an origin match sees.
              node(
                "TextField",
                "",
                [0.143, 0.411, 0.715, 0.059],
                [node("StaticText", "http://localhost:8081", [0.143, 0.431, 0.327, 0.02])]
              ),
              node("View", "Connect", [0.102, 0.481, 0.796, 0.06]),
              node("StaticText", "Or", [0.102, 0.561, 0.796, 0.018]),
              node("View", "Fetch development servers / Download", [0.102, 0.599, 0.796, 0.064]),
              node("StaticText", "RECENTLY OPENED", [0.061, 0.732, 0.278, 0.02]),
              node("StaticText", "RESET", [0.831, 0.713, 0.122, 0.059]),
              node(
                "View",
                "Bluesky / http://10.0.2.2:8082 / Chevron",
                [0.061, 0.772, 0.878, 0.087],
                [chevron(0.803)]
              ),
            ]
          ),
        ]
      ),
    ]
  );
}

/**
 * The fixtures above are written nested, which reads better; the Android adapter
 * emits the same screen FLAT — every node a direct child of one synthetic root,
 * with the ancestors surviving as leaves that keep their own frames and carry the
 * hoisted `subtreeText` (measured on the device this was built against: 23 leaves,
 * depth 1). The module reads the flattened list and the frames only, so both
 * shapes must give the same answers; the cases below run against this one.
 */
function asProduced(tree: DescribeNode): DescribeNode {
  const leaves: DescribeNode[] = [];
  const walk = (n: DescribeNode): void => {
    leaves.push({ ...n, children: [] });
    for (const child of n.children) walk(child);
  };
  for (const child of tree.children) walk(child);
  return { ...tree, children: leaves };
}

const emulator: DeviceInfo = { id: "emulator-5556", platform: "android", kind: "emulator" };
const phone: DeviceInfo = { id: "R5CT30", platform: "android", kind: "device" };
const sim: DeviceInfo = { id: "A1E0DF35", platform: "ios", kind: "simulator" };

/** The chooser's history heading y, for the picker cases below. */
function historyY(tree: DescribeNode): number {
  const found = detectDevLauncher(tree);
  if (!found) throw new Error("fixture is no longer recognized as the chooser");
  return found.historyY;
}

/**
 * Every text the tree renders BELOW the history boundary — what the chooser
 * only remembers. Lets a "must not open a remembered row" case prove the
 * boundary did the rejecting, rather than passing because the port it asked for
 * was absent from the fixture entirely.
 */
function rememberedText(tree: DescribeNode): string {
  const boundary = historyY(tree);
  const out: string[] = [];
  const walk = (n: DescribeNode): void => {
    if (n.frame.y >= boundary && n.label) out.push(n.label);
    for (const child of n.children) walk(child);
  };
  walk(tree);
  return out.join(" ");
}

describe("expo dev-client launcher detection", () => {
  it("recognizes the chooser and locates the history boundary below the live rows", () => {
    // 0.491 is the RECENTLY OPENED heading — NOT the 0.193 of the scroll
    // container whose hoisted text also contains those words. A boundary that
    // floated up to the container would put every live row in the history and
    // leave nothing to open.
    expect(detectDevLauncher(launcherTree())).toEqual({ historyY: 0.491 });
  });

  it("recognizes the face the chooser shows with no packager discovered", () => {
    // Requiring the "new server" affordance recognized only the face that
    // already lists servers. On this one the launch reported a pass and every
    // later step then resolved its selectors against the chooser.
    expect(detectDevLauncher(noServersTree())).toEqual({ historyY: 0.732 });
  });

  it("does not fire on an app screen that merely mentions development servers", () => {
    const settings = node(
      "ROOT",
      "Screen",
      [0, 0, 1, 1],
      [
        node("StaticText", "DEVELOPMENT SERVERS", [0.061, 0.193, 0.352, 0.02]),
        node("View", "http://10.0.2.2:8081", [0.061, 0.233, 0.878, 0.064]),
      ]
    );
    // The heading alone is ordinary app wording; without the chooser's own
    // "new server" affordance this must stay hands-off rather than tap at a
    // screen the flow put there deliberately.
    expect(detectDevLauncher(settings)).toBeNull();
  });

  it("treats a chooser with no history yet as all-live", () => {
    const fresh = node(
      "ROOT",
      "Screen",
      [0, 0, 1, 1],
      [
        node("StaticText", "DEVELOPMENT SERVERS", [0.061, 0.193, 0.352, 0.02]),
        node("View", "http://10.0.2.2:8081 / Chevron", [0.061, 0.233, 0.878, 0.064]),
        node("View", "Plus / New development server", [0.061, 0.382, 0.878, 0.059]),
      ]
    );
    expect(detectDevLauncher(fresh)).toEqual({ historyY: 1 });
  });
});

describe("waiting for a cold start to become something", () => {
  // The launch step reads ~2s after the relaunch; on a cold start the chooser
  // took 4-10s to draw on the emulator this was built against. Without the
  // splash/content distinction the read lands on the splash every time and
  // concludes there is no chooser — the exact miss this guards.
  it("treats a wordless splash as still starting", () => {
    const splash = node(
      "ROOT",
      "Screen",
      [0, 0, 1, 1],
      [node("Image", "", [0.4, 0.45, 0.2, 0.1]), node("View", "", [0, 0, 1, 1])]
    );
    expect(hasDrawnContent(splash)).toBe(false);
  });

  it("treats the chooser and a drawn app screen as arrived", () => {
    expect(hasDrawnContent(launcherTree())).toBe(true);
    const app = node(
      "ROOT",
      "Screen",
      [0, 0, 1, 1],
      [
        node("StaticText", "Home", [0.1, 0.1, 0.2, 0.03]),
        node("StaticText", "Following", [0.1, 0.2, 0.3, 0.03]),
      ]
    );
    expect(hasDrawnContent(app)).toBe(true);
  });

  it("does not count a lone splash word as a drawn screen", () => {
    // One label is what a branded splash carries; the wait should continue.
    const branded = node(
      "ROOT",
      "Screen",
      [0, 0, 1, 1],
      [node("StaticText", "Bluesky", [0.4, 0.45, 0.2, 0.03])]
    );
    expect(hasDrawnContent(branded)).toBe(false);
  });
});

describe("picking the row for the run's own bundler", () => {
  it("opens the live row on the requested port, not the other live bundler", () => {
    const tree = launcherTree();
    const picked = pickDevServerRow(tree, emulator, 8081, historyY(tree));
    expect(picked?.url).toBe("http://10.0.2.2:8081");
    // The row itself, not the scroll container whose hoisted text repeats it.
    expect(picked?.node.label).toBe("http://10.0.2.2:8081 / Chevron");
    expect(picked?.node.frame.y).toBe(0.307);
  });

  it("honors the caller's port when several bundlers are live", () => {
    const tree = launcherTree();
    expect(pickDevServerRow(tree, emulator, 8082, historyY(tree))?.node.frame.y).toBe(0.233);
  });

  it("never falls back to a remembered row, even one carrying the right port", () => {
    // Only the history holds 8085 — and history rows are stale by nature (the
    // fixture's own 192.168.92.72:8081 is a dead address on the live port).
    // Reporting beats opening a server that may not answer.
    const tree = launcherTree();
    // The port IS in the tree, on a host this device can reach, so what must
    // reject it is the boundary — not an absence the assertion below could pass
    // on by accident.
    expect(rememberedText(tree)).toContain("http://10.0.2.2:8085");
    expect(pickDevServerRow(tree, emulator, 8085, historyY(tree))).toBeNull();
  });

  it("does not settle for the scrolling container that repeats every row's URL", () => {
    // The adapters' hoist puts every row URL — the history's included — onto the
    // scroll container, whose top edge is ABOVE the boundary. Reading that
    // hoisted text made a history-only port match the container, and the launch
    // then tapped the container's centre: an arbitrary point on the chooser,
    // reported as "opened http://10.0.2.2:8085".
    const tree = launcherTree();
    const container = tree.children[0].children[2];
    expect(container.role).toBe("ScrollView");
    expect(container.subtreeText).toContain("http://10.0.2.2:8085");
    expect(container.frame.y).toBeLessThan(historyY(tree));
    expect(pickDevServerRow(tree, emulator, 8085, historyY(tree))).toBeNull();
  });

  it("does not mistake the chooser's address box for a live row", () => {
    const tree = noServersTree();
    const box = tree.children[0].children[2].children[5];
    const urlInBox = box.children[0];
    // The URL leaf is above the history boundary and spells the run's own port,
    // so what keeps it out is sitting inside the input. Tapping it opens a
    // keyboard, and the run then fails blaming a bundler it never opened.
    expect(box.role).toBe("TextField");
    expect(urlInBox.label).toContain(":8081");
    expect(urlInBox.frame.y).toBeLessThan(historyY(tree));
    expect(pickDevServerRow(tree, emulator, 8081, historyY(tree))).toBeNull();
  });

  it("finds a row whose URL is rendered by a child leaf, not the card's own label", () => {
    // The production shape: the Android adapter labels one view, so the card is
    // unlabelled and a StaticText inside it renders the URL. Own-text matching
    // must still land inside the card.
    const rows = node(
      "ROOT",
      "Screen",
      [0, 0, 1, 1],
      [
        node("StaticText", "DEVELOPMENT SERVERS", [0.061, 0.193, 0.352, 0.02]),
        node(
          "View",
          "",
          [0.061, 0.233, 0.878, 0.064],
          [node("StaticText", "http://10.0.2.2:8081", [0.143, 0.245, 0.4, 0.02])]
        ),
        node("View", "Plus / New development server", [0.061, 0.382, 0.878, 0.059]),
      ]
    );
    const picked = pickDevServerRow(rows, emulator, 8081, historyY(rows));
    expect(picked?.node.role).toBe("StaticText");
    expect(picked?.node.frame.y).toBe(0.245);
  });

  it("does not let a short port match a longer one", () => {
    // `http://10.0.2.2:808` is a prefix of the live 8081 row. Substring
    // matching alone would open the wrong bundler and run the flow against
    // someone else's bundle.
    const tree = launcherTree();
    expect(pickDevServerRow(tree, emulator, 808, historyY(tree))).toBeNull();
  });

  it("prefers the emulator's host-loopback alias over localhost", () => {
    const both = node(
      "ROOT",
      "Screen",
      [0, 0, 1, 1],
      [
        node("StaticText", "DEVELOPMENT SERVERS", [0.061, 0.193, 0.352, 0.02]),
        node("View", "http://localhost:8081", [0.061, 0.233, 0.878, 0.064]),
        node("View", "http://10.0.2.2:8081", [0.061, 0.307, 0.878, 0.064]),
        node("View", "Plus / New development server", [0.061, 0.382, 0.878, 0.059]),
      ]
    );
    // On an emulator `localhost` is the emulator itself and only reaches Metro
    // through an adb reverse tunnel; 10.0.2.2 is the host by construction.
    expect(pickDevServerRow(both, emulator, 8081, historyY(both))?.url).toBe(
      "http://10.0.2.2:8081"
    );
    // A physical device has no such alias — there the tunnel is the only route.
    expect(pickDevServerRow(both, phone, 8081, historyY(both))?.url).toBe("http://localhost:8081");
  });

  it("falls back to loopback off Android, the branch the gate never reaches", () => {
    // Documents the helper's total behaviour, not a production path: the
    // recovery is Android-only by construction (`isExpoDevBuild` answers false
    // for every other platform), so the picker only ever runs with an Android
    // device. An iOS simulator shares the host's network stack, which is what
    // the fallback would mean if it were ever reached.
    const ios = node(
      "ROOT",
      "Screen",
      [0, 0, 1, 1],
      [
        node("StaticText", "DEVELOPMENT SERVERS", [0.061, 0.193, 0.352, 0.02]),
        node("View", "http://localhost:8081", [0.061, 0.233, 0.878, 0.064]),
        node("View", "Plus / New development server", [0.061, 0.382, 0.878, 0.059]),
      ]
    );
    expect(pickDevServerRow(ios, sim, 8081, historyY(ios))?.url).toBe("http://localhost:8081");
  });
});

describe("recognizing a build that can show the chooser", () => {
  // Excerpts of the real `dumpsys package xyz.blueskyweb.app` from the emulator
  // this was built against. RELEASE_DUMP is the same text minus what
  // expo-dev-launcher's DEBUG-variant manifest contributes — which is all a
  // release build of the same project differs by here — and it deliberately
  // keeps the `exp+<slug>` scheme, since the config plugin writes that into the
  // main manifest and every variant merges it.
  const RELEASE_DUMP = `
Activity Resolver Table:
  Schemes:
      exp+bluesky:
        c17d440 xyz.blueskyweb.app/.MainActivity filter fd0a4be
          Action: "android.intent.action.VIEW"
          Scheme: "bluesky"
          Scheme: "exp+bluesky"
`;
  const DEV_DUMP = `${RELEASE_DUMP}      expo-dev-launcher:
        28d4cfc xyz.blueskyweb.app/expo.modules.devlauncher.compose.AuthActivity filter a86bf85
          Action: "android.intent.action.VIEW"
          Scheme: "expo-dev-launcher"
`;

  /** The probe is only observable through what the launch then does. */
  function env(device: DeviceInfo) {
    const registry = {
      invokeTool: vi.fn(async () => ({ ok: true })),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    } as unknown as Registry;
    return { registry, device };
  }

  it("waits for the chooser on a build whose debug manifest installs the launcher", async () => {
    vi.mocked(adbShell).mockResolvedValue(DEV_DUMP);
    let read = 0;
    vi.mocked(fetchFlowTree).mockImplementation(async () => {
      read += 1;
      return {
        tree: read === 1 ? launcherTree() : node("ROOT", "Screen", [0, 0, 1, 1], []),
        source: "android-devtools",
      };
    });

    await expect(
      dismissDevLauncher(env(emulator), "xyz.blueskyweb.app", 8081)
    ).resolves.toMatchObject({ handled: true, ok: true });
    expect(fetchFlowTree).toHaveBeenCalled();
  });

  it("costs a release build of the same project nothing", async () => {
    // The `exp+bluesky` scheme is still there — reading THAT made every release
    // build of any project with expo-dev-client in its dependencies wait out the
    // appear window on every launch step, for a chooser it can never show.
    expect(RELEASE_DUMP).toContain('Scheme: "exp+bluesky"');
    vi.mocked(adbShell).mockResolvedValue(RELEASE_DUMP);

    await expect(dismissDevLauncher(env(emulator), "xyz.blueskyweb.app", 8081)).resolves.toEqual({
      handled: false,
    });
    expect(fetchFlowTree).not.toHaveBeenCalled();
  });

  it("leaves a launch alone when the package cannot be probed", async () => {
    vi.mocked(adbShell).mockRejectedValue(new Error("device offline"));

    await expect(dismissDevLauncher(env(emulator), "xyz.blueskyweb.app", 8081)).resolves.toEqual({
      handled: false,
    });
    expect(fetchFlowTree).not.toHaveBeenCalled();
  });

  it("never probes a platform whose launcher this is not", async () => {
    // iOS reaches Metro at a stable localhost, so the chooser is a rarity there
    // and nothing is probed — the recovery is Android-only by construction.
    await expect(dismissDevLauncher(env(sim), "xyz.blueskyweb.app", 8081)).resolves.toEqual({
      handled: false,
    });
    expect(adbShell).not.toHaveBeenCalled();
  });
});

describe("getting a launch past the chooser", () => {
  // A dev build by the probe, so every case below reaches the tree reads.
  const DEV_DUMP = 'Scheme: "expo-dev-launcher"';

  /** Scripted tree reads: one entry per read, the last one repeating. */
  function reads(...trees: DescribeNode[]): void {
    let at = 0;
    vi.mocked(fetchFlowTree).mockImplementation(async (): Promise<DescribeTreeData> => {
      const tree = trees[Math.min(at, trees.length - 1)];
      at += 1;
      return { tree, source: "android-devtools" };
    });
  }

  function env(
    invoke: (tool: string, args: Record<string, unknown>) => unknown = () => ({ ok: true }),
    signal?: AbortSignal
  ) {
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const registry = {
      invokeTool: vi.fn(async (tool: string, args: Record<string, unknown>) => {
        calls.push({ tool, args });
        return invoke(tool, args);
      }),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    } as unknown as Registry;
    return { calls, actionEnv: { registry, device: emulator, signal } };
  }

  const splash = node("ROOT", "Screen", [0, 0, 1, 1], [node("Image", "", [0.4, 0.45, 0.2, 0.1])]);
  const app = node(
    "ROOT",
    "Screen",
    [0, 0, 1, 1],
    [
      node("StaticText", "Home", [0.1, 0.1, 0.2, 0.03]),
      node("StaticText", "Following", [0.1, 0.2, 0.3, 0.03]),
    ]
  );

  it("opens the run's own row and reports the URL once the chooser is gone", async () => {
    vi.mocked(adbShell).mockResolvedValue(DEV_DUMP);
    reads(launcherTree(), app);
    const { calls, actionEnv } = env();

    await expect(dismissDevLauncher(actionEnv, "xyz.blueskyweb.app", 8081)).resolves.toEqual({
      handled: true,
      ok: true,
      url: "http://10.0.2.2:8081",
    });
    // The centre of the live 8081 row (y 0.307, height 0.064) — not the other
    // live bundler's row, and not the container's centre.
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe("gesture-tap");
    expect(calls[0].args).toMatchObject({ x: 0.5, udid: "emulator-5556" });
    expect(calls[0].args.y).toBeCloseTo(0.339, 5);
  });

  it("waits out a splash the chooser has not drawn over yet", async () => {
    vi.mocked(adbShell).mockResolvedValue(DEV_DUMP);
    // The launch step reads ~2s after the relaunch; a cold dev client needs
    // several seconds more. Without the wait the first read decides there is no
    // chooser and the run proceeds against one.
    reads(splash, launcherTree(), app);
    const { calls, actionEnv } = env();

    await expect(dismissDevLauncher(actionEnv, "xyz.blueskyweb.app", 8081)).resolves.toMatchObject({
      handled: true,
      ok: true,
    });
    expect(calls.map((c) => c.tool)).toEqual(["gesture-tap"]);
  });

  it("leaves a launch that is already showing the app alone", async () => {
    vi.mocked(adbShell).mockResolvedValue(DEV_DUMP);
    reads(app);
    const { calls, actionEnv } = env();

    await expect(dismissDevLauncher(actionEnv, "xyz.blueskyweb.app", 8081)).resolves.toEqual({
      handled: false,
    });
    expect(calls).toEqual([]);
  });

  it("does not read the screen at all for a build that has no launcher", async () => {
    vi.mocked(adbShell).mockResolvedValue('Scheme: "exp+bluesky"');
    const { actionEnv } = env();

    await expect(dismissDevLauncher(actionEnv, "xyz.blueskyweb.app", 8081)).resolves.toEqual({
      handled: false,
    });
    expect(fetchFlowTree).not.toHaveBeenCalled();
  });

  it("reports the port it wanted when no live row offers it, and taps nothing", async () => {
    vi.mocked(adbShell).mockResolvedValue(DEV_DUMP);
    reads(launcherTree());
    const { calls, actionEnv } = env();

    const outcome = await dismissDevLauncher(actionEnv, "xyz.blueskyweb.app", 8085);
    expect(outcome).toMatchObject({ handled: true, ok: false });
    expect(outcome).toHaveProperty(
      "reason",
      expect.stringContaining("lists no reachable server on port 8085")
    );
    expect(calls).toEqual([]);
  });

  it("reports a failed tap as a launch failure instead of throwing out of the run", async () => {
    vi.mocked(adbShell).mockResolvedValue(DEV_DUMP);
    reads(launcherTree());
    const { actionEnv } = env((tool) => {
      if (tool === "gesture-tap") throw new Error("device offline");
      return { ok: true };
    });

    // A throw here would leave `flow-execute` itself, losing every step
    // collected so far and booking the failure as a tool failure.
    const outcome = await dismissDevLauncher(actionEnv, "xyz.blueskyweb.app", 8081);
    expect(outcome).toMatchObject({ handled: true, ok: false });
    expect(outcome).toHaveProperty("reason", expect.stringContaining("device offline"));
  });

  it("does not tap when the run was cancelled during the probe", async () => {
    vi.mocked(adbShell).mockResolvedValue(DEV_DUMP);
    reads(launcherTree());
    const controller = new AbortController();
    controller.abort();
    const { calls, actionEnv } = env(() => ({ ok: true }), controller.signal);

    await expect(dismissDevLauncher(actionEnv, "xyz.blueskyweb.app", 8081)).resolves.toEqual({
      handled: false,
    });
    expect(calls).toEqual([]);
  });

  it("keeps waiting when a read fails rather than deciding there is no chooser", async () => {
    vi.mocked(adbShell).mockResolvedValue(DEV_DUMP);
    // The launch's own tree-source gate has already vouched for the source, so a
    // failure here is transient. The wait continues, and the chooser the next
    // read does return is still dismissed.
    let at = 0;
    vi.mocked(fetchFlowTree).mockImplementation(async () => {
      at += 1;
      if (at === 1) throw new Error("hierarchy unavailable");
      return { tree: at === 2 ? launcherTree() : app, source: "android-devtools" };
    });
    const { calls, actionEnv } = env();

    await expect(dismissDevLauncher(actionEnv, "xyz.blueskyweb.app", 8081)).resolves.toMatchObject({
      handled: true,
      ok: true,
    });
    expect(calls.map((c) => c.tool)).toEqual(["gesture-tap"]);
  });
});

describe("the shape the adapter really produces", () => {
  it("reads a flattened chooser exactly like the nested fixture", () => {
    const flat = asProduced(launcherTree());
    expect(flat.children.every((n) => n.children.length === 0)).toBe(true);
    expect(detectDevLauncher(flat)).toEqual({ historyY: 0.491 });
    const picked = pickDevServerRow(flat, emulator, 8081, 0.491);
    expect(picked?.url).toBe("http://10.0.2.2:8081");
    expect(picked?.node.frame.y).toBe(0.307);
    // The scroll container is a full-width leaf here, carrying every row's URL
    // as hoisted text — the shape that made a history-only port match it.
    expect(pickDevServerRow(flat, emulator, 8085, 0.491)).toBeNull();
  });

  it("keeps the address box out of the candidates once flattened", () => {
    // Flattening drops the parent/child link between the input and the text it
    // renders, so only the frames are left to tell them apart — which is why the
    // exclusion is geometric.
    const flat = asProduced(noServersTree());
    expect(detectDevLauncher(flat)).toEqual({ historyY: 0.732 });
    expect(pickDevServerRow(flat, emulator, 8081, 0.732)).toBeNull();
  });
});

describe("when the bundler never serves the app", () => {
  it("gives the chooser the full exit budget, then names the URL it opened", async () => {
    // The tap lands, but the chooser is still there a minute later: the bundler at
    // that address is not serving this app. The wait is generous because what
    // follows a tap is a cold bundle, so only the deadline can tell the two apart.
    vi.useFakeTimers();
    try {
      vi.mocked(adbShell).mockResolvedValue('Scheme: "expo-dev-launcher"');
      vi.mocked(fetchFlowTree).mockResolvedValue({
        tree: launcherTree(),
        source: "android-devtools",
      });
      const registry = {
        invokeTool: vi.fn(async () => ({ ok: true })),
        getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
      } as unknown as Registry;

      const pending = dismissDevLauncher(
        { registry, device: emulator },
        "xyz.blueskyweb.app",
        8081
      );
      await vi.advanceTimersByTimeAsync(61_000);
      const outcome = await pending;

      expect(outcome).toMatchObject({ handled: true, ok: false });
      expect(outcome).toHaveProperty(
        "reason",
        expect.stringContaining("opened http://10.0.2.2:8081 from the expo dev-client launcher")
      );
      expect(outcome).toHaveProperty("reason", expect.stringContaining("still showing 60s later"));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("what the launch step reports", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-dev-launcher-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** A registry that answers everything a bare Android `launch` step asks for. */
  function launchRegistry(): Registry {
    return {
      invokeTool: vi.fn(async (id: string) =>
        id === "list-devices" ? { devices: [] } : { ok: true }
      ),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
      // The Android tree-source gate probes the devtools helper once.
      resolveService: vi.fn(async () => ({ isReady: () => true })),
    } as unknown as Registry;
  }

  async function runLaunchOnly(params: Record<string, unknown>): Promise<StepReport[]> {
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "launch-only.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "launch", app: "com.example.dev" }],
      }),
      "utf8"
    );
    const result = await createRunFlowTool(launchRegistry()).execute(
      {},
      { name: "launch-only", project_root: tmpDir, device: emulator.id, ...params }
    );
    if (!("steps" in result))
      throw new Error(`expected a run result, got ${JSON.stringify(result)}`);
    return result.steps;
  }

  it("passes with a warning naming the server it opened", async () => {
    vi.mocked(adbShell).mockResolvedValue('Scheme: "expo-dev-launcher"');
    let read = 0;
    vi.mocked(fetchFlowTree).mockImplementation(async () => {
      read += 1;
      return {
        tree: read === 1 ? launcherTree() : node("ROOT", "Screen", [0, 0, 1, 1], []),
        source: "android-devtools",
      };
    });

    // The step did pass — but not by starting where the flow assumes, which is
    // the only place the run says so.
    expect(await runLaunchOnly({ metroPort: 8082 })).toMatchObject([
      {
        kind: "launch",
        status: "pass",
        warning:
          "app opened behind the expo dev-client launcher — dismissed it via http://10.0.2.2:8082",
      },
    ]);
  });

  it("errors with the port it wanted when the chooser lists no live row for it", async () => {
    vi.mocked(adbShell).mockResolvedValue('Scheme: "expo-dev-launcher"');
    vi.mocked(fetchFlowTree).mockResolvedValue({
      tree: launcherTree(),
      source: "android-devtools",
    });

    const steps = await runLaunchOnly({ metroPort: 8085 });
    expect(steps[0]).toMatchObject({ kind: "launch", status: "error" });
    expect(steps[0].reason).toContain("lists no reachable server on port 8085");
  });

  it("takes 8081 when the caller names no port", async () => {
    vi.mocked(adbShell).mockResolvedValue('Scheme: "expo-dev-launcher"');
    let read = 0;
    vi.mocked(fetchFlowTree).mockImplementation(async () => {
      read += 1;
      return {
        tree: read === 1 ? launcherTree() : node("ROOT", "Screen", [0, 0, 1, 1], []),
        source: "android-devtools",
      };
    });

    const steps = await runLaunchOnly({});
    expect(steps[0].warning).toContain("http://10.0.2.2:8081");
  });

  it("says nothing extra when the app starts on its own screen", async () => {
    vi.mocked(adbShell).mockResolvedValue('Scheme: "expo-dev-launcher"');
    vi.mocked(fetchFlowTree).mockResolvedValue({
      tree: node(
        "ROOT",
        "Screen",
        [0, 0, 1, 1],
        [
          node("StaticText", "Home", [0.1, 0.1, 0.2, 0.03]),
          node("StaticText", "Following", [0.1, 0.2, 0.3, 0.03]),
        ]
      ),
      source: "android-devtools",
    });

    const steps = await runLaunchOnly({ metroPort: 8082 });
    expect(steps[0]).toMatchObject({ kind: "launch", status: "pass" });
    expect(steps[0].warning).toBeUndefined();
  });
});
