import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { WebSocketServer } from "ws";
import * as http from "node:http";
import { Registry } from "@argent/registry";
import { jsRuntimeDebuggerBlueprint } from "../../src/blueprints/js-runtime-debugger";
import { debuggerConnectTool } from "../../src/tools/debugger/debugger-connect";
import { scopeTempHome } from "../helpers/temp-home";

scopeTempHome("argent-connect-failure-home-");

// The log writer is built after every CDP setup call, so a throw there is the latest failure.
const logWriterFails = vi.hoisted(() => ({ value: false }));
vi.mock("../../src/utils/debugger/log-file-writer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/debugger/log-file-writer")>();
  return {
    ...actual,
    LogFileWriter: class extends actual.LogFileWriter {
      constructor(port: number) {
        if (logWriterFails.value) throw new Error("log writer failed");
        super(port);
      }
    },
  };
});

/**
 * A connect that fails partway must not leave its socket open: the legacy
 * inspector keeps that debugger session, and the next connect's Runtime.enable
 * goes unanswered until the app restarts.
 */
let server: http.Server;
let wss: WebSocketServer;
let port: number;
/** The method the mock runtime rejects, its page title, and whether it advertises Fusebox. */
let rejected: string | null = "Runtime.enable";
let title = "Hermes React Native";
let fusebox = false;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = http.createServer((req, res) => {
      if (req.url === "/status") {
        res.end("packager-status:running");
        return;
      }
      if (req.url === "/json/list") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify([
            {
              id: "0-1",
              title,
              description: "com.example.app",
              vm: "Hermes",
              deviceName: "Pixel 7",
              webSocketDebuggerUrl: `ws://localhost:${port}/inspector/debug?device=0&page=1`,
              ...(fusebox
                ? { reactNative: { capabilities: { prefersFuseboxFrontend: true } } }
                : {}),
            },
          ])
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    wss = new WebSocketServer({ server });
    wss.on("connection", (ws) =>
      ws.on("message", (raw) => {
        const { id, method } = JSON.parse(raw.toString()) as { id: number; method: string };
        ws.send(
          JSON.stringify(
            method === rejected
              ? { id, error: { code: -32601, message: `${method} wasn't found` } }
              : { id, result: { result: { type: "string", value: "function" } } }
          )
        );
      })
    );
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
});

afterAll(async () => {
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolve) => wss.close(() => server.close(() => resolve())));
});

async function connectAndCountOpenSockets(
  expectedError: string | RegExp = `${rejected} wasn't found`
): Promise<number> {
  const registry = new Registry();
  registry.registerBlueprint(jsRuntimeDebuggerBlueprint);
  registry.registerTool(debuggerConnectTool);
  try {
    await expect(
      registry.invokeTool("debugger-connect", { port, device_id: "emulator-5554" })
    ).rejects.toThrow(expectedError);

    const deadline = Date.now() + 2_000;
    while (wss.clients.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    return wss.clients.size;
  } finally {
    await registry.dispose();
  }
}

describe("debugger-connect failing partway", () => {
  it.each(["Runtime.enable", "Debugger.enable", "Debugger.setPauseOnExceptions"])(
    "closes the socket it opened when %s fails",
    async (method) => {
      rejected = method;
      title = "Hermes React Native";
      fusebox = false;
      expect(await connectAndCountOpenSockets()).toBe(0);
    }
  );

  it("fails on a Fusebox target that rejects Runtime.addBinding", async () => {
    // A modern host rejects it only while it has no JS instance (mid-reload);
    // connecting then would write the binding off for the whole session.
    rejected = "Runtime.addBinding";
    title = "Hermes React Native";
    fusebox = true;
    expect(await connectAndCountOpenSockets()).toBe(0);
  });

  it("fails on RN 0.74's modern bridge page that rejects Runtime.addBinding", async () => {
    // `inspectorEnableModernCDPRegistry` lists this page without Fusebox; its
    // PageAgent rejects with -32601 while it has no instance, like Fusebox.
    rejected = "Runtime.addBinding";
    title = "React Native Bridge (Experimental)";
    fusebox = false;
    expect(await connectAndCountOpenSockets()).toBe(0);
  });

  it("closes the socket when a step after CDP setup throws", async () => {
    rejected = null;
    title = "Hermes React Native";
    fusebox = false;
    logWriterFails.value = true;
    try {
      expect(await connectAndCountOpenSockets("log writer failed")).toBe(0);
    } finally {
      logWriterFails.value = false;
    }
  });
});
