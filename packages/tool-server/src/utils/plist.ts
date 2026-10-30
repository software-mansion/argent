import { readFile } from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";

/**
 * Property lists without `plutil`, which only exists on macOS: a tool-server on
 * Linux still reads `.xctestrun` files (XML) and app `Info.plist`s (binary when
 * Xcode built them).
 */

export type PlistValue =
  string | number | boolean | Buffer | Date | PlistValue[] | { [key: string]: PlistValue };

// preserveOrder keeps <key> next to its value inside <dict>.
const TEXT_KEY = "#text";
const parser = new XMLParser({
  preserveOrder: true,
  textNodeName: TEXT_KEY,
  parseTagValue: false,
  trimValues: false,
  processEntities: true,
  htmlEntities: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

type FxpEntry = Record<string, unknown>;

function tagOf(entry: FxpEntry): string {
  return Object.keys(entry).find((k) => k !== ":@") ?? "";
}

function elements(entries: FxpEntry[]): FxpEntry[] {
  return entries.filter((e) => tagOf(e) !== TEXT_KEY);
}

function textOf(entry: FxpEntry): string {
  return ((entry[tagOf(entry)] as FxpEntry[]) ?? [])
    .map((c) => (typeof c[TEXT_KEY] === "string" ? c[TEXT_KEY] : ""))
    .join("");
}

function xmlValue(entry: FxpEntry): PlistValue {
  const tag = tagOf(entry);
  const children = (entry[tag] as FxpEntry[]) ?? [];
  switch (tag) {
    case "dict": {
      const out: { [key: string]: PlistValue } = {};
      let key: string | undefined;
      for (const child of elements(children)) {
        if (tagOf(child) === "key") key = textOf(child);
        else if (key !== undefined) {
          out[key] = xmlValue(child);
          key = undefined;
        }
      }
      return out;
    }
    case "array":
      return elements(children).map(xmlValue);
    case "string":
      return textOf(entry);
    case "integer":
    case "real":
      return Number(textOf(entry));
    case "true":
      return true;
    case "false":
      return false;
    case "data":
      return Buffer.from(textOf(entry).replace(/\s+/g, ""), "base64");
    case "date":
      return new Date(textOf(entry).trim());
    default:
      throw new Error(`unsupported plist element <${tag}>`);
  }
}

function parseXml(text: string): PlistValue {
  const root = (parser.parse(text) as FxpEntry[]).find((e) => tagOf(e) === "plist");
  const top = root ? elements(root.plist as FxpEntry[])[0] : undefined;
  if (!top) throw new Error("not a property list");
  return xmlValue(top);
}

// Seconds between the Unix epoch and the Core Data reference date (2001-01-01).
const REFERENCE_DATE_S = 978307200;

function parseBinary(b: Buffer): PlistValue {
  const trailer = b.length - 32;
  const offsetSize = b[trailer + 6]!;
  const refSize = b[trailer + 7]!;
  const numObjects = Number(b.readBigUInt64BE(trailer + 8));
  const top = Number(b.readBigUInt64BE(trailer + 16));
  const offsetTable = Number(b.readBigUInt64BE(trailer + 24));
  const uint = (pos: number, size: number) => {
    let v = 0;
    for (let i = 0; i < size; i += 1) v = v * 256 + b[pos + i]!;
    return v;
  };

  const read = (ref: number, depth: number): PlistValue => {
    // Containers nest at most a few levels in an Info.plist; a cycle would recurse forever.
    if (ref >= numObjects || depth > 64) throw new Error("bad binary plist object reference");
    let pos = uint(offsetTable + ref * offsetSize, offsetSize);
    const marker = b[pos]!;
    const info = marker & 0xf;
    pos += 1;
    const length = () => {
      if (info !== 0xf) return info;
      const size = 1 << (b[pos]! & 0xf);
      const v = uint(pos + 1, size);
      pos += 1 + size;
      return v;
    };
    const refs = (count: number, from: number) =>
      Array.from({ length: count }, (_, i) => uint(from + i * refSize, refSize));

    switch (marker >> 4) {
      case 0x0:
        if (marker === 0x08) return false;
        if (marker === 0x09) return true;
        break;
      case 0x1:
        if (info === 3) return Number(b.readBigInt64BE(pos));
        if (info < 3) return uint(pos, 1 << info);
        break;
      case 0x2:
        return info === 2 ? b.readFloatBE(pos) : b.readDoubleBE(pos);
      case 0x3:
        return new Date((REFERENCE_DATE_S + b.readDoubleBE(pos)) * 1000);
      case 0x4: {
        const n = length();
        return Buffer.from(b.subarray(pos, pos + n));
      }
      case 0x5: {
        const n = length();
        return b.toString("latin1", pos, pos + n);
      }
      case 0x6: {
        const n = length();
        return Buffer.from(b.subarray(pos, pos + 2 * n))
          .swap16()
          .toString("utf16le");
      }
      case 0xa: {
        const n = length();
        return refs(n, pos).map((r) => read(r, depth + 1));
      }
      case 0xd: {
        const n = length();
        const keys = refs(n, pos);
        const values = refs(n, pos + n * refSize);
        const out: { [key: string]: PlistValue } = {};
        keys.forEach((k, i) => {
          const key = read(k, depth + 1);
          if (typeof key !== "string")
            throw new Error("binary plist dictionary key is not a string");
          out[key] = read(values[i]!, depth + 1);
        });
        return out;
      }
    }
    throw new Error(`unsupported binary plist object 0x${marker.toString(16)}`);
  };

  return read(top, 0);
}

/** Parses an XML or binary (`bplist00`) property list. */
export function parsePlist(bytes: Buffer): PlistValue {
  if (bytes.subarray(0, 8).toString("latin1") === "bplist00") return parseBinary(bytes);
  return parseXml(bytes.toString("utf8"));
}

export async function readPlistFile(file: string): Promise<PlistValue> {
  return parsePlist(await readFile(file));
}

/** `CFBundleIdentifier` of an `Info.plist`, or undefined when it has none or cannot be read. */
export async function readBundleIdentifier(infoPlist: string): Promise<string | undefined> {
  try {
    const id = ((await readPlistFile(infoPlist)) as Record<string, PlistValue>).CFBundleIdentifier;
    return typeof id === "string" && id ? id : undefined;
  } catch {
    return undefined;
  }
}

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function xmlNode(v: PlistValue): string {
  if (typeof v === "string") return `<string>${escapeXml(v)}</string>`;
  if (typeof v === "boolean") return v ? "<true/>" : "<false/>";
  if (typeof v === "number")
    return Number.isInteger(v) ? `<integer>${v}</integer>` : `<real>${v}</real>`;
  if (Buffer.isBuffer(v)) return `<data>${v.toString("base64")}</data>`;
  if (v instanceof Date) return `<date>${v.toISOString().replace(/\.\d{3}Z$/, "Z")}</date>`;
  if (Array.isArray(v)) return `<array>${v.map(xmlNode).join("")}</array>`;
  const entries = Object.entries(v).map(([k, x]) => `<key>${escapeXml(k)}</key>${xmlNode(x)}`);
  return `<dict>${entries.join("")}</dict>`;
}

/** Serializes `value` as an XML property list. */
export function buildPlist(value: PlistValue): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    `<plist version="1.0">\n${xmlNode(value)}\n</plist>\n`
  );
}
