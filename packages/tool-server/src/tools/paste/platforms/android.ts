import { sendCommand } from "../../../utils/simulator-client";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { PasteParams, PasteResult, PasteServices } from "./ios";

// Identical to iOS: the simulator-server's `cmd: "paste"` variant seeds the
// device pasteboard via `EmulatorController.setClipboard` and dispatches
// Ctrl+V through the same gRPC `sendKey` HID path Android Studio uses.
export const androidImpl: PlatformImpl<PasteServices, PasteParams, PasteResult> = {
  handler: async (services, params) => {
    const api = services.simulatorServer;
    sendCommand(api, { cmd: "paste", text: params.text });
    return { pasted: true };
  },
};
