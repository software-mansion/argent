import { describe, expect, it } from "vitest";
import {
  AGENTS,
  findAgentById,
  agentIds,
  isAgentInstalled,
  detectInstalledAgents,
} from "../src/lens-agents.js";

describe("AGENTS registry", () => {
  it("lists the supported CLIs with distinct ids and bins", () => {
    expect(agentIds()).toEqual(["claude", "codex", "gemini", "opencode", "cursor"]);
    const bins = AGENTS.map((a) => a.bin);
    expect(new Set(bins).size).toBe(bins.length);
    // Cursor's CLI binary is `cursor-agent`, not `cursor`.
    expect(bins).toContain("cursor-agent");
  });

  it("arg-mode agents embed the seed file via $(cat …)", () => {
    const claude = findAgentById("claude")!;
    const cmd = claude.launch("'/work dir'", "'/seed.txt'");
    expect(cmd).toContain("cd '/work dir'");
    expect(cmd).toContain(`claude "$(cat '/seed.txt')"`);
    expect(claude.injectSeed).toBeFalsy();

    expect(findAgentById("codex")!.launch("'/w'", "'/s'")).toContain(`codex "$(cat '/s')"`);
    expect(findAgentById("gemini")!.launch("'/w'", "'/s'")).toContain(`gemini -i "$(cat '/s')"`);
    expect(findAgentById("cursor")!.launch("'/w'", "'/s'")).toContain(`cursor-agent "$(cat '/s')"`);
  });

  it("inject-mode agents take no seed arg", () => {
    const opencode = findAgentById("opencode")!;
    expect(opencode.injectSeed).toBe(true);
    const cmd = opencode.launch("'/w'", "'/s'");
    expect(cmd).toContain("opencode");
    expect(cmd).not.toContain("$(cat");
  });

  it("findAgentById returns undefined for an unknown id", () => {
    expect(findAgentById("nope")).toBeUndefined();
  });
});

describe("agent detection", () => {
  it("uses the injected PATH probe", () => {
    const onPath = (bin: string): boolean => bin === "claude" || bin === "cursor-agent";
    expect(isAgentInstalled(findAgentById("claude")!, onPath)).toBe(true);
    expect(isAgentInstalled(findAgentById("codex")!, onPath)).toBe(false);
    expect(detectInstalledAgents(onPath).map((a) => a.id)).toEqual(["claude", "cursor"]);
  });

  it("detects none when nothing is on PATH", () => {
    expect(detectInstalledAgents(() => false)).toEqual([]);
  });

  it("preserves registry (preference) order in detection", () => {
    expect(detectInstalledAgents(() => true).map((a) => a.id)).toEqual(agentIds());
  });
});
