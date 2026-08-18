import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { FAILURE_CODES, FailureError } from "@argent/registry";

const execFileAsync = promisify(execFile);
const BUNDLE_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9._-]*$/;

function artifactFailure(message: string): FailureError {
  return new FailureError(message, {
    error_code: FAILURE_CODES.APP_INSTALL_ARTIFACT_INVALID,
    failure_stage: "app_install_read_ios_bundle",
    failure_area: "tool_server",
    error_kind: "validation",
  });
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function readXmlBundleId(plist: Buffer): string | undefined {
  const text = plist.toString("utf8");
  if (!text.trimStart().startsWith("<?xml") && !text.trimStart().startsWith("<plist")) {
    return undefined;
  }
  const match = text.match(
    /<key>\s*CFBundleIdentifier\s*<\/key>\s*<string>\s*([^<]+?)\s*<\/string>/i
  );
  return match?.[1] ? decodeXmlText(match[1].trim()) : undefined;
}

async function readWithPlutil(infoPlistPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "plutil",
      ["-extract", "CFBundleIdentifier", "raw", "-o", "-", infoPlistPath],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 }
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function resolveIosBundleId(appBundlePath: string): Promise<string> {
  const infoPlistPath = join(appBundlePath, "Info.plist");
  let plist: Buffer;
  try {
    plist = await readFile(infoPlistPath);
  } catch {
    throw artifactFailure("iOS app artifact is missing Info.plist.");
  }
  const bundleId = readXmlBundleId(plist) ?? (await readWithPlutil(infoPlistPath));
  if (!bundleId || !BUNDLE_ID_PATTERN.test(bundleId)) {
    throw artifactFailure("Could not resolve CFBundleIdentifier from the iOS app artifact.");
  }
  return bundleId;
}
