/**
 * The skill's prose claims things only code knows — which platforms a tool
 * supports, which not-connected reasons it can report — so a capability or
 * reason change falsifies it silently, and `grade-skills.mjs` never opens
 * `references/`. Every expectation here is derived from the source of truth;
 * restating one as a literal reintroduces the same drift.
 *
 * The Chromium recovery itself is deliberately NOT pinned phrase by phrase. It
 * is stated once, in `CHROMIUM_GUIDANCE` (pinned in
 * debugger/not-connected-map.test.ts against the errors it routes on), and every
 * surface below only has to route the reader there and not contradict it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { Registry, ToolCapability } from "@argent/registry";
import { DEBUGGER_NOT_CONNECTED_REASONS } from "@argent/telemetry";
import { createRestartAppTool } from "../src/tools/restart-app";
import { debuggerInspectElementTool } from "../src/tools/debugger/debugger-inspect-element";
import { debuggerReloadMetroTool } from "../src/tools/debugger/debugger-reload-metro";
import { debuggerComponentTreeTool } from "../src/tools/debugger/debugger-component-tree";
import { debuggerConnectTool } from "../src/tools/debugger/debugger-connect";
import { gestureSwipeTool } from "../src/tools/gesture-swipe";
import { createDebuggerStatusTool } from "../src/tools/debugger/debugger-status";
import { createBootDeviceTool } from "../src/tools/devices/boot-device";
import { DEFAULT_READY_TIMEOUT_MS } from "../src/tools/devices/boot-electron";
import { expectNoForbiddenAdvice } from "./helpers/forbidden-advice";
import { pinsOnce } from "./helpers/pins";
import {
  CHROMIUM_WORDS,
  PLATFORM_WORDS,
  expectNoPlatformBeyondTag,
  platformTag,
} from "./helpers/platform-tag";
import { getCandidateChromiumPorts } from "../src/utils/chromium-discovery";

const SKILLS = path.resolve(__dirname, "../../skills/skills");
const DEBUGGER_SKILL = path.join(SKILLS, "argent-metro-debugger/SKILL.md");
const FAILURE_SCENARIOS = path.join(
  SKILLS,
  "argent-metro-debugger/references/failure-scenarios.md"
);
const DEVICE_INTERACT_SKILL = path.join(SKILLS, "argent-device-interact/SKILL.md");
const CREATE_FLOW_RECOVERY = path.join(
  SKILLS,
  "argent-create-flow/references/reliability-and-recovery.md"
);
const ARGENT_RULE = path.resolve(__dirname, "../../skills/rules/argent.md");
const TOOLS_REFERENCE = path.resolve(__dirname, "../../docs/docs/reference/tools.mdx");

const restartAppTool = createRestartAppTool({} as unknown as Registry);
const debuggerStatusTool = createDebuggerStatusTool({} as unknown as Registry);
const bootDeviceParams = createBootDeviceTool({} as unknown as Registry).zodSchema as unknown as {
  shape: Record<string, { description?: string }>;
};
const restartApp = restartAppTool.capability;

/**
 * The single table row whose first cell starts with `label`. The uniqueness
 * assertion is what names a renamed row — without it the failure surfaces as a
 * `toContain` against undefined, naming neither the row nor the file.
 */
function row(file: string, label: string): string {
  const matches = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.startsWith(`| ${label}`));
  expect(matches, `expected exactly one "${label}" row in ${file}`).toHaveLength(1);
  return matches[0]!;
}

/**
 * The platform list a prose row states, e.g. "… on iOS / Android (like …" ->
 * "iOS / Android". Chromium is in the vocabulary here but not in PLATFORM_WORDS:
 * platformTag has no word for it, so a row claiming Chromium has to land inside
 * the captured tag to fail the comparison rather than be trimmed off it.
 */
function proseTag(cell: string): string {
  const words = [...PLATFORM_WORDS.map(([, word]) => word), "Chromium"].join("|");
  const match = new RegExp(` on ((?:${words})(?: / (?:${words}))*)`).exec(cell);
  return match?.[1] ?? "";
}

/** The probe set with the env list and the persisted file out of the way. */
function defaultChromiumPorts(): number[] {
  const prevList = process.env.ARGENT_CHROMIUM_PORTS;
  const prevFile = process.env.ARGENT_CHROMIUM_PORTS_FILE;
  delete process.env.ARGENT_CHROMIUM_PORTS;
  // Per-process, so a stale file from another run or a concurrent checkout cannot
  // add ports to the derived set and fail this as if the prose had drifted.
  process.env.ARGENT_CHROMIUM_PORTS_FILE = path.join(
    os.tmpdir(),
    `argent-absent-ports-${process.pid}.json`
  );
  try {
    return getCandidateChromiumPorts();
  } finally {
    if (prevList === undefined) delete process.env.ARGENT_CHROMIUM_PORTS;
    else process.env.ARGENT_CHROMIUM_PORTS = prevList;
    if (prevFile === undefined) delete process.env.ARGENT_CHROMIUM_PORTS_FILE;
    else process.env.ARGENT_CHROMIUM_PORTS_FILE = prevFile;
  }
}

/** Every tool whose rows must carry the tag `RN_ONLY_TOOL_CAPABILITY` derives. */
const RN_ONLY_ROWS = [
  {
    tool: debuggerReloadMetroTool,
    prose: "`debugger-reload-metro`",
    quick: "Reload JS",
    reference: "`debugger-reload-metro`",
  },
  {
    tool: debuggerComponentTreeTool,
    prose: "`debugger-component-tree`",
    quick: "Full component tree",
    reference: "`debugger-component-tree`",
  },
  {
    tool: debuggerInspectElementTool,
    prose: "`debugger-inspect-element`",
    quick: "Inspect component at point",
    reference: "`debugger-inspect-element`",
  },
] as const;

describe("platform tags match the capability objects", () => {
  it("tags restart-app with the platforms it actually supports", () => {
    for (const label of ["`restart-app`", "Relaunch app on device"]) {
      const cell = row(DEBUGGER_SKILL, label);
      expect(cell, label).toContain(`(${platformTag(restartApp)})`);
      // Chromium is the one platform the tag cannot cover — platformTag has no
      // word for it — so each row has to address it in prose: state the refusal,
      // or point at the row that does. Silence reads as the tag being the whole
      // story, which is what sent a Chromium reader to a tool the gate refuses.
      expect(cell.toLowerCase(), `${label}: addresses Chromium in prose`).toMatch(
        /not supported on chromium|on chromium see/
      );
      expectNoForbiddenAdvice(cell, label);
    }
    // appleRemote is deliberately absent from PLATFORM_WORDS: it is remote-iOS
    // over sim-remote (registry types.ts), which these rows fold into "iOS"
    // rather than naming, so there is no prose claim for a tag to track.
    expect(restartApp?.appleRemote).toBeDefined();
    // The guard the tags rest on. Every capability in these tables has a populated
    // matrix, so nothing above tells `apple: {}` - support the gate rejects - from
    // real iOS support.
    expect(platformTag({ apple: {} } as ToolCapability), "empty matrix is not support").toBe("");
  });

  it("tags every RN-only row the same way in the skill and in the docs reference", () => {
    // A bare row beside tagged siblings reads as the platform-agnostic one of the
    // set. `packages/docs` is in this loop because it is where the one wrong tag
    // landed: RN_ONLY_TOOL_CAPABILITY declares no `vega` either, so a tag naming
    // only Chromium as the exclusion asserts Vega support the gate rejects.
    for (const { tool, prose, quick, reference } of RN_ONLY_ROWS) {
      // platformTag has no word for chromium, so a tool gaining Chromium support
      // would keep its tag; that is the drift the tag itself cannot catch.
      expect(tool.capability?.chromium, tool.id).toBeUndefined();
      expect(tool.capability?.vega, tool.id).toBeUndefined();

      const tag = platformTag(tool.capability);
      const proseRow = row(DEBUGGER_SKILL, prose);
      const quickRow = row(DEBUGGER_SKILL, quick);
      const referenceRow = row(TOOLS_REFERENCE, reference);

      expect(proseTag(proseRow), tool.id).toBe(tag);
      expectNoPlatformBeyondTag(proseRow, tag, tool.id);
      for (const [where, cell] of [
        ["quick reference", quickRow],
        ["docs reference", referenceRow],
      ] as const) {
        expect(cell, `${tool.id} (${where})`).toContain(`(${tag})`);
        expectNoPlatformBeyondTag(cell, tag, `${tool.id} (${where})`);
      }
      // These rows are RN-only end to end, in all three tables, so naming a
      // Chromium runtime is barred outright - under any of the words for one,
      // since a single-word check reads "browser" as unrelated prose.
      for (const [where, cell] of [
        ["prose", proseRow],
        ["quick reference", quickRow],
        ["docs reference", referenceRow],
      ] as const) {
        expect(cell, `${tool.id} (${where})`).not.toMatch(CHROMIUM_WORDS);
      }
    }
  });
});

describe("the Chromium recovery routes to a relaunch that exists", () => {
  /**
   * Every surface that offers `restart-app` to a reader who may be on Chromium.
   * They state the refusal and delegate; the recovery itself lives in
   * CHROMIUM_GUIDANCE so there is one copy to keep true.
   */
  const surfaces = (): [string, string | undefined][] => [
    [DEBUGGER_SKILL, row(DEBUGGER_SKILL, "Relaunch app on device")],
    [FAILURE_SCENARIOS, row(FAILURE_SCENARIOS, "**Was connected, then tool fails**")],
    [DEVICE_INTERACT_SKILL, row(DEVICE_INTERACT_SKILL, "Restart an app")],
    ["restart-app's description", restartAppTool.description],
    [CREATE_FLOW_RECOVERY, row(CREATE_FLOW_RECOVERY, "Chromium")],
  ];

  it("states the refusal and sends the reader to the one copy of the recovery", () => {
    // The capability the whole carve-out rests on. A tool gaining chromium support
    // makes every "not supported" sentence below false at once.
    expect(restartApp?.chromium).toBeUndefined();

    for (const [where, text] of surfaces()) {
      const norm = (text ?? "").replace(/`/g, "").toLowerCase();
      // Two facts, and only two. The refusal is what a reader offered the tool
      // needs first; the pointer is what stops each surface growing its own copy
      // of the procedure, which is how the five drifted apart.
      expect(norm, `${where}: names debugger-status as the source of the recovery`).toContain(
        "debugger-status"
      );
      expect(norm, `${where}: says which field carries it`).toContain("guidance");
      // And that the relaunch is not the agent's to make. The reason why —
      // boot-device only ever starts an app — is stated in the guidance these
      // surfaces delegate to; restating it here is what grew the five copies.
      expect(norm, `${where}: the relaunch is the user's`).toMatch(
        /the user's move|the quit is the user's|ask the user to quit/
      );
    }
    // Four of the five name the tool, so they must also say it is refused. The
    // create-flow row is keyed by platform and never offers it.
    for (const [where, text] of surfaces().slice(0, 4)) {
      expect((text ?? "").toLowerCase(), `${where}: states the refusal`).toMatch(
        /not supported on chromium/
      );
    }
  });

  it("keeps every recovery surface clear of the advice the guidance forbids", () => {
    for (const [where, text] of surfaces()) expectNoForbiddenAdvice(text, where);
    expectNoForbiddenAdvice(debuggerConnectTool.description, "debugger-connect's description");
    expectNoForbiddenAdvice(
      row(FAILURE_SCENARIOS, "**App unreachable**"),
      "failure-scenarios App unreachable"
    );
  });

  it("does not offer launch-app as a way to start a Chromium app", () => {
    // launch-app's handler is a no-op that returns launched: true, and the runtime
    // guidance fences it by name — an unqualified "Always" on these surfaces
    // contradicts both.
    const deviceInteract = readFileSync(DEVICE_INTERACT_SKILL, "utf8");
    pinsOnce(
      row(DEVICE_INTERACT_SKILL, "Open an app"),
      "on Chromium it confirms the running renderer and starts nothing"
    );
    expect(deviceInteract, "section 3 carries the same carve-out").toMatch(
      /launch-app[^.]*Chromium[^.]*starts nothing|Chromium[^.]*launch-app[^.]*starts nothing/i
    );
  });

  it("names the surface a Chromium reader can actually use for discovery", () => {
    // gesture-swipe declares no chromium and the gate rejects it there, so the
    // verb in the shared-surface summary has to be the one that works. The literal
    // cannot see gesture-swipe gaining chromium support, so the capability is held
    // too.
    expect(gestureSwipeTool.capability?.chromium, gestureSwipeTool.id).toBeUndefined();
    pinsOnce(
      readFileSync(DEVICE_INTERACT_SKILL, "utf8"),
      "describe/tap/scroll/keyboard/screenshot surface drives all of them."
    );
  });

  it("tells a debugger-connect reader that a windowless app fails there too", () => {
    // debugger-connect is what SKILL.md's Quick Reference names for Chromium, and
    // it THROWS rather than classifying - so its one sentence about failure is the
    // whole diagnosis a reader gets there. "Chromium CDP terminated" alone routes a
    // windowless app to the relaunch the guidance forbids for that state.
    expect(debuggerConnectTool.description).toContain("serving no drivable page");
    expect(debuggerConnectTool.description).toContain("call debugger-status");
  });
});

describe("the boot-device hazards the recovery depends on", () => {
  it("carves Chromium out of force, the way headless beside it already does", () => {
    // The Electron branch forwards appPath / port / extraArgs and nothing else, so
    // `force` never reaches it (#867). The guidance no longer advises the flag; the
    // schema still accepts it, so the description is the only place that says so.
    pinsOnce(bootDeviceParams.shape.force?.description, "Ignored on Chromium");
  });

  it("states the Electron readiness bound the loop actually enforces", () => {
    // waitForCdpReady re-checks its deadline only between attempts and passes no
    // AbortSignal, so one hanging fetch runs past it — "waits its own fixed 30s"
    // was a bound the code does not enforce.
    const description = bootDeviceParams.shape.bootTimeoutMs?.description ?? "";
    expect(description).toContain(`${DEFAULT_READY_TIMEOUT_MS / 1000}s deadline`);
    expect(description, "zod rejects rather than clamps").not.toMatch(/clamp/i);
  });
});

describe("the prose derives what the code decides", () => {
  it("derives every copy of the probe set, in the two files no other test reads", () => {
    // rules/argent.md is loaded for every argent session and the debugger skill's
    // prerequisites paragraph is where an agent learns where a chromium-cdp-<port>
    // id comes from - so a reader can meet the probe set in either and nowhere
    // else. A restated set drifts wherever nothing derives it.
    pinsOnce(
      readFileSync(ARGENT_RULE, "utf8"),
      "auto-discovered on port `" +
        defaultChromiumPorts().join("`, `") +
        "`, `ARGENT_CHROMIUM_PORTS` and the ports `boot-device` opened"
    );
    pinsOnce(
      readFileSync(DEBUGGER_SKILL, "utf8"),
      "auto-discovered by `list-devices` on `" +
        defaultChromiumPorts().join("`, `") +
        "`, `ARGENT_CHROMIUM_PORTS` and the ports `boot-device` opened)"
    );
  });

  it("answers every not-connected reason the debugger can report", () => {
    // The skill tells the agent to match debugger-status's coded `reason`
    // against this table, so a reason with no row is a reader with no recovery.
    const table = readFileSync(FAILURE_SCENARIOS, "utf8");
    const skill = readFileSync(DEBUGGER_SKILL, "utf8");
    for (const reason of DEBUGGER_NOT_CONNECTED_REASONS) {
      expect(skill, `${reason} is missing from SKILL.md's reason list`).toContain(`\`${reason}\``);
      expect(table, `${reason} is missing from failure-scenarios.md`).toContain(reason);
      expect(
        debuggerStatusTool.description,
        `${reason} is missing from debugger-status's description`
      ).toContain(reason);
    }
    // cdp_unreachable covers three unlike states and the reason name says none of
    // them; the Chromium one is the reason the recovery had to split.
    pinsOnce(
      debuggerStatusTool.description,
      "the CDP endpoint is unreachable, answered malformed, or (Chromium) is up with no " +
        "drivable page"
    );
    // The one instruction attached to that list. Without it the reasons read as a
    // taxonomy, and the reason most likely to be retry-looped waits out a full CDP
    // timeout per send.
    pinsOnce(debuggerStatusTool.description, "Follow the guidance field — do not retry in a loop.");
  });
});
