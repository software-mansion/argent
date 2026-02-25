import express, { Request, Response } from "express";
import type { Registry } from "@radon-lite/registry";
import { ToolNotFoundError } from "@radon-lite/registry";
import { z } from "zod";
import { listSimulatorsTool } from "./tools/list-simulators";
import { bootSimulatorTool } from "./tools/boot-simulator";
import { simulatorServerInputSchema } from "./tools/simulator-server";

const toolInputSchemas: Record<string, z.ZodTypeAny> = {
  "list-simulators": listSimulatorsTool.inputSchema,
  "boot-simulator": bootSimulatorTool.inputSchema,
  "simulator-server": simulatorServerInputSchema,
};

export function createHttpApp(registry: Registry): express.Application {
  const app = express();
  app.use(express.json());

  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (_req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.get("/registry/snapshot", (_req: Request, res: Response) => {
    const snapshot = registry.getSnapshot();
    const services: Record<string, { state: string; dependents: string[] }> =
      {};
    for (const [urn, data] of snapshot.services) {
      services[urn] = { state: data.state, dependents: [...data.dependents] };
    }
    res.json({
      services,
      namespaces: snapshot.namespaces,
      tools: snapshot.tools,
    });
  });

  app.get("/tools", (_req: Request, res: Response) => {
    const snapshot = registry.getSnapshot();
    const tools = snapshot.tools.map((id) => {
      const def = registry.getTool(id);
      return {
        name: id,
        description: def?.description ?? "",
        inputSchema: def?.inputSchema ?? { type: "object", properties: {} },
      };
    });
    res.json({ tools });
  });

  app.post("/tools/:name", async (req: Request, res: Response) => {
    const name = req.params.name!;
    const schema = toolInputSchemas[name];
    if (!schema) {
      res.status(404).json({ error: `Tool "${name}" not found` });
      return;
    }

    const parseResult = schema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ error: parseResult.error.message });
      return;
    }

    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });

    try {
      const data = await registry.invokeTool(name, parseResult.data, {
        signal: controller.signal,
      });
      res.json({ data });
    } catch (err: unknown) {
      if (err instanceof ToolNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  return app;
}
