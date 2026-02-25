import { Registry } from "@radon-lite/registry";
import { simulatorServerBlueprint } from "./blueprints/simulator-server";
import type { SimulatorServerApi } from "./blueprints/simulator-server";
import { listSimulatorsTool } from "./tools/list-simulators";
import { bootSimulatorTool } from "./tools/boot-simulator";
import { simulatorServerInputSchema } from "./tools/simulator-server";
import { zodObjectToJsonSchema } from "./zod-to-json-schema";

export function createRegistry(): Registry {
  const registry = new Registry();

  registry.registerBlueprint(simulatorServerBlueprint);

  registry.registerTool({
    id: "list-simulators",
    description: listSimulatorsTool.description,
    inputSchema: zodObjectToJsonSchema(listSimulatorsTool.inputSchema),
    services: () => ({}),
    async execute(_services, params) {
      return listSimulatorsTool.execute(params ?? {}, undefined);
    },
  });

  registry.registerTool({
    id: "boot-simulator",
    description: bootSimulatorTool.description,
    inputSchema: zodObjectToJsonSchema(bootSimulatorTool.inputSchema),
    services: () => ({}),
    async execute(_services, params) {
      return bootSimulatorTool.execute(
        params as unknown as { udid: string },
        undefined
      );
    },
  });

  registry.registerTool({
    id: "simulator-server",
    description:
      "Launch (or reuse) the simulator-server process for a given simulator UDID and return its API and stream URLs",
    inputSchema: zodObjectToJsonSchema(simulatorServerInputSchema),
    services: (params: { udid: string; token?: string }) => ({
      simulatorServer: {
        urn: `SimulatorServer:${params.udid}`,
        options: { token: params.token },
      },
    }),
    async execute(services, params) {
      const api = services.simulatorServer as SimulatorServerApi;
      const p = params as unknown as { udid: string };
      return {
        udid: p.udid,
        apiUrl: api.apiUrl,
        streamUrl: api.streamUrl,
      };
    },
  });

  return registry;
}
