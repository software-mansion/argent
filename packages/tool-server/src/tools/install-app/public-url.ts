import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { FAILURE_CODES, FailureError } from "@argent/registry";

function sourceFailure(message: string): FailureError {
  return new FailureError(message, {
    error_code: FAILURE_CODES.APP_INSTALL_SOURCE_INVALID,
    failure_stage: "app_install_validate_source_url",
    failure_area: "tool_server",
    error_kind: "validation",
  });
}

function resolutionFailure(hostname: string, cause?: unknown): FailureError {
  return new FailureError(
    `Could not resolve app download host ${hostname}.`,
    {
      error_code: FAILURE_CODES.APP_INSTALL_DOWNLOAD_FAILED,
      failure_stage: "app_install_resolve_source_host",
      failure_area: "tool_server",
      error_kind: "network",
      network_failure: "other",
    },
    cause === undefined
      ? undefined
      : {
          cause:
            cause instanceof Error
              ? cause
              : new Error(typeof cause === "string" ? cause : "Unknown DNS error"),
        }
  );
}

function normalizeHostname(hostname: string): string {
  const normalized = hostname.toLowerCase();
  return normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map((part) => Number.parseInt(part, 10));
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a, b] = octets;
  if (a === undefined || b === undefined) return true;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  const family = isIP(normalized);
  if (family === 4) return isPrivateIpv4(normalized);
  if (family !== 6) return false;
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(normalized) || /^fe[c-f]/.test(normalized)) return true;
  // DNS lookups return ordinary IPv4 records, so rejecting mapped literals as
  // a class only excludes an unusual URL spelling while closing allowlist
  // bypasses such as `http://[::ffff:127.0.0.1]/`.
  return normalized.startsWith("::ffff:");
}

export async function validatePublicDownloadUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw sourceFailure(`Unsupported app URL protocol: ${url.protocol || "unknown"}.`);
  }
  const hostname = normalizeHostname(url.hostname);
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw sourceFailure("App URL must use a public host; localhost is not allowed.");
  }
  if (isPrivateIpAddress(hostname)) {
    throw sourceFailure("App URL must not target a private, loopback, or link-local address.");
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw resolutionFailure(hostname, error);
  }
  if (addresses.length === 0) throw resolutionFailure(hostname);
  if (addresses.some(({ address }) => isPrivateIpAddress(address))) {
    throw sourceFailure(
      `App download host ${hostname} resolves to a private, loopback, or link-local address.`
    );
  }
}
