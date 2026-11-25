import {
  AUTO_DESCRIBE_HEADER,
  CAPTURE_TIMEOUT_MS,
  PROFILING_CAPTURE_SKIPPED_NOTE,
  SECRET_CAPTURE_SKIPPED_NOTE,
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
    return images[0];
  } catch {
    return undefined;
  }
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
