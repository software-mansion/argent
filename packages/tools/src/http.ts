import express, { Request, Response } from "express";
import { registry } from "./registry";

export function createHttpApp(): express.Application {
  const app = express();
  app.use(express.json());

  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (_req.method === 'OPTIONS') { res.sendStatus(204); return }
    next()
  })

  app.get("/tools", (_req: Request, res: Response) => {
    res.json({ tools: registry.list() });
  });

  app.post("/tools/:name", async (req: Request, res: Response) => {
    const tool = registry.get(req.params.name!);
    if (!tool) {
      res.status(404).json({ error: `Tool "${req.params.name}" not found` });
      return;
    }

    const parseResult = tool.inputSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ error: parseResult.error.message });
      return;
    }

    const controller = new AbortController();
    // Use res.on('close') + writableFinished guard: req.on('close') fires on
    // Node 22 as soon as the request body is consumed (not on real disconnect).
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });

    try {
      const data = await tool.execute(parseResult.data, controller.signal);
      res.json({ data });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  return app;
}
