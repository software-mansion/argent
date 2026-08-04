import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

const skillsDir = fileURLToPath(new URL("../../skills/skills/", import.meta.url));

describe("bundled skill frontmatter", () => {
  it("parses every SKILL.md YAML block", () => {
    const skillFiles = fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(skillsDir, entry.name, "SKILL.md"))
      .filter((filePath) => fs.existsSync(filePath));

    expect(skillFiles.length).toBeGreaterThan(0);
    for (const filePath of skillFiles) {
      const content = fs.readFileSync(filePath, "utf8");
      const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
      expect(frontmatter, `${filePath} is missing YAML frontmatter`).toBeDefined();
      expect(
        () => parseYaml(frontmatter!),
        `${filePath} has invalid YAML frontmatter`
      ).not.toThrow();
    }
  });
});
