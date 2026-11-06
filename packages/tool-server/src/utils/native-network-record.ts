import { canonicalDeviceId } from "./debugger/device-alias";
import { externalNativeId } from "./external-devices";

/**
 * The request records of the native network layers, Android's in-app agent and
 * iOS's alike: one record per request, in the same shape on both platforms, so
 * a reader handles one type.
 */

export type NativeRecordState = "pending" | "headers" | "complete" | "failed";

/** One hop before the final response: what was asked, and what came back. */
interface NativeRedirect {
  /** The URL that answered with the redirect. */
  url: string;
  method: string;
  status: number;
  statusText: string;
  /** The redirect response's headers. */
  headers: Record<string, string>;
  /** As this hop's request went on the wire, when the agent reported them. */
  requestHeaders?: Record<string, string>;
}

export interface NativeNetworkRecord {
  id: string;
  layer: "android-native" | "ios-native";
  layerId: string;
  connection: number;
  rnRequestId?: number;
  state: NativeRecordState;
  request: {
    /** The URL the app requested. */
    url: string;
    method: string;
    /** As the app set them. */
    headers: Record<string, string>;
    /** As they went on the wire for the latest hop, when the agent reported them. */
    wireHeaders?: Record<string, string>;
    hasPostData?: boolean;
  };
  /** The hops before the final response, oldest first. */
  redirects?: NativeRedirect[];
  response?: {
    /** The final URL, after any redirects. */
    url: string;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    mimeType: string;
    fromCache?: boolean;
  };
  timing: { startedAt: number; durationMs?: number };
  resourceType?: string;
  encodedDataLength?: number;
  errorText?: string;
}

export interface NativeNetworkBody {
  available: boolean;
  body: string;
  base64Encoded: boolean;
  truncated: boolean;
  reason?: string;
  /**
   * Set on a request body that came with the request itself and that the host
   * holds: the whole body's length in chars, of which `body` keeps the start.
   * Such a body carries no base64 flag, so a binary one reads as base64 text.
   */
  inlineChars?: number;
}

/**
 * One device, whichever id names it: an `ext:` id and the native id behind
 * it, or a Metro logicalDeviceId and the id it was connected with, all key the
 * same capture.
 */
export function deviceKeyOf(deviceId: string): string {
  return externalNativeId(canonicalDeviceId(deviceId) ?? deviceId);
}

/** Record memory is bounded by count and by size, whichever binds first. */
export const MAX_RECORDS = 2000;
export const RECORD_CHARS_BUDGET = 32 * 1024 * 1024;
/** One URL, header value or text field; longer ones keep their start. */
export const MAX_VALUE_CHARS = 64 * 1024;
const MAX_HEADERS = 256;
const MAX_HEADER_MAP_CHARS = 256 * 1024;
export const MAX_LAYER_ID_CHARS = 200;
/** The bodies most recently read, kept so a body is read from the app once per record. */
export const MAX_CACHED_BODIES = 64;

export const NOT_RECONNECTED =
  "the agent did not reconnect after its connection dropped, so this request's final events never arrived";
export const PROCESS_ENDED = "the app process ended before the request finished";
/** A body that was never read before the app process that made the request ended. */
export const PROCESS_GONE = "the app process that made the request is gone";

export function isOpen(record: NativeNetworkRecord): boolean {
  return record.state === "pending" || record.state === "headers";
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "10.0.2.2", "[::1]"]);

/**
 * Metro's own traffic on `metroPort`: the bundle, HMR, symbolication, the
 * inspector socket. Keyed on the caller's port.
 */
export function isMetroTraffic(url: string, metroPort: number): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return LOOPBACK_HOSTS.has(parsed.hostname) && Number(parsed.port) === metroPort;
}

/** Keeps the start of an absurdly long value and says how much was left out. */
export function capString(value: string, max = MAX_VALUE_CHARS): string {
  return value.length > max ? `${value.slice(0, max)}…[${value.length - max} more chars]` : value;
}

/**
 * A header map with every value capped, bounded in count and in total size.
 * The headers left out are counted in an entry that says so.
 */
export function headerMap(value: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  let kept = 0;
  let chars = 0;
  let left = 0;
  for (const [name, v] of Object.entries(asObject(value))) {
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") continue;
    const key = capString(name, 1024);
    const text = capString(String(v));
    if (kept >= MAX_HEADERS || chars + key.length + text.length > MAX_HEADER_MAP_CHARS) {
      left++;
      continue;
    }
    headers[key] = text;
    kept++;
    chars += key.length + text.length;
  }
  if (left > 0) headers["(not kept)"] = `${left} more headers`;
  return headers;
}

function mapChars(map: Record<string, string> | undefined): number {
  let chars = 0;
  for (const [name, value] of Object.entries(map ?? {})) chars += name.length + value.length;
  return chars;
}

/** What a record holds in strings, which is what its memory scales with. */
export function recordSize(record: NativeNetworkRecord): number {
  let chars =
    record.request.url.length +
    record.request.method.length +
    mapChars(record.request.headers) +
    mapChars(record.request.wireHeaders) +
    (record.errorText?.length ?? 0) +
    256;
  if (record.response) {
    chars +=
      record.response.url.length +
      record.response.statusText.length +
      record.response.mimeType.length +
      mapChars(record.response.headers);
  }
  for (const hop of record.redirects ?? []) {
    chars +=
      hop.url.length + hop.statusText.length + mapChars(hop.headers) + mapChars(hop.requestHeaders);
  }
  return chars;
}

/** A body reply of an in-app agent: `{body | postData, base64Encoded, wasTruncated}`. */
export function toBody(result: unknown, kind: "response" | "post"): NativeNetworkBody {
  const r = asObject(result);
  const text = kind === "response" ? r.body : r.postData;
  if (r.bodyAvailable === false || typeof text !== "string") {
    return unavailable(
      kind === "response"
        ? "the agent holds no body for this response"
        : "the agent holds no body for this request"
    );
  }
  return {
    available: true,
    body: text,
    base64Encoded: r.base64Encoded === true,
    truncated: r.wasTruncated === true,
  };
}

export function unavailable(reason: string): NativeNetworkBody {
  return { available: false, body: "", base64Encoded: false, truncated: false, reason };
}

export function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
