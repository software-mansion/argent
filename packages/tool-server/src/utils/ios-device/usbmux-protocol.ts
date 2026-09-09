/**
 * Encode and decode usbmuxd packets.
 */

export const USBMUX_HEADER_BYTES = 16;
export const USBMUX_PROTOCOL_VERSION = 1;
/** The only message type this client speaks: XML plist payloads. */
export const USBMUX_MESSAGE_TYPE_PLIST = 8;
/** Reject packets larger than 4 MiB. */
export const USBMUX_MAX_PACKET_BYTES = 4 * 1024 * 1024;

/**
 * Transport failure mode.
 * `device-unattached` and `runner-not-listening` are pre-send failures.
 */
export type IosDeviceTransportErrorKind =
  | "device-unattached"
  | "runner-not-listening"
  | "protocol"
  | "timeout"
  | "http";

/**
 * Append a recovery hint to an error message if it is not already present.
 *
 * @param hint omitted or already contained in `message` leaves the text unchanged.
 */
export function appendHintToMessage(message: string, hint: string | undefined): string {
  if (!hint || message.includes(hint)) {
    return message;
  }

  return `${message}${/[.!?]$/.test(message) ? "" : "."} Hint: ${hint}`;
}

/**
 * Typed transport failure for the ios-device stack.
 */
export class IosDeviceTransportError extends Error {
  readonly kind: IosDeviceTransportErrorKind;
  readonly retryable: boolean;
  readonly hint?: string;

  constructor(
    kind: IosDeviceTransportErrorKind,
    message: string,
    options: { retryable: boolean; hint?: string; cause?: unknown } = { retryable: false }
  ) {
    super(
      appendHintToMessage(message, options.hint),
      options.cause !== undefined ? { cause: options.cause } : undefined
    );

    this.name = "IosDeviceTransportError";
    this.kind = kind;
    this.retryable = options.retryable;

    if (options.hint !== undefined) {
      this.hint = options.hint;
    }
  }
}

export function isIosDeviceTransportError(error: unknown): error is IosDeviceTransportError {
  return error instanceof IosDeviceTransportError;
}

export interface UsbmuxPacket {
  version: number;
  messageType: number;
  tag: number;
  payload: Buffer;
  /** Total packet length, including the header. */
  bytesConsumed: number;
}

/**
 * Frame an XML plist payload with the 16-byte little-endian usbmuxd header.
 *
 * @param tag request identifier echoed in the reply.
 */
export function encodeUsbmuxPacket(tag: number, payloadXml: string): Buffer {
  const payload = Buffer.from(payloadXml, "utf8");
  const packet = Buffer.alloc(USBMUX_HEADER_BYTES + payload.length);

  packet.writeUInt32LE(packet.length, 0);
  packet.writeUInt32LE(USBMUX_PROTOCOL_VERSION, 4);
  packet.writeUInt32LE(USBMUX_MESSAGE_TYPE_PLIST, 8);
  packet.writeUInt32LE(tag, 12);
  payload.copy(packet, USBMUX_HEADER_BYTES);

  return packet;
}

/**
 * Decode one packet from an accumulating buffer.
 * Returns null until a complete packet is available.
 */
export function decodeUsbmuxPacket(buffer: Buffer): UsbmuxPacket | null {
  if (buffer.length < USBMUX_HEADER_BYTES) {
    return null;
  }

  const totalLength = buffer.readUInt32LE(0);

  // A length below the header or above the cap can never become valid.
  if (totalLength < USBMUX_HEADER_BYTES || totalLength > USBMUX_MAX_PACKET_BYTES) {
    throw new IosDeviceTransportError(
      "protocol",
      `Invalid usbmuxd packet length ${totalLength} (must be between ${USBMUX_HEADER_BYTES} and ${USBMUX_MAX_PACKET_BYTES} bytes)`,
      { retryable: false }
    );
  }

  if (buffer.length < totalLength) {
    return null;
  }

  return {
    version: buffer.readUInt32LE(4),
    messageType: buffer.readUInt32LE(8),
    tag: buffer.readUInt32LE(12),
    payload: buffer.subarray(USBMUX_HEADER_BYTES, totalLength),
    bytesConsumed: totalLength,
  };
}

/**
 * Convert a host-order TCP port to the value usbmuxd `Connect` expects.
 */
export function hostToNetworkPort(port: number): number {
  if (!Number.isInteger(port) || port < 0 || port > 0xffff) {
    throw new IosDeviceTransportError("protocol", `Invalid TCP port ${port}`, {
      retryable: false,
    });
  }

  // usbmuxd wants the port in network byte order inside a host-order plist integer.
  return ((port & 0xff) << 8) | ((port >>> 8) & 0xff);
}

/** Escape a value for use as XML text content or an attribute value. */
function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Build the XML plist body for a usbmuxd request.
 */
export function buildUsbmuxPlistMessage(
  messageType: string,
  fields: Record<string, string | number> = {}
): string {
  // BundleID and ProgName identify this client. kLibUSBMuxVersion 3 selects the plist protocol.
  const entries: Array<[string, string | number]> = [
    ["BundleID", "com.argent.tool-server"],
    ["ClientVersionString", "argent"],
    ["MessageType", messageType],
    ["ProgName", "argent"],
    ["kLibUSBMuxVersion", 3],
    ...Object.entries(fields),
  ];

  const body = entries
    .map(([key, value]) =>
      typeof value === "number"
        ? `<key>${escapeXmlText(key)}</key><integer>${value}</integer>`
        : `<key>${escapeXmlText(key)}</key><string>${escapeXmlText(value)}</string>`
    )
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${body}</dict></plist>`;
}

export type PlistValue = string | number | boolean | PlistValue[] | PlistDict;
export interface PlistDict {
  [key: string]: PlistValue;
}

/**
 * Parse an XML plist document into plain JS values.
 */
export function parsePlist(xml: string): PlistValue {
  // Unsupported or unbalanced markup is a protocol error.
  const elements = parseXmlElements(xml);
  const plist = elements.find((element) => element.name === "plist");
  const root = plist ? plist.children[0] : elements[0];

  if (!root) {
    throw new IosDeviceTransportError("protocol", "Empty plist document from usbmuxd", {
      retryable: false,
    });
  }

  return convertPlistElement(root);
}

/**
 * Read the `Number` result code from a usbmuxd `Result` message.
 * Returns undefined when the payload is not the expected shape.
 */
export function readUsbmuxResultCode(xml: string): number | undefined {
  const root = parsePlistOrUndefined(xml);

  if (!isPlistDict(root)) {
    return undefined;
  }

  const value = root["Number"];

  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Resolve a mux DeviceID from a `ListDevices` response by exact serial match.
 *
 * A phone paired for Wi-Fi sync is listed once per transport, and usbmuxd
 * makes no promise about the order. The `USB` entry wins so every runner
 * command rides the cable; any other exact match is the fallback.
 */
export function readUsbmuxDeviceIdForSerial(xml: string, serial: string): number | undefined {
  const root = parsePlistOrUndefined(xml);

  if (!isPlistDict(root)) {
    return undefined;
  }

  const list = root["DeviceList"];

  if (!Array.isArray(list)) {
    return undefined;
  }

  let fallbackDeviceId: number | undefined;

  for (const entry of list) {
    // Hardware UDIDs share long prefixes. Matching must be exact.
    if (!isPlistDict(entry)) {
      continue;
    }

    const properties = entry["Properties"];

    if (!isPlistDict(properties)) {
      continue;
    }

    if (properties["SerialNumber"] !== serial) {
      continue;
    }

    const deviceId = entry["DeviceID"];

    if (typeof deviceId !== "number" || !Number.isSafeInteger(deviceId) || deviceId <= 0) {
      continue;
    }

    if (properties["ConnectionType"] === "USB") {
      return deviceId;
    }

    fallbackDeviceId ??= deviceId;
  }

  return fallbackDeviceId;
}

function parsePlistOrUndefined(xml: string): PlistValue | undefined {
  try {
    return parsePlist(xml);
  } catch {
    return undefined;
  }
}

function isPlistDict(value: PlistValue | undefined): value is PlistDict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface XmlElement {
  name: string;
  text: string;
  children: XmlElement[];
}

/**
 * Minimal XML scanner for the tags usbmuxd emits.
 */
function parseXmlElements(xml: string): XmlElement[] {
  const source = xml.replace(/<\?xml[\s\S]*?\?>/g, "").replace(/<!DOCTYPE[^>]*>/gi, "");
  const tokenPattern = /<(\/?)([A-Za-z][\w.-]*)((?:\s[^<>]*?)?)(\/?)>|([^<]+)/g;

  const root: XmlElement = { name: "#root", text: "", children: [] };
  const stack: XmlElement[] = [root];

  let consumed = 0;

  for (let match = tokenPattern.exec(source); match !== null; match = tokenPattern.exec(source)) {
    if (match.index !== consumed) {
      break;
    }

    consumed = tokenPattern.lastIndex;
    const [, closing, name, , selfClosing, textChunk] = match;
    const top = stack[stack.length - 1] as XmlElement;

    if (textChunk !== undefined) {
      top.text += decodeXmlEntities(textChunk);
      continue;
    }

    if (closing) {
      if (stack.length < 2 || top.name !== name) {
        throw invalidXmlError(`unexpected closing tag </${name}>`);
      }

      stack.pop();
      continue;
    }

    const element: XmlElement = { name: name as string, text: "", children: [] };
    top.children.push(element);

    if (!selfClosing) {
      stack.push(element);
    }
  }

  if (consumed !== source.length) {
    throw invalidXmlError("malformed markup");
  }

  if (stack.length !== 1) {
    throw invalidXmlError(`unclosed tag <${(stack[stack.length - 1] as XmlElement).name}>`);
  }

  return root.children;
}

function convertPlistElement(element: XmlElement): PlistValue {
  switch (element.name) {
    case "dict":
      return convertPlistDict(element);
    case "array":
      return element.children.map(convertPlistElement);
    case "string":
      return element.text;
    case "integer":
    case "real": {
      const parsed = Number(element.text.trim());

      if (!Number.isFinite(parsed)) {
        throw invalidXmlError(`non-numeric <${element.name}> value "${element.text}"`);
      }

      return parsed;
    }
    case "true":
      return true;
    case "false":
      return false;
    case "data":
    case "date":
      return element.text.trim();
    default:
      throw invalidXmlError(`unsupported plist node <${element.name}>`);
  }
}

function convertPlistDict(element: XmlElement): PlistDict {
  const dict: PlistDict = {};

  // Children alternate key then value. A key followed by a key is skipped.
  for (let index = 0; index < element.children.length - 1; index += 1) {
    const key = element.children[index] as XmlElement;

    if (key.name !== "key") {
      continue;
    }

    const value = element.children[index + 1] as XmlElement;

    if (value.name === "key") {
      continue;
    }

    dict[key.text] = convertPlistElement(value);
    index += 1;
  }

  return dict;
}

function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (entity, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }

    if (body.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    }

    const named: Record<string, string> = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
    };

    return named[body] ?? entity;
  });
}

function invalidXmlError(detail: string): IosDeviceTransportError {
  return new IosDeviceTransportError("protocol", `Invalid plist XML from usbmuxd: ${detail}`, {
    retryable: false,
  });
}
