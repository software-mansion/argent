import { describe, it, expect, beforeEach, vi } from "vitest";
import type { McpConfigAdapter } from "../src/mcp-configs.js";

const prompt = vi.hoisted(() => ({ answer: true as unknown, asked: 0 }));

vi.mock("@clack/prompts", () => ({
  log: { info: vi.fn(), message: vi.fn(), warn: vi.fn() },
  confirm: vi.fn(async () => {
    prompt.asked++;
    return prompt.answer;
  }),
  isCancel: vi.fn((v: unknown) => typeof v === "symbol"),
}));

const { configureAllowlist } = await import("../src/init-allowlist.js");

function fakeAdapter(overrides: Partial<McpConfigAdapter> = {}): McpConfigAdapter {
  return {
    name: "Editor",
    globalPath: () => "/config.json",
    projectPath: () => null,
    addAllowlist: vi.fn(),
    ...overrides,
  } as unknown as McpConfigAdapter;
}

function run(adapter: McpConfigAdapter, opts: { nonInteractive?: boolean; noAllowlist?: boolean }) {
  return configureAllowlist({
    adapters: [adapter],
    effectiveRoot: "/project",
    scope: "global",
    nonInteractive: opts.nonInteractive ?? false,
    noAllowlist: opts.noAllowlist,
  });
}

beforeEach(() => {
  prompt.answer = true;
  prompt.asked = 0;
});

describe("configureAllowlist", () => {
  it("--no-allowlist skips without asking, also with -y", async () => {
    const adapter = fakeAdapter();
    const result = await run(adapter, { nonInteractive: true, noAllowlist: true });
    expect(result).toMatchObject({ enabled: false, decidedBy: "flag" });
    expect(prompt.asked).toBe(0);
    expect(adapter.addAllowlist).not.toHaveBeenCalled();
  });

  it("-y enables by default", async () => {
    const adapter = fakeAdapter();
    const result = await run(adapter, { nonInteractive: true });
    expect(result).toMatchObject({ enabled: true, decidedBy: "default" });
    expect(adapter.addAllowlist).toHaveBeenCalledOnce();
  });

  it("reports the prompt answer", async () => {
    prompt.answer = false;
    const result = await run(fakeAdapter(), {});
    expect(result).toMatchObject({ enabled: false, decidedBy: "prompt" });
    expect(prompt.asked).toBe(1);
  });

  it("reports an adapter's skip reason instead of writing", async () => {
    const adapter = fakeAdapter({ allowlistSkipReason: () => "would break the editor" });
    const result = await run(adapter, { nonInteractive: true });
    expect(adapter.addAllowlist).not.toHaveBeenCalled();
    expect(result.lines.join("\n")).toContain("skipped - would break the editor");
  });

  it("reports a failed allowlist check and continues with the next editor", async () => {
    const cursor = fakeAdapter({
      name: "Cursor",
      allowlistSkipReason: () => {
        throw new Error("EISDIR");
      },
    });
    const nextEditor = fakeAdapter();
    const result = await configureAllowlist({
      adapters: [cursor, nextEditor],
      effectiveRoot: "/project",
      scope: "global",
      nonInteractive: true,
    });

    expect(cursor.addAllowlist).not.toHaveBeenCalled();
    expect(nextEditor.addAllowlist).toHaveBeenCalledOnce();
    expect(result.lines).toEqual([
      expect.stringMatching(/Cursor: .*Error: EISDIR/),
      expect.stringContaining("Editor"),
    ]);
  });
});
