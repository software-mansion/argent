import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { Registry } from "@argent/registry";
import { createRestartAppTool } from "../../src/tools/restart-app";

const SKILLS = path.resolve(__dirname, "../../../skills/skills");

function row(file: string, prefix: string): string {
  const line = readFileSync(path.join(SKILLS, file), "utf8")
    .split("\n")
    .find((l) => l.startsWith(prefix));
  expect(line, `${file} has no row starting ${prefix}`).toBeDefined();
  return line!;
}

describe("skill rows that recommend restart-app", () => {
  it("scope it away from Chromium, which restart-app refuses, and give Chromium its relaunch", async () => {
    const registry = new Registry();
    registry.registerTool(createRestartAppTool(registry));
    await expect(
      registry.invokeTool("restart-app", { udid: "chromium-cdp-9222", bundleId: "x" })
    ).rejects.toThrow(/no chromium support declared/);

    const wasConnected = row(
      "argent-metro-debugger/references/failure-scenarios.md",
      "| **Was connected, then tool fails**"
    );
    const restartSentence = wasConnected.split(". ").find((s) => s.includes("`restart-app`"));
    expect(restartSentence).toMatch(/^On iOS, Android or Vega,/);
    expect(wasConnected).toMatch(/On Chromium, [^.]*`boot-device` with `electronAppPath`/);

    expect(row("argent-device-interact/SKILL.md", "| Restart an app")).toContain("Not on Chromium");
  });
});
