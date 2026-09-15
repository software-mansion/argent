import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const rulesFile = fileURLToPath(new URL("../../skills/rules/argent.md", import.meta.url));
const skillsDir = fileURLToPath(new URL("../../skills/skills/", import.meta.url));

function routingEntry(skill: string): string {
  const rules = fs.readFileSync(rulesFile, "utf8");
  const entry = rules.match(new RegExp(String.raw`^Skill: \`${skill}\`\r?\n(When: .*)$`, "m"))?.[1];
  expect(entry, `rules/argent.md has no "When:" line for ${skill}`).toBeDefined();
  return entry!;
}

function skillDescription(skill: string): string {
  const source = fs.readFileSync(`${skillsDir}${skill}/SKILL.md`, "utf8");
  const description = source.match(/^description: (.*)$/m)?.[1];
  expect(description, `${skill}/SKILL.md has no frontmatter description`).toBeDefined();
  return description!;
}

// The routing rule is all an agent reads before choosing a skill, so a runtime
// the skill covers but the rule excludes is never reached.
describe("skill routing rule", () => {
  it("routes every runtime argent-device-interact covers", () => {
    const entry = routingEntry("argent-device-interact");
    const description = skillDescription("argent-device-interact");

    for (const runtime of ["iOS", "Android", "Chromium"]) {
      expect(description, `argent-device-interact must advertise ${runtime}`).toContain(runtime);
      expect(entry, `rules/argent.md routes argent-device-interact without ${runtime}`).toContain(
        runtime
      );
    }
  });
});
