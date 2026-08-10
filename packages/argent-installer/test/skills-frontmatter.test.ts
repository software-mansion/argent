import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

const skillsDir = fileURLToPath(new URL("../../skills/skills/", import.meta.url));

function bundledSkills(): { name: string; filePath: string }[] {
  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, filePath: path.join(skillsDir, entry.name, "SKILL.md") }))
    .filter((entry) => fs.existsSync(entry.filePath));
}

function frontmatterOf(filePath: string): string | undefined {
  return fs.readFileSync(filePath, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
}

describe("bundled skill frontmatter", () => {
  it("parses every SKILL.md YAML block", () => {
    const skills = bundledSkills();

    expect(skills.length).toBeGreaterThan(0);
    for (const { filePath } of skills) {
      const frontmatter = frontmatterOf(filePath);
      expect(frontmatter, `${filePath} is missing YAML frontmatter`).toBeDefined();
      expect(
        () => parseYaml(frontmatter!),
        `${filePath} has invalid YAML frontmatter`
      ).not.toThrow();
    }
  });

  // The frontmatter `name` — not the directory — is a skill's install identity:
  // `skills add` installs to `.agents/skills/<frontmatter name>` and writes that
  // as the lock key, and `readBundledSkillName` reads it back for uninstall.
  // `refreshArgentSkills` then compares lock keys against `listBundledSkills()`,
  // which is directory names, and prunes everything tracked but not bundled. So
  // a skill whose two names disagree installs, is immediately classified
  // orphaned, and is removed on the next `argent init`/update — visible to the
  // user only as a prune line.
  it("names every skill after its own directory", () => {
    const skills = bundledSkills();

    expect(skills.length).toBeGreaterThan(0);
    for (const { name, filePath } of skills) {
      const frontmatter = frontmatterOf(filePath);
      const data = parseYaml(frontmatter!) as { name?: unknown } | null;
      expect(
        data?.name,
        `${filePath} frontmatter name must equal its directory name "${name}", or the skill ` +
          `installs under one name and is pruned as an orphan of the other`
      ).toBe(name);
    }
  });
});
