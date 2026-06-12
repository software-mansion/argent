import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const SDK_BUNDLE = path.resolve(__dirname, "../dist/sdk.mjs");
const SDK_DTS = path.resolve(__dirname, "../dist/sdk.d.ts");

// The bundle only exists after `npm run build:bundles`; skip (rather than
// fail) so the suite stays runnable on a fresh checkout.
const bundleBuilt = fs.existsSync(SDK_BUNDLE);

describe.skipIf(!bundleBuilt)("dist/sdk.mjs (bundled SDK)", () => {
  it("exposes createArgent and the shared argent client", async () => {
    const mod = await import(SDK_BUNDLE);
    expect(typeof mod.createArgent).toBe("function");
    expect(mod.argent).toBeDefined();
  });

  it("dispatches camelCase methods and aliases to tool ids through an injected client", async () => {
    const { createArgent } = await import(SDK_BUNDLE);
    const calls: Array<{ name: string; args: unknown }> = [];
    const sdk = createArgent({
      client: {
        fetchTools: async () => [],
        fetchTool: async () => null,
        callTool: async (name: string, args: unknown) => {
          calls.push({ name, args });
          return { data: { ok: true } };
        },
        baseUrl: async () => ({ url: "http://127.0.0.1:0", token: "" }),
      },
    });

    await sdk.tap({ udid: "U", x: 0.5, y: 0.5 });
    await sdk.listDevices();
    expect(calls.map((c) => c.name)).toEqual(["gesture-tap", "list-devices"]);
    // Not thenable — `await sdk` must resolve to the client itself.
    expect((sdk as Record<string, unknown>)["then"]).toBeUndefined();
  });

  it("ships bundled type declarations next to the bundle", () => {
    expect(fs.existsSync(SDK_DTS)).toBe(true);
    const dts = fs.readFileSync(SDK_DTS, "utf8");
    expect(dts).toContain("export declare function createArgent");
    expect(dts).toContain('"gesture-tap": ToolDefinition<');
  });
});
