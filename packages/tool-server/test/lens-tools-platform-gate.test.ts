/**
 * Regression test for the macOS-only registration gate on the Argent Lens
 * tools. Unlike the feature-flag gate (which hides the tools at the HTTP
 * exposure layer), the platform gate skips REGISTRATION entirely off-darwin —
 * so on a non-macOS host the tools don't exist in the registry at all.
 *
 * `createRegistry` reads `process.platform` at construction, so each case
 * overrides it and re-imports the module fresh (vi.resetModules).
 */
import { describe, it, expect, afterEach, vi } from "vitest";

const realPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  vi.resetModules();
});

async function freshCreateRegistry() {
  vi.resetModules();
  return (await import("../src/utils/setup-registry")).createRegistry;
}

describe("Argent Lens tools — macOS-only registration gate", () => {
  it("registers propose_variant / await_user_selection on darwin", async () => {
    setPlatform("darwin");
    const createRegistry = await freshCreateRegistry();
    const registry = createRegistry();
    expect(registry.getTool("propose_variant")).toBeDefined();
    expect(registry.getTool("await_user_selection")).toBeDefined();
    // Sanity: a cross-platform tool is registered regardless.
    expect(registry.getTool("list-devices")).toBeDefined();
  });

  it("omits the Lens tools off-darwin (linux)", async () => {
    setPlatform("linux");
    const createRegistry = await freshCreateRegistry();
    const registry = createRegistry();
    expect(registry.getTool("propose_variant")).toBeUndefined();
    expect(registry.getTool("await_user_selection")).toBeUndefined();
    // The rest of the registry is unaffected.
    expect(registry.getTool("list-devices")).toBeDefined();
  });
});
