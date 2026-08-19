import { open, mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import { resolvePublicDownloadUrl, type PublicDownloadAddress } from "./public-url";

const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const MAX_REDIRECTS = 5;
export const MAX_APP_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const RECOGNIZED_SUFFIXES = [".tar.gz", ".tgz", ".apk", ".ipa", ".zip"];

export interface DownloadedAppArtifact {
  path: string;
  cleanup(): Promise<void>;
}

interface PinnedResponse {
  body: IncomingMessage;
  finalUrl: URL;
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
                  typeof options.cause === "string" ? options.cause : "Unknown app download error"
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

function requestHeaders(values: Record<string, string> | undefined): Record<string, string> {
  let headers: Headers;
  try {
    headers = new Headers(values);
  } catch {
    throw sourceFailure("App download headers are invalid.");
  }
  const result: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (FORBIDDEN_REQUEST_HEADERS.has(name)) {
      throw sourceFailure(`App download header ${name} cannot be overridden.`);
    }
    result[name] = value;
  }
  return result;
}

function redirectedHeaders(
  headers: Record<string, string>,
  from: URL,
  to: URL
): Record<string, string> {
  // Every caller-provided header may be a credential (PRIVATE-TOKEN,
  // X-Api-Key, signed cookies, etc.). An allowlist cannot identify them all,
  // so no caller header crosses an origin boundary.
  return from.origin === to.origin ? headers : {};
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function pinnedRequest(
  url: URL,
  headers: Record<string, string>,
  pinnedAddress: PublicDownloadAddress,
  signal: AbortSignal
): Promise<IncomingMessage> {
  return new Promise((resolveResponse, rejectResponse) => {
    const options: RequestOptions = {
      headers,
      signal,
      family: pinnedAddress.family,
      // Keep the URL hostname for Host and TLS SNI, but force the socket to the
      // exact public IP returned by the validation lookup. fetch() would resolve
      // the hostname again and reopen a DNS-rebinding window.
      lookup: (_hostname, _options, callback) => {
        callback(null, pinnedAddress.address, pinnedAddress.family);
      },
    };
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      options,
      resolveResponse
    );
    request.once("error", rejectResponse);
    request.end();
  });
}

function transportFailure(
  error: unknown,
  timeoutSignal: AbortSignal,
  requestSignal?: AbortSignal
): FailureError {
  if (timeoutSignal.aborted) {
    return downloadFailure(`App download timed out after ${DOWNLOAD_TIMEOUT_MS}ms.`, {
      timeout: true,
      cause: error,
    });
  }
  if (requestSignal?.aborted) {
    return downloadFailure("App download was canceled.", { cause: error });
  }
  return downloadFailure("Failed to download the app artifact.", { cause: error });
}

async function requestFollowingPublicRedirects(
  initialUrl: URL,
  initialHeaders: Record<string, string>,
  signal: AbortSignal,
  timeoutSignal: AbortSignal,
  requestSignal?: AbortSignal
): Promise<PinnedResponse> {
  let currentUrl = initialUrl;
  let headers = initialHeaders;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    if (signal.aborted) throw transportFailure(signal.reason, timeoutSignal, requestSignal);
    const addresses = await resolvePublicDownloadUrl(currentUrl);
    if (signal.aborted) throw transportFailure(signal.reason, timeoutSignal, requestSignal);
    const pinnedAddress = addresses.find(({ family }) => family === 4) ?? addresses[0]!;

    let response: IncomingMessage;
    try {
      response = await pinnedRequest(currentUrl, headers, pinnedAddress, signal);
    } catch (error) {
      throw transportFailure(error, timeoutSignal, requestSignal);
    }
    const status = response.statusCode ?? 0;
    if (!REDIRECT_STATUSES.has(status)) return { body: response, finalUrl: currentUrl };

    const location = headerValue(response.headers, "location");
    response.destroy();
    if (!location) {
      throw downloadFailure(`App download returned redirect ${status} without a location.`, {
        invalidResponse: true,
      });
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

function contentDispositionFilename(value: string | undefined): string | undefined {
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

function downloadedFilename(response: IncomingMessage, finalUrl: URL): string {
  const headerName = contentDispositionFilename(
    headerValue(response.headers, "content-disposition")
  );
  let filename = safeFilename(headerName ?? basename(finalUrl.pathname) ?? "app-artifact");
  if (RECOGNIZED_SUFFIXES.some((suffix) => filename.toLowerCase().endsWith(suffix))) {
    return filename;
  }

  const contentType = headerValue(response.headers, "content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType === "application/vnd.android.package-archive") filename += ".apk";
  else if (contentType === "application/zip" || contentType === "application/x-zip-compressed") {
    filename += ".zip";
  } else if (contentType === "application/gzip" || contentType === "application/x-gzip") {
    filename += ".tar.gz";
  }
  return filename;
}

async function writeResponseBody(response: IncomingMessage, destination: string): Promise<void> {
  const declaredLength = Number(headerValue(response.headers, "content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_APP_DOWNLOAD_BYTES) {
    response.destroy();
    throw sourceFailure(
      `App artifact is larger than the ${MAX_APP_DOWNLOAD_BYTES}-byte download limit.`
    );
  }

  const file = await open(destination, "wx");
  let received = 0;
  try {
    for await (const chunk of response) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += bytes.byteLength;
      if (received > MAX_APP_DOWNLOAD_BYTES) {
        response.destroy();
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
    const { body, finalUrl } = await requestFollowingPublicRedirects(
      parseUrl(rawUrl),
      requestHeaders(headers),
      signal,
      timeoutSignal,
      requestSignal
    );
    const status = body.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      body.destroy();
      throw downloadFailure(
        `App download failed with HTTP ${status} ${body.statusMessage ?? ""}.`.trim(),
        { invalidResponse: true }
      );
    }
    const destination = join(tempDir, downloadedFilename(body, finalUrl));
    try {
      await writeResponseBody(body, destination);
    } catch (error) {
      body.destroy();
      if (error instanceof FailureError) throw error;
      throw transportFailure(error, timeoutSignal, requestSignal);
    }
    return {
      path: destination,
      cleanup: async () => {
        await rm(tempDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    if (error instanceof FailureError) throw error;
    throw transportFailure(error, timeoutSignal, requestSignal);
  }
}
