import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { resolveDevice } from "../src/utils/device-info";
import { devicesToPreviewEntries } from "../src/preview";
import { createProposeVariantTool } from "../src/tools/variants/propose-variant";
import type { Registry } from "@argent/registry";

/** The `udid` parameter description, read off the tool's own zod schema. */
function proposeVariantUdidDescription(): string {
  const tool = createProposeVariantTool({} as unknown as Registry);
  const shape = (tool.zodSchema as unknown as { shape: Record<string, { description?: string }> })
    .shape;
  return shape.udid?.description ?? "";
}

/**
 * The shipped skills and the argent rule are what an agent reads *before* it
 * calls anything, so a rule stated there decides behaviour that the code never
 * gets a say in. Three of them restate facts this feature changed — how a udid
 * maps to a platform, how to pick an iOS target, and which states count as
 * ready — and each was written when `platform: "ios"` could only mean a
 * simulator.
 *
 * Keyed off `resolveDevice` so the docs are checked against the classifier
 * rather than against a copy of it.
 */
const PHYSICAL_UDID = "00008120-000E6D0C0ABBA01E";
const SKILLS = path.resolve(__dirname, "../../skills");

const read = (rel: string) => readFileSync(path.join(SKILLS, rel), "utf8");

describe("agent-facing docs know a physical iPhone exists", () => {
  it("is a real classification, not a hypothetical", () => {
    // Anti-vacuity for everything below: if this ever stops being ios/device,
    // the doc assertions are guarding a rule that no longer applies.
    expect(resolveDevice(PHYSICAL_UDID)).toMatchObject({ platform: "ios", kind: "device" });
    expect(resolveDevice("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")).toMatchObject({
      kind: "simulator",
    });
  });

  it("device-interact's udid-shape dispatch rule covers the hardware shape", () => {
    // The rule is stated as an exhaustive mapping ending in "anything else →
    // Android adb serial", so a shape it omits is actively wrong, not merely
    // missing: an agent reasoning from it files a hardware udid under Android.
    const dispatch = read("skills/argent-device-interact/SKILL.md")
      .split("\n")
      .find((l) => l.includes("auto-dispatch iOS vs Android based on its shape"));
    expect(dispatch, "the dispatch sentence must still be findable").toBeDefined();
    expect(dispatch).toMatch(/physical iPhone/i);
  });

  it("the iOS setup skill tells the reader to filter on kind", () => {
    // Its step 1 is "filter for platform: ios, booted first". A connected iPhone
    // is a platform: ios entry that ranks as ready, so on a machine with no
    // booted simulator the literal procedure selects the phone.
    const setup = read("skills/argent-ios-simulator-setup/SKILL.md");
    const step = setup.split("2. **Verify connection**")[0]!;
    expect(step).toMatch(/kind: "simulator"/);
    expect(step).toMatch(/physical iPhone/i);
  });

  it("propose_variant does not offer the preview a target it filters out", () => {
    // `devicesToPreviewEntries` is the whitelist behind /preview/simulator-server/:udid and
    // deliberately drops a physical iPhone, so a round captured on one opens a window that 400s on
    // connect. The tool's own udid description is where the caller is told which device to pass.
    const physicalEntry = {
      platform: "ios",
      kind: "device",
      udid: PHYSICAL_UDID,
      name: "Real iPhone",
      state: "connected",
    };
    expect(
      devicesToPreviewEntries([physicalEntry] as never),
      "the preview whitelist must still exclude it"
    ).toEqual([]);
    expect(proposeVariantUdidDescription()).toMatch(/physical iPhone is not a preview target/i);
  });

  it("the argent rule's readiness list includes the state hardware reports", () => {
    // `list-devices` ranks a physical iPhone ready on `state: "connected"`, a
    // value the rule's per-platform enumeration did not contain.
    const rule = read("rules/argent.md")
      .split("\n")
      .find((l) => l.includes("**Prefer a running device.**"));
    expect(rule, "the readiness rule must still be findable").toBeDefined();
    expect(rule).toMatch(/connected/);
    expect(rule).toMatch(/kind/);
  });
});
