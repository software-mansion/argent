import { beforeEach, describe, expect, it, vi } from "vitest";

// HarmonyOS is behind the `harmonyos` flag; these cases drive it with the flag on.
vi.mock("../src/utils/harmony-flag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-flag")>()),
  isHarmonyEnabled: () => true,
}));
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@argent/registry";

vi.mock("../src/utils/harmony-hdc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-hdc")>()),
  runHdcShell: vi.fn(),
  hdcFileRecv: vi.fn(async () => {}),
}));

import { gestureTapTool } from "../src/tools/gesture-tap";
import { gestureSwipeTool } from "../src/tools/gesture-swipe";
import { gesturePinchTool } from "../src/tools/gesture-pinch";
import { buttonTool } from "../src/tools/button";
import { createKeyboardTool } from "../src/tools/keyboard";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";
import { runHdcShell as realRunHdcShell } from "../src/utils/harmony-hdc";
import { harmonyScreenCap } from "../src/utils/harmony-uitest";

const runHdcShell = vi.mocked(realRunHdcShell);
const CONNECT_KEY = "025DEK236V035771";
const udid = `harmony-${CONNECT_KEY}`;
const SCREEN =
  "screen[0]: id=0, powerStatus=POWER_STATUS_ON, backlight=1, screenType=EXTERNAL_TYPE, " +
  "render resolution=1200x2000, physical resolution=1200x2000, isVirtual=false";

const settle = () => new Promise((r) => setImmediate(r));
let blocked: (() => void)[] = [];

beforeEach(() => {
  __resetDepCacheForTests();
  __primeDepCacheForTests(["hdc"]);
  blocked = [];
  runHdcShell.mockReset();
  runHdcShell.mockImplementation(async (_key, command) => {
    if (command.startsWith("hidumper")) return { stdout: SCREEN, exitCode: 0 };
    // Only the screenshot holding the queue blocks.
    if (command.startsWith("uitest screenCap")) {
      await new Promise<void>((resolve) => blocked.push(resolve));
    }
    return { stdout: "No Error", exitCode: 0 };
  });
});

const injections = () =>
  runHdcShell.mock.calls
    .map(([, command]) => command)
    .filter((c) => c.startsWith("uitest uiInput") || c.startsWith("uinput "));

describe("a HarmonyOS input cancelled while queued", () => {
  it.each([
    [
      "gesture-tap",
      (ctx: ToolContext) => gestureTapTool.execute({}, { udid, x: 0.5, y: 0.5 }, ctx),
    ],
    [
      "gesture-swipe",
      (ctx: ToolContext) =>
        gestureSwipeTool.execute({}, { udid, fromX: 0.2, fromY: 0.8, toX: 0.8, toY: 0.2 }, ctx),
    ],
    [
      "gesture-pinch",
      (ctx: ToolContext) =>
        gesturePinchTool.execute(
          {},
          { udid, centerX: 0.5, centerY: 0.5, startDistance: 0.2, endDistance: 0.6 },
          ctx
        ),
    ],
    ["button", (ctx: ToolContext) => buttonTool.execute({}, { udid, button: "home" }, ctx)],
    [
      "keyboard",
      (ctx: ToolContext) => createKeyboardTool({} as never).execute({}, { udid, text: "hi" }, ctx),
    ],
  ])("%s injects nothing and rejects with an AbortError", async (_tool, run) => {
    harmonyScreenCap(CONNECT_KEY, join(tmpdir(), `argent-cancel-${process.pid}.png`)).catch(
      () => {}
    );
    await settle();
    const ac = new AbortController();
    const outcome = run({ signal: ac.signal } as ToolContext).then(
      () => null,
      (e: unknown) => e
    );
    await settle();

    ac.abort();
    blocked.shift()?.();
    await settle();

    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(injections()).toEqual([]);
  });
});
