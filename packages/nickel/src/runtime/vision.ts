// Capture the device screen as a VLM image part — through argent's own `screenshot`
// tool (in-process, no duplication), then load the PNG off its hostPath. Downscaled
// by default so the local model's vision tower stays fast and cheap.

import * as fs from "node:fs";
import type { ChatImage } from "./client";
import type { Invoke } from "../invoke";

// Minimal slice of the screenshot tool's { image: ArtifactHandle } result.
interface ScreenshotResult {
  image?: { hostPath?: string; mimeType?: string };
}

export async function captureImage(
  invoke: Invoke,
  udid: string,
  scale = 0.5
): Promise<ChatImage | undefined> {
  const r = await invoke<ScreenshotResult>("screenshot", { udid, scale });
  const p = r.image?.hostPath;
  if (!p) return undefined;
  try {
    const base64 = fs.readFileSync(p).toString("base64");
    return { base64, mime: r.image?.mimeType ?? "image/png" };
  } catch {
    return undefined;
  }
}
