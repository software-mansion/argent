/**
 * Registry-wide sweep of the physical-iPhone capability gate.
 *
 * `physical-ios-followups.test.ts` names the simulator-only tools one by one,
 * which pins each tool's own capability object but can only ever cover the
 * tools someone remembered to add. The gap that costs something is the tool
 * nobody lists: a simulator-only backend that a physical iPhone walks straight
 * into, failing deep inside `simctl` with a 500 instead of at the gate with a
 * 400. So this file derives the set from the registry instead of restating it,
 * and the "every simulator-only tool" claim holds by construction — including
 * for tools added after this was written.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolCapability } from "@argent/registry";
import { FLAG_REGISTRY } from "@argent/configuration-core";
import { createRegistry } from "../src/utils/setup-registry";
import { pasteTool } from "../src/tools/paste";
import { listDevicesTool } from "../src/tools/devices/list-devices";
import { resolveDevice } from "../src/utils/device-info";
import { assertSupported, UnsupportedOperationError } from "../src/utils/capability";

const PHYSICAL_UDID = "00008120-000E6D0C0ABBA01E";
const SIM_UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";

/**
 * Every tool the server can dispatch, keyed by id. `paste` is defined outside
 * `createRegistry` (macOS-only registration), so it is added explicitly — the
 * same reason `interaction-messages.test.ts` adds it to its catalog.
 */
function allCapabilities(): Map<string, ToolCapability | undefined> {
  const registry = createRegistry();
  const caps = new Map<string, ToolCapability | undefined>();
  for (const id of registry.getSnapshot().tools) {
    caps.set(id, registry.getTool(id)!.capability);
  }
  caps.set("paste", pasteTool.capability);
  return caps;
}

/** Declares iOS-simulator support and withholds physical-iPhone support. */
function isSimulatorOnly(cap: ToolCapability | undefined): boolean {
  return cap?.apple?.simulator === true && cap.apple.device !== true;
}

describe("physical-iPhone capability gate, swept across the registry", () => {
  const physical = resolveDevice(PHYSICAL_UDID);
  const sim = resolveDevice(SIM_UDID);

  it("rejects a physical iPhone from every simulator-only tool, keeping simulators working", () => {
    const simulatorOnly = [...allCapabilities()].filter(([, cap]) => isSimulatorOnly(cap));

    // Anti-vacuity: a derivation bug that yields an empty or tiny set would
    // otherwise pass this test while checking nothing. These four span the
    // distinct simulator-only backends — `simctl privacy`, `simctl spawn` +
    // DYLD injection, xctrace, and the single-contact digitizer limit — so
    // losing any whole family trips the membership check, not just the count.
    const ids = simulatorOnly.map(([id]) => id);
    for (const id of [
      "settings-permissions",
      "native-describe-screen",
      "native-profiler-start",
      "gesture-pinch",
    ]) {
      expect(ids, `${id} must be reached by the sweep`).toContain(id);
    }
    expect(simulatorOnly.length).toBeGreaterThanOrEqual(16);

    for (const [id, cap] of simulatorOnly) {
      expect(
        () => assertSupported(id, cap, physical),
        `${id} must reject a physical iPhone`
      ).toThrow(UnsupportedOperationError);
      expect(
        () => assertSupported(id, cap, sim),
        `${id} must still accept a simulator`
      ).not.toThrow();
    }
  });

  it("lets every tool that claims physical-iPhone support through the gate", () => {
    const physicalCapable = [...allCapabilities()].filter(([, cap]) => cap?.apple?.device === true);

    // The other direction of the same gate: a capability edited to `device:
    // true` must actually be reachable on hardware. Without this, narrowing
    // `assertSupported` (or `resolveDevice`'s kind classification) could shut
    // physical iOS off wholesale and only the sweep above would stay green.
    // `describe` and `screenshot` are the two tools everything else is built
    // on — an agent that can neither read the screen nor see it has no use for
    // the rest. Flipping either to `device: false` is the single most damaging
    // edit here, and nothing else in the suite names them on the physical side.
    const ids = physicalCapable.map(([id]) => id);
    expect(ids).toContain("describe");
    expect(ids).toContain("screenshot");
    expect(ids).toContain("gesture-tap");
    expect(physicalCapable.length).toBeGreaterThanOrEqual(10);

    for (const [id, cap] of physicalCapable) {
      expect(
        () => assertSupported(id, cap, physical),
        `${id} must accept a physical iPhone`
      ).not.toThrow();
    }
  });

  it("keeps the prose that describes the feature free of a hand-written tool list", () => {
    // Two places tell a user (or an agent) what a physical iPhone can do:
    // `argent flags`' blurb, and the physical-iOS line of `list-devices`'
    // description — the one an agent reads while picking a target. Nothing ties
    // either to the capability objects above, so a tool list spelled out in them
    // only stays true until the next capability edit: flipping one tool's
    // `apple.device` leaves them understating (or overstating) the feature with
    // the whole suite green. The enumeration belongs in the README's
    // physical-iOS section and in each tool's own capability, so neither piece
    // of prose may name a tool id at all.
    const flag = FLAG_REGISTRY.find((f) => f.name === "physical-ios-devices");
    expect(flag, "physical-ios-devices must stay in the flag registry").toBeDefined();

    const names = (text: string) =>
      [...allCapabilities().keys()].filter((id) => new RegExp(`\\b${id}\\b`).test(text));

    // Anti-vacuity: a matcher that never fires would pass the assertions below
    // while checking nothing.
    expect(names("Supports screenshot, tap, swipe, describe, and launch-app.")).toEqual(
      expect.arrayContaining(["screenshot", "describe", "launch-app"])
    );

    expect(names(flag!.description), "argent flags blurb").toEqual([]);

    // Scoped to the one line that describes physical iOS: the rest of
    // `list-devices`' description names tools on purpose (the TV paragraph
    // routes the reader to `tv-remote` and `describe`).
    const physicalLine = listDevicesTool
      .description!.split("\n")
      .filter((line) => line.includes("physical-ios-devices"));
    expect(physicalLine, "the physical-iOS line must still be findable").toHaveLength(1);
    expect(names(physicalLine[0]!), "list-devices description").toEqual([]);
  });

  it("keeps the README's supported list to tools hardware actually accepts", () => {
    // The flag blurb and the list-devices description both point here, so this
    // paragraph is the one place the set is written out — which makes it the one
    // place a tool can be advertised on hardware after being gated off it. The
    // check runs one way only: a tool missing from the prose is an omission, but
    // a tool named here that the gate rejects is a promise the product breaks.
    const readme = fs.readFileSync(path.join(__dirname, "..", "..", "..", "README.md"), "utf8");
    const section = readme.split("## Physical iOS devices (experimental)")[1];
    expect(section, "the physical-iOS section must still be findable").toBeDefined();
    const supported = section!
      .split("Supported interactions:")[1]!
      .split("The device shows up")[0]!;

    const caps = allCapabilities();
    const named = [...supported.matchAll(/`([a-z0-9-]+)`/g)]
      .map((m) => m[1]!)
      .filter((id) => caps.has(id));

    expect(named.length, "the supported list must still name tools").toBeGreaterThanOrEqual(15);
    for (const id of named) {
      expect(
        caps.get(id)?.apple?.device,
        `README lists ${id} as working on a physical iPhone, but its capability does not`
      ).toBe(true);
    }
  });

  it("leaves no devicectl-backed tool able to skip the opt-in gate", () => {
    // `simulatorServerRef` runs `assertPhysicalIosEnabled` for everything routed
    // through a CoreDevice service, so the flag covers those by construction. A
    // tool that shells `devicectl` builds no ref, and is therefore only gated by
    // its own call — which is easy to leave out, and leaves a physical-iOS
    // operation reachable with the feature disabled. Derived from the source so
    // the next devicectl-backed tool is covered without being listed.
    const toolsDir = path.join(__dirname, "..", "src", "tools");
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) sources.push(full);
      }
    };
    walk(toolsDir);

    const shellsDevicectl = sources.filter((f) => /"devicectl"/.test(fs.readFileSync(f, "utf8")));

    // Anti-vacuity: the four that exist today must be found, so a broken walk or
    // matcher cannot pass this by finding nothing. Deliberately not an exact
    // set — a fifth devicectl-backed tool should fail on the gate assertion
    // below, which names what is missing, rather than here on a list it was
    // never the point to maintain.
    expect(shellsDevicectl.map((f) => path.basename(path.dirname(path.dirname(f)))).sort()).toEqual(
      expect.arrayContaining(["launch-app", "open-url", "reinstall-app", "restart-app"])
    );

    for (const file of shellsDevicectl) {
      expect(
        fs.readFileSync(file, "utf8"),
        `${path.relative(toolsDir, file)} shells devicectl and must call assertPhysicalIosEnabled itself`
      ).toContain("assertPhysicalIosEnabled()");
    }
  });
});
