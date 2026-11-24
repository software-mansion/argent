import { open } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

/**
 * Read the package name from an APK without the Android SDK: find
 * AndroidManifest.xml in the zip, then take the `package` attribute of the
 * first start element of the binary XML. Throws when the file is not a zip or
 * has no readable manifest.
 */
export async function readApkPackageName(apkPath: string): Promise<string> {
  return parseManifestPackage(await readZipEntry(apkPath, "AndroidManifest.xml"));
}

export async function readZipEntry(zipPath: string, entryName: string): Promise<Buffer> {
  const file = await open(zipPath, "r");
  try {
    const read = async (position: number, length: number): Promise<Buffer> => {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await file.read(buf, 0, length, position);
      return buf.subarray(0, bytesRead);
    };

    // The end-of-central-directory record sits in the last 22 bytes plus an
    // optional comment of up to 64 KiB.
    const { size } = await file.stat();
    const tailStart = Math.max(0, size - (22 + 0xffff));
    const tail = await read(tailStart, size - tailStart);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error("not a zip archive");
    const entryCount = tail.readUInt16LE(eocd + 10);
    const dir = await read(tail.readUInt32LE(eocd + 16), tail.readUInt32LE(eocd + 12));

    let p = 0;
    for (let i = 0; i < entryCount && dir.readUInt32LE(p) === 0x02014b50; i++) {
      const method = dir.readUInt16LE(p + 10);
      const compressedSize = dir.readUInt32LE(p + 20);
      const nameLength = dir.readUInt16LE(p + 28);
      const nextEntry = p + 46 + nameLength + dir.readUInt16LE(p + 30) + dir.readUInt16LE(p + 32);
      if (dir.toString("utf8", p + 46, p + 46 + nameLength) === entryName) {
        const localOffset = dir.readUInt32LE(p + 42);
        const local = await read(localOffset, 30);
        const dataStart = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
        const data = await read(dataStart, compressedSize);
        if (method === 0) return data;
        if (method === 8) return inflateRawSync(data);
        throw new Error(`unsupported zip compression method ${method}`);
      }
      p = nextEntry;
    }
    throw new Error(`no ${entryName} in the archive`);
  } finally {
    await file.close();
  }
}

const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const UTF8_FLAG = 1 << 8;

/** Package attribute of the root `<manifest>` element of a binary AndroidManifest.xml. */
export function parseManifestPackage(xml: Buffer): string {
  let strings: string[] = [];
  // Skip the 8-byte RES_XML_TYPE file header, then walk the chunks.
  for (let p = xml.readUInt16LE(2); p + 8 <= xml.length;) {
    const type = xml.readUInt16LE(p);
    const chunkSize = xml.readUInt32LE(p + 4);
    if (chunkSize < 8) break;
    if (type === RES_STRING_POOL_TYPE) {
      strings = readStringPool(xml, p);
    } else if (type === RES_XML_START_ELEMENT_TYPE) {
      const ext = p + xml.readUInt16LE(p + 2);
      const attrStart = ext + xml.readUInt16LE(ext + 8);
      const attrSize = xml.readUInt16LE(ext + 10);
      const attrCount = xml.readUInt16LE(ext + 12);
      for (let i = 0; i < attrCount; i++) {
        const attr = attrStart + i * attrSize;
        if (strings[xml.readUInt32LE(attr + 4)] === "package") {
          const value = strings[xml.readUInt32LE(attr + 8)];
          if (value) return value;
        }
      }
      // Only the root element carries the package.
      break;
    }
    p += chunkSize;
  }
  throw new Error("no package attribute in AndroidManifest.xml");
}

function readStringPool(xml: Buffer, chunk: number): string[] {
  const count = xml.readUInt32LE(chunk + 8);
  const utf8 = (xml.readUInt32LE(chunk + 16) & UTF8_FLAG) !== 0;
  const stringsStart = chunk + xml.readUInt32LE(chunk + 20);
  const offsets = chunk + xml.readUInt16LE(chunk + 2);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let p = stringsStart + xml.readUInt32LE(offsets + i * 4);
    if (utf8) {
      // UTF-16 length, then UTF-8 byte length; each is 1 byte, or 2 with the high bit set.
      p += xml[p]! & 0x80 ? 2 : 1;
      const len = xml[p]! & 0x80 ? ((xml[p]! & 0x7f) << 8) | xml[p + 1]! : xml[p]!;
      p += xml[p]! & 0x80 ? 2 : 1;
      out.push(xml.toString("utf8", p, p + len));
    } else {
      const head = xml.readUInt16LE(p);
      const len = head & 0x8000 ? ((head & 0x7fff) << 16) | xml.readUInt16LE(p + 2) : head;
      p += head & 0x8000 ? 4 : 2;
      out.push(xml.toString("utf16le", p, p + len * 2));
    }
  }
  return out;
}
