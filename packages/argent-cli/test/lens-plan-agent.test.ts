import { describe, it, expect, vi, beforeEach } from "vitest";

// planAgent reads the remembered agent from config and the installed set from
// the agent registry. Mock both so the test drives the decision deterministically
// without touching ~/.argent or PATH. The agent fixtures are `vi.hoisted` so the
// mock factories (hoisted above normal `const`s) can reference them.
const { claude, codex } = vi.hoisted(() => ({
  claude: { id: "claude", displayName: "Claude Code", bin: "claude", launch: () => "" },
  codex: { id: "codex", displayName: "Codex CLI", bin: "codex", launch: () => "" },
}));

vi.mock("@argent/configuration-core", () => ({
  isFlagEnabled: vi.fn(),
  getRememberedAgent: vi.fn(),
  setRememberedAgent: vi.fn(),
  clearRememberedAgent: vi.fn(),
}));

vi.mock("../src/lens-agents.js", () => ({
  AGENTS: [claude, codex],
  detectInstalledAgents: vi.fn(),
  findAgentById: (id: string) => [claude, codex].find((a) => a.id === id),
  isAgentInstalled: vi.fn(() => true),
  agentIds: () => ["claude", "codex"],
}));

import { planAgent } from "../src/lens.js";
import { getRememberedAgent } from "@argent/configuration-core";
import { detectInstalledAgents } from "../src/lens-agents.js";

const mockRemembered = vi.mocked(getRememberedAgent);
const mockInstalled = vi.mocked(detectInstalledAgents);

beforeEach(() => {
  mockRemembered.mockReset();
  mockInstalled.mockReset();
});

describe("planAgent — remembered preference", () => {
  it("uses a remembered agent that is still installed, skipping the picker", () => {
    mockInstalled.mockReturnValue([claude, codex]);
    mockRemembered.mockReturnValue("codex");
    expect(planAgent(undefined)).toEqual({ agent: codex });
  });

  it("falls back to the window picker when the remembered agent is NOT installed", () => {
    mockInstalled.mockReturnValue([claude, codex]);
    mockRemembered.mockReturnValue("gemini"); // not in the installed set
    expect(planAgent(undefined)).toEqual({ choose: [claude, codex] });
  });

  it("ignores the remembered agent when --agent is given explicitly", () => {
    mockInstalled.mockReturnValue([claude, codex]);
    mockRemembered.mockReturnValue("codex");
    expect(planAgent("claude")).toEqual({ agent: claude });
    // --agent resolves before the remembered lookup runs at all.
    expect(mockRemembered).not.toHaveBeenCalled();
  });

  it("auto-resolves a single install regardless of an absent remembered pick", () => {
    mockInstalled.mockReturnValue([claude]);
    mockRemembered.mockReturnValue(null);
    expect(planAgent(undefined)).toEqual({ agent: claude });
  });
});
