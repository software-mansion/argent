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

export interface AfterActionCapture {
  /** Lines to print after the result. */
  lines: string[];
  /** Printed on stderr in place of a capture that was skipped. */
  note?: string;
  screenshot?: MaterializedImage;
}

export interface AfterActionCaptureOptions {
  client: Pick<ToolsClient, "callTool" | "baseUrl">;
  toolName: string;
  payload: Record<string, unknown>;
  profiling: boolean;
  /** Where the opt-out flags are read; tests point it at a temp dir. */
  flagsPath?: FlagsPathOptions;
}

const NO_CAPTURE: AfterActionCapture = { lines: [] };

/**
 * What `argent run` prints after an interaction tool, as the MCP server appends
 * it: the screen once it settles, as a screenshot file and the element tree.
 */
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

  const signal = new AbortController().signal;
  const call: CaptureToolCall = async (name, args, s) =>
    (await client.callTool(name, args, { signal: s })).data;

  if (profiling) {
    if (toolName === "describe") return NO_CAPTURE;
    await awaitScreenSettled(call, udid, toolName, signal, CAPTURE_TIMEOUT_MS);
    return { lines: [], note: PROFILING_CAPTURE_SKIPPED_NOTE };
  }

  let screenshot: MaterializedImage | undefined;
  const captureScreenshot = async (s: AbortSignal): Promise<string[]> => {
    screenshot = await takeScreenshot(client, call, udid, s);
    return screenshot ? [`Screen after action: ${screenshot.localPath}`] : [];
  };
  const captureTree = async (s: AbortSignal): Promise<string[]> => {
    const tree = await readTree(call, udid, s);
    return tree === undefined ? [] : [AUTO_DESCRIBE_HEADER, tree];
  };

  const lines = await captureSettledScreen({
    call,
    udid,
    toolName,
    signal,
    captureTimeoutMs: CAPTURE_TIMEOUT_MS,
    screenshot: wantScreenshot ? captureScreenshot : undefined,
    tree: wantTree ? captureTree : undefined,
  });
  return { lines, screenshot };
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
