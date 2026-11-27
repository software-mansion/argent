import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AUTO_DESCRIBE_HEADER,
  CAPTURE_TIMEOUT_MS,
  PROFILING_CAPTURE_SKIPPED_NOTE,
  SECRET_CAPTURE_SKIPPED_NOTE,
  artifactDir,
  autoDescribeEnabled,
  autoScreenshotEnabled,
  awaitScreenSettled,
  captureSettledScreen,
  containsSecretPlaceholder,
  describedTree,
  getUdidFromArgs,
  materializeArtifacts,
  shouldAutoDescribe,
  shouldAutoScreenshot,
  type CaptureToolCall,
  type MaterializedImage,
  type ToolsClient,
} from "@argent/tools-client";
import type { FlagsPathOptions } from "@argent/configuration-core";

interface AfterActionCapture {
  lines: string[];
  note?: string;
  screenshot?: MaterializedImage;
}

interface AfterActionCaptureOptions {
  client: Pick<ToolsClient, "callTool" | "baseUrl">;
  toolName: string;
  payload: Record<string, unknown>;
  profiling: boolean;
  flagsPath?: FlagsPathOptions;
}

interface CapturedPart {
  text: string;
  image?: MaterializedImage;
}

const NO_CAPTURE: AfterActionCapture = { lines: [] };
const NEVER_ABORTED = new AbortController().signal;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export async function captureAfterAction(
  options: AfterActionCaptureOptions
): Promise<AfterActionCapture> {
  const { client, toolName, payload, profiling } = options;
  const udid = getUdidFromArgs(payload);
  const wantScreenshot =
    shouldAutoScreenshot(toolName, payload) && autoScreenshotEnabled(options.flagsPath);
  const wantTree = shouldAutoDescribe(toolName, payload) && autoDescribeEnabled(options.flagsPath);
  if (!udid || !(wantScreenshot || wantTree)) return NO_CAPTURE;
  if (containsSecretPlaceholder(payload)) return { lines: [], note: SECRET_CAPTURE_SKIPPED_NOTE };

  const call: CaptureToolCall = async (name, args, s) =>
    (await client.callTool(name, args, { signal: s })).data;

  if (profiling) {
    if (toolName === "describe") return NO_CAPTURE;
    await awaitScreenSettled(call, udid, toolName, NEVER_ABORTED, CAPTURE_TIMEOUT_MS);
    return { lines: [], note: PROFILING_CAPTURE_SKIPPED_NOTE };
  }

  const captureScreenshot = async (s: AbortSignal): Promise<CapturedPart[]> => {
    const image = await takeScreenshot(client, call, udid, s);
    return image ? [{ text: `Screen after action: ${image.localPath}`, image }] : [];
  };
  const captureTree = async (s: AbortSignal): Promise<CapturedPart[]> => {
    const tree = await readTree(call, udid, s);
    return tree === undefined ? [] : [{ text: AUTO_DESCRIBE_HEADER }, { text: tree }];
  };

  const parts = await captureSettledScreen({
    call,
    udid,
    toolName,
    signal: NEVER_ABORTED,
    captureTimeoutMs: CAPTURE_TIMEOUT_MS,
    screenshot: wantScreenshot ? captureScreenshot : undefined,
    tree: wantTree ? captureTree : undefined,
  });
  return {
    lines: parts.map((part) => part.text),
    screenshot: parts.find((part) => part.image)?.image,
  };
}

async function takeScreenshot(
  client: Pick<ToolsClient, "baseUrl">,
  call: CaptureToolCall,
  udid: string,
  signal: AbortSignal
): Promise<MaterializedImage | undefined> {
  try {
    const data = await call("screenshot", { udid }, signal);
    const { url, token } = await client.baseUrl();
    const { images } = await materializeArtifacts(data, {
      toolsUrl: url,
      authToken: token,
      deviceId: udid,
      signal,
    });
    return images[0] ?? (await fetchLegacyScreenshot(data, udid, signal));
  } catch {
    return undefined;
  }
}

async function fetchLegacyScreenshot(
  data: unknown,
  udid: string,
  signal: AbortSignal
): Promise<MaterializedImage | undefined> {
  if (!data || typeof data !== "object") return undefined;
  const { url } = data as { url?: unknown };
  if (typeof url !== "string") return undefined;
  const res = await fetch(url, { signal });
  if (!res.ok) return undefined;
  const png = Buffer.from(await res.arrayBuffer());
  if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return undefined;
  const dir = artifactDir(udid);
  await mkdir(dir, { recursive: true });
  const localPath = join(dir, `screenshot-${Date.now()}.png`);
  await writeFile(localPath, png);
  return { localPath, data: png, mimeType: "image/png" };
}

async function readTree(
  call: CaptureToolCall,
  udid: string,
  signal: AbortSignal
): Promise<string | undefined> {
  try {
    return describedTree(await call("describe", { udid }, signal));
  } catch {
    return undefined;
  }
}
