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
import { FAILURE_CODES } from "@argent/registry";
import type { Registry, ToolCapability } from "@argent/registry";
import { DEBUGGER_NOT_CONNECTED_REASONS } from "@argent/telemetry";
import { createRestartAppTool } from "../src/tools/restart-app";
import { debuggerInspectElementTool } from "../src/tools/debugger/debugger-inspect-element";
import { debuggerReloadMetroTool } from "../src/tools/debugger/debugger-reload-metro";
import { debuggerComponentTreeTool } from "../src/tools/debugger/debugger-component-tree";
import { debuggerConnectTool } from "../src/tools/debugger/debugger-connect";
import { listDevicesTool } from "../src/tools/devices/list-devices";
import { chromiumTabsTool } from "../src/tools/chromium-tabs";
import { reinstallAppTool } from "../src/tools/reinstall-app";
import { openUrlTool } from "../src/tools/open-url";
import { chromiumCookiesTool } from "../src/tools/chromium-cookies";
import { chromiumStorageTool } from "../src/tools/chromium-storage";
import { networkLogsTool } from "../src/tools/network/network-logs";
import { networkRequestTool } from "../src/tools/network/network-request";
import { gestureSwipeTool } from "../src/tools/gesture-swipe";
import { createDebuggerStatusTool } from "../src/tools/debugger/debugger-status";
import { createDebuggerLogRegistryTool } from "../src/tools/debugger/debugger-log-registry";
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
const CONFIGURATION_REFERENCE = path.resolve(
  __dirname,
  "../../docs/docs/reference/configuration.mdx"
);
const INTERACTING_FEATURE = path.resolve(
  __dirname,
  "../../docs/docs/features/interacting-with-apps.mdx"
);
const DEBUGGING_FEATURE = path.resolve(__dirname, "../../docs/docs/features/debugging.mdx");
const CHROMIUM_REFERENCE = path.join(SKILLS, "argent-device-interact/references/chromium.md");

const restartAppTool = createRestartAppTool({} as unknown as Registry);
const debuggerStatusTool = createDebuggerStatusTool({} as unknown as Registry);
const logRegistryTool = createDebuggerLogRegistryTool({} as unknown as Registry);
const bootDeviceParams = createBootDeviceTool({} as unknown as Registry).zodSchema as unknown as {
  shape: Record<
    string,
    { description?: string; unwrap?: () => { minValue?: number | null; maxValue?: number | null } }
  >;
};

/** The bound zod enforces, so the prose stating it cannot drift off the parser. */
function bootTimeoutBound(which: "minValue" | "maxValue"): number {
  const bound = bootDeviceParams.shape.bootTimeoutMs?.unwrap?.()[which];
  // zod reports ±Infinity for an absent bound, so a finiteness check is what
  // separates "declared" from "gone"; `any(Number)` admits both.
  expect(
    typeof bound === "number" && Number.isFinite(bound),
    `bootTimeoutMs declares a finite ${which}, got ${String(bound)}`
  ).toBe(true);
  return bound as number;
}
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
      // The field AND the instruction attached to it, in one needle. Split, the
      // two are satisfied by a surface that names the guidance and then tells the
      // reader to discard it, which is the shape a rewrite reaches for — and the
      // needle has to refuse its own negation, since "do not follow the guidance"
      // contains it. The discarding synonyms are barred by expectNoForbiddenAdvice.
      expect(norm, `${where}: tells the reader to follow that field`).toMatch(
        /(?<!\b(?:do not|don't|never|cannot|can't) )follow the guidance/
      );
      // And that the quit is not the agent's to make. The relaunch can be: on the
      // Electron branch it is boot-device. The reason why — boot-device only ever
      // starts an app — is stated in the guidance these surfaces delegate to;
      // restating it here is what grew the five copies.
      expect(norm, `${where}: the quit is the user's`).toMatch(
        /the quit is the user's|ask the user to quit/
      );
      // Only the flat form these surfaces carried. A surface that splits the two
      // correctly ("for a browser the relaunch is the user's too, for Electron it
      // is boot-device") is saying what CHROMIUM_RELAUNCH says.
      expect(norm, `${where}: does not hand every relaunch to the user`).not.toMatch(
        /the relaunch is the user's move/
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

  it("sweeps whole files, so advice one line off a pinned row is still caught", () => {
    // Everything above hands the check a single row or a tool description, which
    // leaves the rest of each file unread - and the recovery's largest blocks are
    // paragraphs, not rows. Every pattern stops at a newline, so a whole file is
    // the same check run once per line; the loop is only for the line number.
    for (const file of [
      DEBUGGER_SKILL,
      FAILURE_SCENARIOS,
      DEVICE_INTERACT_SKILL,
      CHROMIUM_REFERENCE,
      CREATE_FLOW_RECOVERY,
      ARGENT_RULE,
      TOOLS_REFERENCE,
      DEBUGGING_FEATURE,
      INTERACTING_FEATURE,
    ]) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => expectNoForbiddenAdvice(line, `${path.basename(file)}:${i + 1}`));
    }
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
    // Its own sentence, not the row above: the row satisfies any whole-file
    // pattern loose enough to match the section, so the needle has to be the
    // wording only section 3 has.
    pinsOnce(
      deviceInteract,
      "On Chromium there is no home screen and no other app to start: navigate with " +
        "`open-url`, since `launch-app` only confirms the running renderer and starts nothing."
    );
  });

  it("names the surface a Chromium reader can actually use for discovery", () => {
    // gesture-swipe declares no chromium and the gate rejects it there, so the
    // shared-surface summary may not count scrolling among the verbs that carry
    // over. The literal cannot see gesture-swipe gaining chromium support, so the
    // capability is held too.
    expect(gestureSwipeTool.capability?.chromium, gestureSwipeTool.id).toBeUndefined();
    pinsOnce(
      readFileSync(DEVICE_INTERACT_SKILL, "utf8"),
      "describe/tap/keyboard/screenshot surface drives it, but scrolling, tabs, cookies and " +
        "storage differ"
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
    // `force` never reaches it (#867). No guidance advises the flag and the schema
    // still accepts it, so the description is the only place that says so.
    pinsOnce(bootDeviceParams.shape.force?.description, "Ignored on Chromium");
  });

  it("states the Electron readiness bound the loop actually enforces", () => {
    // waitForCdpReady re-checks its deadline only between attempts and passes no
    // AbortSignal, so one hanging fetch runs past it: the deadline is what the loop
    // checks, not a bound it holds the fetch to.
    const description = bootDeviceParams.shape.bootTimeoutMs?.description ?? "";
    expect(description).toContain(`${DEFAULT_READY_TIMEOUT_MS / 1000}s deadline`);
    expect(description, "zod rejects rather than clamps").not.toMatch(/clamp/i);
    // Derived from the schema's own bounds: a widened .min/.max leaves the
    // sentence stating a range the parser no longer enforces.
    pinsOnce(
      description,
      `Rejected outside [${bootTimeoutBound("minValue") / 1000}s, ` +
        `${bootTimeoutBound("maxValue") / 60_000}min]`
    );
  });
});

describe("the prose derives what the code decides", () => {
  it("derives every copy of the probe set, on each surface that states one", () => {
    // rules/argent.md is loaded for every argent session, the debugger skill's
    // prerequisites paragraph is where an agent learns where a chromium-cdp-<port>
    // id comes from, list-devices' own description is the highest-traffic copy of
    // all, and configuration.mdx is the page a human reads - so a reader can meet
    // the probe set on any of the four. A restated set drifts wherever nothing
    // derives it, and adding a default port has to turn every copy red at once.
    const ports = defaultChromiumPorts();
    pinsOnce(
      readFileSync(ARGENT_RULE, "utf8"),
      "auto-discovered on port `" +
        ports.join("`, `") +
        "`, `ARGENT_CHROMIUM_PORTS` and the ports `boot-device` opened"
    );
    pinsOnce(
      readFileSync(DEBUGGER_SKILL, "utf8"),
      "auto-discovered by `list-devices` on `" +
        ports.join("`, `") +
        "`, `ARGENT_CHROMIUM_PORTS` and the ports `boot-device` opened)"
    );
    pinsOnce(
      listDevicesTool.description,
      `probing CDP debugging ports (${ports.join(", ")}, whatever ` +
        "ARGENT_CHROMIUM_PORTS=<comma-separated-ports> lists, and the ports boot-device " +
        "itself opened)"
    );
    pinsOnce(
      readFileSync(CONFIGURATION_REFERENCE, "utf8"),
      `Chromium apps, on top of \`${ports.join("`, `")}\` and the ports \`boot-device\` ` +
        "itself opened"
    );
  });

  it("pins the windowless failure on every tool that resolves the page service", () => {
    // chromium-tabs, chromium-cookies and chromium-storage all resolve
    // ChromiumCdp, whose factory calls discoverPrimaryPage - so all three die
    // before execute on an app that is up with no window, and all three close
    // with a "Fails if …" list that reads as complete. One of them saying so and
    // the other two not is how a reader concludes the device id is wrong.
    for (const tool of [chromiumTabsTool, chromiumCookiesTool, chromiumStorageTool]) {
      expect(tool.capability?.chromium, `${tool.id} is a Chromium tool`).toBeDefined();
      expect(tool.description, `${tool.id}: names the windowless failure`).toMatch(
        /up with no open tab\/window/
      );
      expect(tool.description, `${tool.id}: says the window is the user's`).toMatch(
        /ask the user to reopen a window/i
      );
      // These three name the windowless state, which is what the "relaunch there"
      // bar exists for; naming it and then offering a relaunch is the shape.
      expectNoForbiddenAdvice(tool.description, `${tool.id}'s description`);
      // And none of them generalises it: debugger-status and debugger-log-registry
      // are Chromium tools that resolve the same page service and answer with a
      // not_connected result there instead of failing, which is the carve-out the
      // tools reference states. A universal here contradicts it in one sentence.
      expect(tool.description, `${tool.id}: claims the failure for itself only`).not.toMatch(
        /every chromium tool/i
      );
    }
    for (const answers of [debuggerStatusTool, logRegistryTool])
      expect(
        answers.description,
        `${answers.id} is the counterexample the universal would swallow`
      ).toMatch(/Never fails when the runtime is simply unreachable|returns .*not_connected/i);
    // chromium-tabs is the tool that can PRODUCE the state the other two only
    // report: close() returns list() with no fallback when nothing is left, so
    // the last close succeeds into it. And on Electron the action that would
    // look like the way back is refused in every state, not only this one.
    pinsOnce(
      chromiumTabsTool.description,
      "Closing the last one succeeds and returns an empty list, leaving the app up with no " +
        "drivable page"
    );
    pinsOnce(
      chromiumTabsTool.description,
      "An Electron app has no browser-level target creation, so `new` is refused there in " +
        "every state"
    );
  });

  it("carves Chromium out on the two feature pages, for each tool the gate refuses", () => {
    // These are the public docs, and each sentence lists several agent actions of
    // which only some survive on Chromium. Derived from the capabilities so a tool
    // gaining or losing chromium support cannot leave the carve-out standing.
    for (const tool of [restartAppTool, reinstallAppTool, debuggerReloadMetroTool]) {
      expect(tool.capability?.chromium, `${tool.id} is refused on Chromium`).toBeUndefined();
    }
    expect(openUrlTool.capability?.chromium, "open-url is the one that survives").toBeDefined();
    // reinstall-app is the last member of restart-app's class to carry one, and
    // the feature page's "Argent does not reinstall a Chromium app" rests on it.
    pinsOnce(reinstallAppTool.description, "Not supported on Chromium: there is no install step");
    pinsOnce(
      readFileSync(INTERACTING_FEATURE, "utf8"),
      "Of these, only opening a URL survives on a Chromium app: the user quits it, and the " +
        "agent starts an Electron app again itself. Argent does not reinstall a Chromium app."
    );
    pinsOnce(
      readFileSync(DEBUGGING_FEATURE, "utf8"),
      "Of these, only opening a URL survives on a Chromium app: the user quits it, and the " +
        "agent starts an Electron app again itself."
    );
  });

  it("says chromium-tabs cannot reopen the window, where a tab reader reads it", () => {
    // The tool's own description says it; references/chromium.md is where the
    // interaction skill sends a reader for tabs, so the sentence has to hold
    // there too.
    pinsOnce(
      readFileSync(CHROMIUM_REFERENCE, "utf8"),
      "`" +
        chromiumTabsTool.id +
        "` (which needs an existing page, so it cannot reopen the " +
        "last window once it is closed)"
    );
  });

  it("says opening a tab is browser-only everywhere the action is advertised", () => {
    // Target.createTarget is a browser-level method an Electron app does not
    // have, so `new` is the one action of the four that no state on Electron
    // makes available - and both surfaces that list the four otherwise read as
    // offering it. A reader who believes them spends the call to find out.
    pinsOnce(chromiumTabsTool.description, "`new` is refused there in every state");
    pinsOnce(
      readFileSync(CHROMIUM_REFERENCE, "utf8"),
      "`new` is browser-only: an Electron app has no browser-level target creation"
    );
    pinsOnce(
      readFileSync(TOOLS_REFERENCE, "utf8"),
      "open a tab on a browser — an Electron app opens its own windows"
    );
  });

  it("tells a list-devices reader what a missing Chromium entry does not mean", () => {
    // Four recovery surfaces rest on this one fact, and this description is the
    // only place it is stated to a reader with no skill open.
    pinsOnce(listDevicesTool.description, "A missing Chromium entry does not mean the app exited");
    pinsOnce(listDevicesTool.description, "Keep the id boot-device returned.");
    expectNoForbiddenAdvice(listDevicesTool.description, "list-devices' description");
  });

  it("names the Chromium id shape on the two network tools\u2019 device_id", () => {
    // These two are the Chromium-capable half of the network pair; a device_id
    // description enumerating only UDID and serial reads as a platform list.
    for (const tool of [networkLogsTool, networkRequestTool]) {
      const shape = (
        tool.zodSchema as unknown as { shape: Record<string, { description?: string }> }
      ).shape;
      expect(tool.capability?.chromium, `${tool.id} is Chromium-capable`).toBeDefined();
      pinsOnce(shape.device_id?.description, "chromium-cdp-<port>");
      // The rest of the enumeration, held to the capability rather than to a
      // literal: it is a list of the platforms that can answer, so a platform
      // the gate admits and the list omits reads as one that cannot.
      for (const [platform, word] of [
        ["apple", "UDID"],
        ["android", "Android"],
        ["vega", "Vega"],
      ] as const) {
        if (!tool.capability?.[platform]) continue;
        expect(
          shape.device_id?.description,
          `${tool.id} accepts ${platform}, so its device_id names it`
        ).toContain(word);
      }
    }
  });

  it("answers every not-connected reason the debugger can report", () => {
    // The skill tells the agent to match debugger-status's coded `reason`
    // against this table, so a reason with no row is a reader with no recovery.
    const table = readFileSync(FAILURE_SCENARIOS, "utf8");
    const skill = readFileSync(DEBUGGER_SKILL, "utf8");
    for (const reason of DEBUGGER_NOT_CONNECTED_REASONS) {
      expect(skill, `${reason} is missing from SKILL.md's reason list`).toContain(`\`${reason}\``);
      // A row, not a mention: the reason has to reach the column that carries a
      // recovery. Prose elsewhere in the file satisfies a whole-file search while
      // leaving the reader with nothing to do.
      const rows = table
        .split("\n")
        .filter((line) => line.startsWith("|") && line.includes(reason));
      expect(rows, `${reason} has no row in failure-scenarios.md`).toHaveLength(1);
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
    // The tools reference carries the same list to a reader with no skill open,
    // and these two are the exception on it: every other Chromium-capable tool
    // fails on a windowless app, while these answer with the result above. A
    // paragraph that sweeps them in tells the reader the recovery it then sends
    // them to is unavailable.
    pinsOnce(
      readFileSync(TOOLS_REFERENCE, "utf8"),
      `except \`${debuggerStatusTool.id}\` and \`${logRegistryTool.id}\`, which answer ` +
        "with a `not_connected` result rather than failing"
    );
    // The one instruction attached to that list. Without it the reasons read as a
    // taxonomy, and the reason most likely to be retry-looped waits out a full CDP
    // timeout per send.
    pinsOnce(debuggerStatusTool.description, "Follow the guidance field — do not retry in a loop.");
  });

  it("keeps the reconnect row on the id the skill says a reconnect returns", () => {
    // debugger-connect refuses a udid once two devices share one Metro and hands
    // back a logicalDeviceId to re-target with, and a relaunch can move it. A row
    // that ends at the list-devices id sends the reader back through the refusal
    // the skill already told them about.
    const row = readFileSync(FAILURE_SCENARIOS, "utf8")
      .split("\n")
      .find((line) => line.startsWith("|") && line.includes("Was connected, then tool fails"));
    expect(row, "the row exists").toBeDefined();
    pinsOnce(row ?? "", "the `logicalDeviceId` that comes back");
    pinsOnce(
      readFileSync(DEBUGGER_SKILL, "utf8"),
      "use it as the `device_id` for every subsequent debugger call"
    );
  });

  it("answers both shapes the runtime_unresponsive row names in its symptom", () => {
    // That row's symptom column covers two surfaces at once: the `not_connected`
    // result, which carries `guidance` and a `detail`, and the raw throw from
    // every other debugger tool, which carries neither. A recovery written for
    // only the first sends a reader who arrived by the second looking for fields
    // that are not on their error, and misprices their wait: a throw is one send.
    const row = readFileSync(FAILURE_SCENARIOS, "utf8")
      .split("\n")
      .find((line) => line.startsWith("|") && line.includes("runtime_unresponsive"));
    const [, , symptom = "", recovery = ""] = (row ?? "").split("|").map((cell) => cell.trim());
    expect(symptom, "the symptom column names the code the throwing half fails with").toContain(
      FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT
    );
    pinsOnce(recovery, "Any other debugger tool throws instead");
    // The multi-timeout cost belongs to whichever call opens the session, not to
    // debugger-status: every other debugger tool declares the service, so the
    // registry resolves it - running the whole connect - before execute is
    // reached. Pricing a throw at one timeout tells the reader a retry is cheap
    // on exactly the call where it is not.
    pinsOnce(recovery, "its debugger service resolves before the tool runs");
    pinsOnce(recovery, "Once a session is up, one send is one timeout");
    // What the reader does with the two fields when both arrive. Without it the
    // row names a `guidance` field and leaves its relationship to the `detail`
    // beside it - which asks the user a question the guidance answers, and which
    // on Metro can report a pause the guidance defers to - for the reader to guess.
    pinsOnce(
      recovery,
      "on Metro it defers to that detail instead — both where the detail reports a pause " +
        "and where it says one would not have been announced"
    );
    expect(recovery, "and says the throw carries neither field").toMatch(
      /no `guidance` and no `detail`/
    );
  });
});
