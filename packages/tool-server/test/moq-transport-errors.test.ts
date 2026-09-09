/**
 * The MoQ (cloud) input path must fail like the WebSocket one.
 *
 * Every send used to be dropped with `void`, so a rejection had no handler.
 * That cost twice: the tool answered `{ tapped: true }` for an input that was
 * never written, and, because `index.ts` turns an unhandled rejection into a
 * process kill, the tool server died a moment later, detached from the call
 * that caused it. Observed against a live cloud simulator: a `gesture-tap`
 * reported success in 51ms while `track is closed` was taking the server down.
 *
 * `simulator-command-ack.test.ts` covers the same guarantee on the WebSocket
 * path, which this file leaves untouched.
 */

import { describe, it, expect, vi } from "vitest";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import {
  createMoqTransport,
  sendCommand,
  type SimulatorServerTransport,
} from "../src/utils/simulator-client";
import type { MoqClient } from "../src/utils/moq-client";
import { gestureTapTool } from "../src/tools/gesture-tap";

vi.mock("../src/utils/moq-client", () => ({
  openMoqClient: () => Promise.resolve(closedMoqClient()),
}));

import {
  simulatorServerBlueprint,
  type SimulatorServerApi,
} from "../src/blueprints/simulator-server";

const UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";

const TOUCH = {
  cmd: "touch",
  type: "Down",
  x: 0.5,
  y: 0.5,
  second_x: null,
  second_y: null,
} as const;

/** What a released cloud machine actually throws from `sendControl`. */
const CLOSED = () => new Error("track is closed");

function apiWith(transport: SimulatorServerTransport): SimulatorServerApi {
  return {
    apiUrl: `moq+remote://${UDID}`,
    streamUrl: `moq+remote://${UDID}`,
    pressKey: () => Promise.resolve(),
    transport,
  };
}

/** A `MoqClient` whose control track is closed, as after the machine is released. */
function closedMoqClient(): MoqClient {
  return {
    sendControl: () => Promise.reject(CLOSED()),
    screenshot: () => Promise.reject(new Error("unexpected end of stream")),
    close: () => Promise.resolve(),
  };
}

/**
 * Node emits `unhandledRejection` once the microtask queue has drained with no
 * handler attached, which is exactly when the tool server's own handler would
 * fire. Watching for it is the regression guard for the crash itself: the
 * rejection being reported to the caller and the rejection not killing the
 * process are two different fixes, and only this one catches a send that is
 * awaited somewhere but still dropped on another branch.
 */
async function watchUnhandledRejections(run: () => Promise<unknown>): Promise<{
  outcome: unknown;
  unhandled: unknown[];
}> {
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", record);
  try {
    const outcome = await run().then(
      (value) => value,
      (error: unknown) => error
    );
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { outcome, unhandled };
  } finally {
    process.off("unhandledRejection", record);
  }
}

describe("sendCommand over a MoQ transport", () => {
  it("rejects with the transport failure the WebSocket path reports", async () => {
    const err = await sendCommand(
      apiWith(
        createMoqTransport(closedMoqClient(), {
          pasteText: () => Promise.resolve(),
        })
      ),
      { ...TOUCH }
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(getFailureSignal(err)).toMatchObject({
      error_code: FAILURE_CODES.SIMULATOR_COMMAND_TRANSPORT_FAILED,
      failure_stage: "simulator_command_transport",
      failure_area: "tool_server",
      error_kind: "network",
      network_failure: "connection_reset",
      failure_command: "simulator_server",
    });
    // The same promise every caller keys on: this command did not land.
    expect(String(err)).toContain("'touch'");
    expect(String(err)).toContain("NOT delivered to the device");
    // The underlying cause survives, so the log still names the real fault.
    expect(String(err)).toContain("track is closed");
  });

  it("resolves when the send goes out", async () => {
    const sent: Uint8Array[] = [];
    const transport = createMoqTransport(
      {
        sendControl: (payload) => {
          sent.push(payload);
          return Promise.resolve();
        },
        screenshot: () => Promise.reject(new Error("not used")),
        close: () => Promise.resolve(),
      },
      { pasteText: () => Promise.resolve() }
    );

    await expect(sendCommand(apiWith(transport), { ...TOUCH })).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
  });

  /**
   * `Promise<void> | void`, not `Promise<void>`: a transport with nothing to
   * await must stay legal, or every future one is forced to be async for the
   * sake of the cloud path.
   */
  it("accepts a synchronous transport unchanged", async () => {
    const calls: string[] = [];
    const sync: SimulatorServerTransport = {
      touch: () => void calls.push("touch"),
      button: () => void calls.push("button"),
      rotate: () => void calls.push("rotate"),
      paste: () => void calls.push("paste"),
      pressKey: () => void calls.push("pressKey"),
      screenshot: () => Promise.resolve({ url: "file:///x.png", path: "/x.png" }),
    };

    await expect(sendCommand(apiWith(sync), { ...TOUCH })).resolves.toBeUndefined();
    await expect(
      sendCommand(apiWith(sync), { cmd: "key", direction: "Down", code: 0x19 })
    ).resolves.toBeUndefined();
    expect(calls).toEqual(["touch", "pressKey"]);
  });

  it("still refuses a command the transport does not implement", async () => {
    const transport = createMoqTransport(closedMoqClient(), { pasteText: () => Promise.resolve() });
    await expect(async () => sendCommand(apiWith(transport), { cmd: "wiggle" })).rejects.toThrow(
      /does not implement sendCommand cmd 'wiggle'/
    );
  });
});

describe("every send routed onto MoQ reports its own failure", () => {
  const COMMANDS = [
    { name: "touch", cmd: { ...TOUCH } },
    { name: "button", cmd: { cmd: "button", direction: "Down", button: "Home" } },
    { name: "rotate", cmd: { cmd: "rotate", direction: "LandscapeLeft" } },
    { name: "key", cmd: { cmd: "key", direction: "Down", code: 0x19 } },
  ] as const;

  it.each(COMMANDS)("$name rejects when the track is closed", async ({ cmd }) => {
    const transport = createMoqTransport(closedMoqClient(), { pasteText: () => Promise.resolve() });
    expect(
      getFailureSignal(await sendCommand(apiWith(transport), { ...cmd }).catch((e: unknown) => e))
        ?.error_code
    ).toBe(FAILURE_CODES.SIMULATOR_COMMAND_TRANSPORT_FAILED);
  });
});

describe("gesture-tap on a dead cloud session", () => {
  it("fails instead of answering { tapped: true }", async () => {
    const transport = createMoqTransport(closedMoqClient(), { pasteText: () => Promise.resolve() });
    const { outcome, unhandled } = await watchUnhandledRejections(() =>
      gestureTapTool.execute(
        { simulatorServer: apiWith(transport) } as never,
        { udid: UDID, x: 0.5, y: 0.5 },
        undefined as never
      )
    );

    expect(outcome).toBeInstanceOf(Error);
    expect(getFailureSignal(outcome)?.error_code).toBe(
      FAILURE_CODES.SIMULATOR_COMMAND_TRANSPORT_FAILED
    );
    // The crash guard: dropping the send used to kill the tool server here.
    expect(unhandled).toEqual([]);
  });
});

/**
 * The remote instance builds its own `pressKey`, so it is the one input that
 * can miss `sendCommand` entirely. It did: it called `moq.sendControl` direct,
 * which left `keyboard` on a dead cloud session throwing a bare SDK error
 * while a tap on the same session reported a classified failure.
 */
describe("the remote instance routes its keys like every other input", () => {
  it("reports a refused key as the failure a refused touch reports", async () => {
    const instance = await simulatorServerBlueprint.factory(
      {} as never,
      undefined as never,
      {
        device: { id: UDID, platform: "ios-remote" },
      } as never
    );

    const err = await (instance.api as SimulatorServerApi)
      .pressKey("Down", 0x19)
      .catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.SIMULATOR_COMMAND_TRANSPORT_FAILED
    );
    expect(String(err)).toContain("'key'");
    await instance.dispose?.();
  });
});
