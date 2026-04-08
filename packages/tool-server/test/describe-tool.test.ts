import { describe, expect, it, vi } from "vitest";
import type { AXServiceApi, AXDescribeResponse } from "../src/blueprints/ax-service";
import { createDescribeTool } from "../src/tools/interactions/describe";

function makeAXServiceApi(response: AXDescribeResponse): AXServiceApi {
  return {
    describe: async () => response,
    alertCheck: async () => response.alertVisible,
    ping: async () => true,
  };
}

function makeMockRegistry(options: { axService?: AXServiceApi }) {
  return {
    resolveService: vi.fn(async (urn: string) => {
      if (urn.startsWith("AXService:")) {
        if (options.axService) return options.axService;
        throw new Error("ax-service not available");
      }
      throw new Error(`unknown service: ${urn}`);
    }),
  } as any;
}

describe("describe tool", () => {
  it("returns elements from ax-service daemon", async () => {
    const axApi = makeAXServiceApi({
      alertVisible: false,
      screenFrame: { width: 440, height: 956 },
      elements: [
        {
          label: "General",
          frame: { x: 0.045, y: 0.337, width: 0.909, height: 0.046 },
          traits: ["button"],
        },
      ],
    });

    const registry = makeMockRegistry({ axService: axApi });
    const tool = createDescribeTool(registry);

    const result = await tool.execute({}, { udid: "SIM-1" });
    expect(result.role).toBe("AXGroup");
    expect(result.children[0]?.label).toBe("General");
    expect(result.children[0]?.role).toBe("AXButton");
  });

  it("returns dialog elements when alertVisible is true", async () => {
    const axApi = makeAXServiceApi({
      alertVisible: true,
      screenFrame: { width: 440, height: 956 },
      elements: [
        {
          label: "Allow Once",
          frame: { x: 0.1, y: 0.5, width: 0.8, height: 0.05 },
          traits: ["button"],
        },
        {
          label: "Don\u2019t Allow",
          frame: { x: 0.1, y: 0.56, width: 0.8, height: 0.05 },
          traits: ["button"],
        },
      ],
    });

    const registry = makeMockRegistry({ axService: axApi });
    const tool = createDescribeTool(registry);

    const result = await tool.execute({}, { udid: "SIM-1" });
    expect(result.children).toHaveLength(2);
    expect(result.children[0]?.label).toBe("Allow Once");
    expect(result.children[0]?.role).toBe("AXButton");
    expect(result.children[1]?.label).toBe("Don\u2019t Allow");
  });

  it("returns empty root when no elements are present", async () => {
    const axApi = makeAXServiceApi({
      alertVisible: false,
      elements: [],
    });

    const registry = makeMockRegistry({ axService: axApi });
    const tool = createDescribeTool(registry);

    const result = await tool.execute({}, { udid: "SIM-1" });
    expect(result.role).toBe("AXGroup");
    expect(result.children).toHaveLength(0);
  });

  it("ignores bundleId parameter and still uses ax-service", async () => {
    const axApi = makeAXServiceApi({
      alertVisible: false,
      screenFrame: { width: 440, height: 956 },
      elements: [
        {
          label: "Settings item",
          frame: { x: 0.05, y: 0.3, width: 0.9, height: 0.05 },
          traits: ["staticText"],
        },
      ],
    });

    const registry = makeMockRegistry({ axService: axApi });
    const tool = createDescribeTool(registry);

    const result = await tool.execute(
      {},
      { udid: "SIM-1", bundleId: "com.apple.Preferences" }
    );
    expect(result.children[0]?.label).toBe("Settings item");
  });

  it("throws when ax-service is unavailable", async () => {
    const registry = makeMockRegistry({});
    const tool = createDescribeTool(registry);

    await expect(tool.execute({}, { udid: "SIM-1" })).rejects.toThrow(
      "ax-service not available"
    );
  });

  it("returns multiple elements with correct roles", async () => {
    const axApi = makeAXServiceApi({
      alertVisible: false,
      screenFrame: { width: 440, height: 956 },
      elements: [
        {
          label: "Search",
          frame: { x: 0.05, y: 0.16, width: 0.9, height: 0.04 },
          traits: ["searchField"],
          value: "Search",
        },
        {
          label: "General",
          frame: { x: 0.05, y: 0.34, width: 0.9, height: 0.05 },
          traits: ["button", "staticText"],
        },
        {
          label: "Accessibility",
          frame: { x: 0.05, y: 0.4, width: 0.9, height: 0.05 },
          traits: ["button", "staticText"],
        },
      ],
    });

    const registry = makeMockRegistry({ axService: axApi });
    const tool = createDescribeTool(registry);

    const result = await tool.execute({}, { udid: "SIM-1" });
    expect(result.children).toHaveLength(3);
    expect(result.children[0]?.role).toBe("AXTextField");
    expect(result.children[0]?.value).toBe("Search");
    expect(result.children[1]?.role).toBe("AXButton");
    expect(result.children[2]?.label).toBe("Accessibility");
  });

  it("resolves ax-service with the correct URN", async () => {
    const axApi = makeAXServiceApi({
      alertVisible: false,
      elements: [],
    });

    const registry = makeMockRegistry({ axService: axApi });
    const tool = createDescribeTool(registry);

    await tool.execute({}, { udid: "ABC-12345" });
    expect(registry.resolveService).toHaveBeenCalledWith("AXService:ABC-12345");
  });
});
