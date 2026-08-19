import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { FAILURE_CODES, FailureError } from "@argent/registry";

export interface PublicDownloadAddress {
  address: string;
  family: 4 | 6;
}

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
              : new Error(typeof cause === "string" ? cause : "Unknown DNS resolution error"),
        }
  );
}

function normalizeHostname(hostname: string): string {
  const normalized = hostname.toLowerCase();
  return normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split(".").map((part) => Number.parseInt(part, 10));
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a, b, c] = octets as [number, number, number, number];
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function parseIpv6Words(address: string): number[] | undefined {
  let normalized = normalizeHostname(address);
  const zoneIndex = normalized.indexOf("%");
  if (zoneIndex >= 0) normalized = normalized.slice(0, zoneIndex);

  const ipv4Match = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
  let ipv4Words: number[] = [];
  if (ipv4Match?.[1]) {
    const octets = ipv4Match[1].split(".").map(Number);
    if (octets.length !== 4 || octets.some((value) => value < 0 || value > 255)) return undefined;
    ipv4Words = [(octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!];
    normalized = normalized.slice(0, -ipv4Match[1].length).replace(/:$/, "");
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return undefined;
  const parseHalf = (value: string): number[] | undefined => {
    if (!value) return [];
    const words = value.split(":");
    if (words.some((word) => !/^[0-9a-f]{1,4}$/i.test(word))) return undefined;
    return words.map((word) => Number.parseInt(word, 16));
  };
  const left = parseHalf(halves[0] ?? "");
  const right = parseHalf(halves[1] ?? "");
  if (!left || !right) return undefined;
  const explicitCount = left.length + right.length + ipv4Words.length;
  const zeroCount = halves.length === 2 ? 8 - explicitCount : 0;
  if (zeroCount < 0 || (halves.length === 1 && explicitCount !== 8)) return undefined;
  const words = [...left, ...Array.from({ length: zeroCount }, () => 0), ...right, ...ipv4Words];
  return words.length === 8 ? words : undefined;
}

function isPublicIpv6(address: string): boolean {
  const words = parseIpv6Words(address);
  if (!words) return false;
  const [first, second] = words;
  if (first === undefined || second === undefined) return false;

  // Globally routable unicast currently lives in 2000::/3. Explicitly reject
  // documentation and benchmarking ranges inside it as well.
  if ((first & 0xe000) !== 0x2000) return false;
  if (first === 0x2001 && second === 0x0db8) return false;
  if (first === 0x2001 && second === 0x0002) return false;
  return true;
}

function isPublicIpAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  const family = isIP(normalized);
  if (family === 4) return isPublicIpv4(normalized);
  if (family === 6) return isPublicIpv6(normalized);
  return false;
}

export async function resolvePublicDownloadUrl(url: URL): Promise<PublicDownloadAddress[]> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw sourceFailure(`Unsupported app URL protocol: ${url.protocol || "unknown"}.`);
  }
  const hostname = normalizeHostname(url.hostname);
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw sourceFailure("App URL must use a public host; localhost is not allowed.");
  }
  if (isIP(hostname) && !isPublicIpAddress(hostname)) {
    throw sourceFailure("App URL must not target a private, reserved, or local address.");
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw resolutionFailure(hostname, error);
  }
  if (addresses.length === 0) throw resolutionFailure(hostname);
  if (addresses.some(({ address }) => !isPublicIpAddress(address))) {
    throw sourceFailure(`App download host ${hostname} resolves to a non-public address.`);
  }
  return addresses.map(({ address, family }) => ({
    address,
    family: family === 6 ? 6 : 4,
  }));
}
