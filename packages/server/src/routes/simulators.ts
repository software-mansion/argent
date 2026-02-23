import { Router, Request, Response } from "express";
import { SimulatorService } from "../services/SimulatorService";

export function createSimulatorsRouter(simulatorService: SimulatorService): Router {
  const router = Router();

  // GET /simulators
  router.get("/", async (_req: Request, res: Response) => {
    try {
      const simulators = await simulatorService.listAll();
      res.json(simulators);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /simulators/running
  router.get("/running", async (_req: Request, res: Response) => {
    try {
      const simulators = await simulatorService.listRunning();
      res.json(simulators);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /simulators/:udid/boot
  router.post("/:udid/boot", async (req: Request, res: Response) => {
    try {
      await simulatorService.boot(req.params.udid);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /simulators/:udid/shutdown
  router.post("/:udid/shutdown", async (req: Request, res: Response) => {
    try {
      await simulatorService.shutdown(req.params.udid);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
