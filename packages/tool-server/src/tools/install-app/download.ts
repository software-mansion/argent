import { open, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import { validatePublicDownloadUrl } from "./public-url";

const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const MAX_REDIRECTS = 5;
export const MAX_APP_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;

const SENSITIVE_REDIRECT_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);
const RECOGNIZED_SUFFIXES = [".tar.gz", ".tgz", ".apk", ".ipa", ".zip"];

export interface DownloadedAppArtifact {
  path: string;
  cleanup(): Promise<void>;
}

function sourceFailure(message: string): FailureError {
  return new FailureError(message, {
    error_code: FAILURE_CODES.APP_INSTALL_SOURCE_INVALID,
    failure_stage: "app_install_validate_source_url",
    failure_area: "tool_server",
    error_kind: "validation",
  });
}

function downloadFailure(
  message: string,
  options: { timeout?: boolean; invalidResponse?: boolean; cause?: unknown } = {}
): FailureError {
  return new FailureError(
    message,
    {
      error_code: FAILURE_CODES.APP_INSTALL_DOWNLOAD_FAILED,
      failure_stage: "app_install_download_source",
      failure_area: "tool_server",
      error_kind: options.timeout ? "timeout" : "network",
      network_failure: options.timeout
        ? "timeout"
        : options.invalidResponse
          ? "invalid_response"
          : "other",
    },
    options.cause === undefined
      ? undefined
      : {
          cause:
            options.cause instanceof Error
              ? options.cause
              : new Error(
                  typeof options.cause === "string" ? options.cause : "Unknown download error"
                ),
        }
  );
}

function parseUrl(rawUrl: string): URL {
  try {
    return new URL(rawUrl);
  } catch {
    throw sourceFailure("App URL is invalid.");
  }
}

function redirectedHeaders(headers: Headers, from: URL, to: URL): Headers {
  if (from.origin === to.origin) return headers;
  const next = new Headers(headers);
  for (const header of SENSITIVE_REDIRECT_HEADERS) next.delete(header);
  return next;
}

function requestHeaders(values: Record<string, string> | undefined): Headers {
  try {
    return new Headers(values);
  } catch {
    throw sourceFailure("App download headers are invalid.");
  }
}

async function fetchFollowingPublicRedirects(
  initialUrl: URL,
  initialHeaders: Headers,
  signal: AbortSignal
): Promise<{ response: Response; finalUrl: URL }> {
  let currentUrl = initialUrl;
  let headers = initialHeaders;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    await validatePublicDownloadUrl(currentUrl);
    let response: Response;
    try {
      response = await fetch(currentUrl, { headers, redirect: "manual", signal });
    } catch (error) {
      throw downloadFailure("Failed to download the app artifact.", {
        timeout: signal.aborted,
        cause: error,
      });
    }
    if (response.status < 300 || response.status >= 400) {
      return { response, finalUrl: currentUrl };
    }
    const location = response.headers.get("location");
    if (!location) {
      throw downloadFailure(
        `App download returned redirect ${response.status} without a location.`,
        {
          invalidResponse: true,
        }
      );
    }
    if (redirectCount === MAX_REDIRECTS) {
      throw downloadFailure(`App download exceeded ${MAX_REDIRECTS} redirects.`, {
        invalidResponse: true,
      });
    }
    let nextUrl: URL;
    try {
      nextUrl = new URL(location, currentUrl);
    } catch {
      throw downloadFailure("App download returned an invalid redirect location.", {
        invalidResponse: true,
      });
    }
    headers = redirectedHeaders(headers, currentUrl, nextUrl);
    currentUrl = nextUrl;
  }
  throw downloadFailure("App download redirect handling failed.", { invalidResponse: true });
}

function contentDispositionFilename(value: string | null): string | undefined {
  if (!value) return undefined;
  const encoded = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.replace(/^"|"$/g, ""));
    } catch {
      // Fall through to the plain filename form.
    }
  }
  return value.match(/filename="([^"]+)"/i)?.[1] ?? value.match(/filename=([^;]+)/i)?.[1]?.trim();
}

function safeFilename(value: string): string {
  const cleaned = basename(value).replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "app-artifact";
}

function hasRecognizedSuffix(filename: string): boolean {
  const lower = filename.toLowerCase();
  return RECOGNIZED_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function downloadedFilename(response: Response, finalUrl: URL): string {
  const headerName = contentDispositionFilename(response.headers.get("content-disposition"));
  let filename = safeFilename(headerName ?? basename(finalUrl.pathname) ?? "app-artifact");
  if (hasRecognizedSuffix(filename)) return filename;

  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType === "application/vnd.android.package-archive") filename += ".apk";
  else if (contentType === "application/zip" || contentType === "application/x-zip-compressed") {
    filename += ".zip";
  } else if (contentType === "application/gzip" || contentType === "application/x-gzip") {
    filename += ".tar.gz";
  }
  return filename;
}

async function writeResponseBody(response: Response, destination: string): Promise<void> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_APP_DOWNLOAD_BYTES) {
    throw sourceFailure(
      `App artifact is larger than the ${MAX_APP_DOWNLOAD_BYTES}-byte download limit.`
    );
  }
  if (!response.body) {
    throw downloadFailure("App download response had no body.", { invalidResponse: true });
  }

  const file = await open(destination, "wx");
  let received = 0;
  try {
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      received += bytes.byteLength;
      if (received > MAX_APP_DOWNLOAD_BYTES) {
        throw sourceFailure(
          `App artifact exceeded the ${MAX_APP_DOWNLOAD_BYTES}-byte download limit.`
        );
      }
      await file.write(bytes);
    }
  } finally {
    await file.close();
  }
}

export async function downloadAppArtifact(
  rawUrl: string,
  headers: Record<string, string> | undefined,
  requestSignal?: AbortSignal
): Promise<DownloadedAppArtifact> {
  const tempDir = await mkdtemp(join(tmpdir(), "argent-app-install-"));
  const timeoutSignal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const signal = requestSignal ? AbortSignal.any([requestSignal, timeoutSignal]) : timeoutSignal;
  try {
    const initialUrl = parseUrl(rawUrl);
    const { response, finalUrl } = await fetchFollowingPublicRedirects(
      initialUrl,
      requestHeaders(headers),
      signal
    );
    if (!response.ok) {
      throw downloadFailure(
        `App download failed with HTTP ${response.status} ${response.statusText}.`,
        { invalidResponse: true }
      );
    }
    const destination = join(tempDir, downloadedFilename(response, finalUrl));
    try {
      await writeResponseBody(response, destination);
    } catch (error) {
      if (error instanceof FailureError) throw error;
      throw downloadFailure("Failed while saving the app artifact.", {
        timeout: signal.aborted,
        cause: error,
      });
    }
    return {
      path: destination,
      cleanup: async () => {
        await rm(tempDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    if (timeoutSignal.aborted && !(error instanceof FailureError)) {
      throw downloadFailure(`App download timed out after ${DOWNLOAD_TIMEOUT_MS}ms.`, {
        timeout: true,
        cause: error,
      });
    }
    throw error;
  }
}
