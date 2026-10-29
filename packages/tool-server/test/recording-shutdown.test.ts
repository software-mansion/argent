import { Registry, TypedEventEmitter, ServiceState } from "@argent/registry";
import { afterEach, expect, it, vi } from "vitest";
import { createRunSequenceTool } from "../src/tools/run-sequence";
import { beginRecordingShutdown } from "../src/utils/recording-shutdown";

afterEach(() => vi.useRealTimers());

it("disposes later services while a recording is still encoding and bounds the shutdown wait", async () => {
  vi.useFakeTimers();
  const registry = new Registry();
  let finish!: () => void;
  const encoding = new Promise<void>((resolve) => {
    finish = resolve;
  });
  registry.registerBlueprint({
    namespace: "ScreenRecordingSession",
    getURN: () => "ScreenRecordingSession:device",
    factory: async () => ({ api: {}, events: new TypedEventEmitter(), dispose: () => encoding }),
  });
  const laterDispose = vi.fn(async () => {});
  registry.registerBlueprint({
    namespace: "Later",
    getURN: () => "Later:device",
    factory: async () => ({ api: {}, events: new TypedEventEmitter(), dispose: laterDispose }),
  });
  await registry.resolveService("ScreenRecordingSession:device");
  await registry.resolveService("Later:device");
  const shutdown = beginRecordingShutdown(registry);
  expect(laterDispose).not.toHaveBeenCalled();
  await registry.dispose();
  expect(laterDispose).toHaveBeenCalledOnce();
  expect(registry.getSnapshot().services.get("ScreenRecordingSession:device")?.state).toBe(
    ServiceState.TERMINATING
  );
  let complete = false;
  void shutdown.then(() => {
    complete = true;
  });
  await vi.advanceTimersByTimeAsync(1_499);
  expect(complete).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await shutdown;
  finish();
  await encoding;
});

it("clears the shutdown deadline when recordings finish", async () => {
  vi.useFakeTimers();
  const registry = new Registry();
  registry.registerBlueprint({
    namespace: "ScreenRecordingSession",
    getURN: () => "ScreenRecordingSession:device",
    factory: async () => ({ api: {}, events: new TypedEventEmitter(), dispose: async () => {} }),
  });
  await registry.resolveService("ScreenRecordingSession:device");
  await beginRecordingShutdown(registry);
  expect(vi.getTimerCount()).toBe(0);
});

it("prevents a running sequence from recreating disposed services while an admitted stop finishes", async () => {
  const registry = new Registry();
  let finishRecording!: () => void;
  const encoding = new Promise<void>((resolve) => {
    finishRecording = resolve;
  });
  registry.registerBlueprint({
    namespace: "ScreenRecordingSession",
    getURN: () => "ScreenRecordingSession:device",
    factory: async () => ({ api: {}, events: new TypedEventEmitter(), dispose: () => encoding }),
  });
  const dispose = vi.fn(async () => {});
  const factory = vi.fn(async () => ({ api: {}, events: new TypedEventEmitter(), dispose }));
  registry.registerBlueprint({ namespace: "Later", getURN: () => "Later:device", factory });
  let finishStep!: () => void;
  const step = new Promise<void>((resolve) => {
    finishStep = resolve;
  });
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  registry.registerTool({
    id: "keyboard",
    services: () => ({ service: "Later:device" }),
    execute: async () => {
      enter();
      await step;
      return { ok: true };
    },
  });
  registry.registerTool(createRunSequenceTool(registry));
  registry.registerTool({
    id: "screen-recording-stop",
    services: () => ({ session: "ScreenRecordingSession:device" }),
    execute: async () => {
      await encoding;
      return { video: "saved.mp4" };
    },
  });
  await registry.resolveService("ScreenRecordingSession:device");
  const stopping = registry.invokeTool("screen-recording-stop");
  const sequence = registry.invokeTool<{ completed: number; steps: unknown[] }>("run-sequence", {
    udid: "11111111-1111-1111-1111-111111111111",
    steps: [
      { tool: "keyboard", args: { text: "first" }, delayMs: 0 },
      { tool: "keyboard", args: { text: "second" }, delayMs: 0 },
    ],
  });
  await entered;
  registry.beginShutdown();
  const shutdown = beginRecordingShutdown(registry);
  await registry.dispose();
  expect(dispose).toHaveBeenCalledOnce();
  finishStep();
  await expect(sequence).rejects.toThrow("The registry is shutting down.");
  expect(factory).toHaveBeenCalledOnce();
  expect(registry.getServiceState("Later:device")).toBe(ServiceState.IDLE);
  finishRecording();
  expect(await stopping).toEqual({ video: "saved.mp4" });
  await shutdown;
});

it("includes a recording still initializing in the independent shutdown", async () => {
  const registry = new Registry();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const dispose = vi.fn(async () => {});
  registry.registerBlueprint({
    namespace: "ScreenRecordingSession",
    getURN: () => "ScreenRecordingSession:device",
    factory: async () => {
      await pending;
      return { api: {}, events: new TypedEventEmitter(), dispose };
    },
  });
  const starting = registry
    .resolveService("ScreenRecordingSession:device")
    .catch((err: Error) => err);
  expect(registry.getServiceState("ScreenRecordingSession:device")).toBe(ServiceState.STARTING);
  await beginRecordingShutdown(registry);
  expect(registry.getServiceState("ScreenRecordingSession:device")).toBe(ServiceState.IDLE);
  finish();
  expect(await starting).toBeInstanceOf(Error);
  expect(dispose).toHaveBeenCalledOnce();
});
