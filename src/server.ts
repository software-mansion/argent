import express from "express";
import { Config } from "./types/index";
import { SimulatorService } from "./services/SimulatorService";
import { SessionManager } from "./services/SessionManager";
import { createSimulatorsRouter } from "./routes/simulators";
import { createSessionsRouter } from "./routes/sessions";

export function createServer(config: Config): express.Application {
  const app = express();

  app.use(express.json());

  // Basic CORS for local API access
  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    next();
  });

  const simulatorService = new SimulatorService();
  const sessionManager = new SessionManager();

  // GET /config
  app.get("/config", (_req, res) => {
    res.json(config);
  });

  // GET /fingerprint
  app.get("/fingerprint", async (_req, res) => {
    try {
      const fingerprint = await simulatorService.getFingerprint();
      res.json({ fingerprint });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /token/verify
  app.post("/token/verify", async (req, res) => {
    const { token } = req.body as { token?: string };
    if (!token) {
      res.status(400).json({ error: "token is required" });
      return;
    }
    try {
      const result = await simulatorService.verifyToken(token);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /token/activate — exchange a Radon license key for a JWT
  app.post("/token/activate", async (req, res) => {
    const { licenseKey, name = "radon-lite" } = req.body as {
      licenseKey?: string;
      name?: string;
    };
    if (!licenseKey) {
      res.status(400).json({ error: "licenseKey is required" });
      return;
    }
    try {
      const fingerprint = await simulatorService.getFingerprint();
      const response = await fetch("https://portal.ide.swmansion.com/api/create-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fingerprint, name, licenseKey }),
      });
      const body = await response.json() as { token?: string; code?: string; message?: string };
      if (!response.ok || !body.token) {
        res.status(response.status).json({ error: body.message ?? body.code ?? "Activation failed" });
        return;
      }
      // Verify the returned JWT works with the binary
      const verification = await simulatorService.verifyToken(body.token);
      res.json({ token: body.token, ...verification });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.use("/simulators", createSimulatorsRouter(simulatorService));
  app.use("/sessions", createSessionsRouter(sessionManager, config));

  return app;
}
