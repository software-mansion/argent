import { describe, it, expect, vi } from "vitest";
import { Registry, type DeviceInfo } from "@argent/registry";
import { InvalidToolInputError } from "../src/utils/capability";
import { typeSimulatorServer } from "../src/tools/keyboard/simulator-server-keys";
import { makeChromiumImpl } from "../src/tools/keyboard/platforms/chromium";
import { injectVegaNamedKey, injectVegaText } from "../src/utils/vega-input";
import { injectAndroidNamedKey } from "../src/utils/android-input";

// The `keyboard` tool's `key` is a free `z.string()` and its `text` is a free
// string, so an unknown named key or an un-typeable character passes zod
// validation but is a *caller* mistake, not an internal fault. The HTTP layer
// maps InvalidToolInputError → 400 and a plain Error → 500. Before this, only
// the Android backend threw InvalidToolInputError, so `key: "pageup"` returned
// 400 on Android but 500 on iOS / chromium / vega — the same well-typed-but-
// unusable input mapping to different status codes by platform (hubgan review).
// These pins keep every keyboard backend's input-rejection taxonomy uniform.

function iosApi(): SimulatorApiStub {
  return { pressKey: vi.fn() };
}
interface SimulatorApiStub {
  pressKey: (dir: string, code: number) => void;
}

function chromiumApiStub() {
  return { dispatchKeyEvent: vi.fn(async () => {}) };
}

describe("keyboard backends — unknown key is invalid input (400), uniform across platforms", () => {
  it("iOS simulator-server backend throws InvalidToolInputError for an unknown key", async () => {
    const registry = new Registry();
    vi.spyOn(registry, "resolveService").mockResolvedValue(iosApi() as never);
    const device = { id: "AAAA", platform: "ios", kind: "simulator" } as unknown as DeviceInfo;
    await expect(
      typeSimulatorServer(registry, device, { udid: device.id, key: "pageup" })
    ).rejects.toBeInstanceOf(InvalidToolInputError);
  });

  it("chromium backend throws InvalidToolInputError for an unknown key", async () => {
    const registry = new Registry();
    vi.spyOn(registry, "resolveService").mockResolvedValue(chromiumApiStub() as never);
    const impl = makeChromiumImpl(registry);
    const device = {
      id: "chromium-cdp-9222",
      platform: "chromium",
      kind: "app",
    } as unknown as DeviceInfo;
    await expect(
      impl.handler({}, { udid: device.id, key: "pageup" }, device)
    ).rejects.toBeInstanceOf(InvalidToolInputError);
  });

  it("vega backend throws InvalidToolInputError for an unknown key", async () => {
    await expect(injectVegaNamedKey("pageup")).rejects.toBeInstanceOf(InvalidToolInputError);
  });

  it("vega backend throws InvalidToolInputError for a newline in text", async () => {
    await expect(injectVegaText("a\nb")).rejects.toBeInstanceOf(InvalidToolInputError);
  });

  it("android backend throws InvalidToolInputError for an unknown key (parity anchor)", async () => {
    // The android path already did this; assert it here alongside the siblings so
    // the four backends are pinned to the same taxonomy in one place.
    await expect(injectAndroidNamedKey("emulator-5554", "pageup")).rejects.toBeInstanceOf(
      InvalidToolInputError
    );
  });

  it("iOS simulator-server backend throws InvalidToolInputError for an un-typeable character", async () => {
    const registry = new Registry();
    vi.spyOn(registry, "resolveService").mockResolvedValue(iosApi() as never);
    const device = { id: "AAAA", platform: "ios", kind: "simulator" } as unknown as DeviceInfo;
    // An emoji has no keycode in the HID map, so this is a caller input error.
    await expect(
      typeSimulatorServer(registry, device, { udid: device.id, text: "😀" })
    ).rejects.toBeInstanceOf(InvalidToolInputError);
  });
});
