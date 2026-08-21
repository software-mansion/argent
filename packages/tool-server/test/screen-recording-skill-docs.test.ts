import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { createScreenRecordingStartTool } from "../src/tools/screen-recording/screen-recording-start";
import { screenRecordingStopTool } from "../src/tools/screen-recording/screen-recording-stop";

/**
 * The recording skill is what an agent reads before it records anything, so a
 * target listed there as **Unsupported** is never attempted — the capability
 * object underneath it is not consulted. That makes the skill's list, not the
 * capability, the thing that decides whether a device class is usable in
 * practice, and the two drifting apart costs the whole feature silently.
 *
 * `flow-skill-docs.test.ts` guards the create-flow skill's snippets against
 * parser drift for the same reason.
 */
const SKILL = path.resolve(__dirname, "../../skills/skills/argent-screen-recording/SKILL.md");

function bullet(startsWith: string): string {
  const line = readFileSync(SKILL, "utf8")
    .split("\n")
    .find((l) => l.startsWith(startsWith));
  expect(line, `no bullet starting with ${JSON.stringify(startsWith)} in SKILL.md`).toBeDefined();
  return line!;
}

describe("argent-screen-recording SKILL.md agrees with the tools' capabilities", () => {
  const startTool = createScreenRecordingStartTool({} as never);

  it("does not list a physical iPhone as unsupported while both tools accept one", () => {
    // Both halves matter: a start-only capability would leave a recording with
    // no way to stop it, so the skill may only advertise hardware when the pair
    // accepts it.
    expect(startTool.capability?.apple?.device).toBe(true);
    expect(screenRecordingStopTool.capability?.apple?.device).toBe(true);

    // Only the enumeration itself — the prose after the em-dash explains what to
    // do instead and legitimately names targets it does not exclude.
    const excluded = bullet("- **Unsupported**").split("—")[0]!;
    expect(excluded).not.toMatch(/physical iPhone/i);
    expect(bullet("- **What can be recorded**")).toMatch(/physical iPhone/i);
  });

  it("still lists the targets that have no frame stream", () => {
    // Anti-vacuity: an emptied or restructured bullet would pass the assertions
    // above by saying nothing at all.
    const unsupported = bullet("- **Unsupported**");
    for (const target of ["tvOS", "Chromium", "Vega", "remote"]) {
      expect(unsupported, `${target} must stay listed as unsupported`).toContain(target);
    }
  });
});
