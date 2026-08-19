import { TextDecoder } from "node:util";
import { ArchiveError, readZipEntry } from "@argent/archive";
import { FAILURE_CODES, FailureError } from "@argent/registry";

const RES_XML_TYPE = 0x0003;
const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const UTF8_FLAG = 0x100;
const TYPE_STRING = 0x03;
const NO_INDEX = 0xffffffff;
const utf16Decoder = new TextDecoder("utf-16le");

function artifactFailure(message: string): FailureError {
  return new FailureError(message, {
    error_code: FAILURE_CODES.APP_INSTALL_ARTIFACT_INVALID,
    failure_stage: "app_install_read_android_manifest",
    failure_area: "tool_server",
    error_kind: "validation",
  });
}

function validPackageName(value: string | undefined): value is string {
  return Boolean(
    value &&
    /^[A-Za-z_][A-Za-z0-9_.]*$/.test(value) &&
    !value.includes("..") &&
    !value.endsWith(".")
  );
}

function parseTextManifestPackageName(text: string): string | undefined {
  const match = text.match(/<manifest\b[^>]*\bpackage\s*=\s*["']([^"']+)["']/i);
  return validPackageName(match?.[1]) ? match[1] : undefined;
}

function readLength8(buffer: Buffer, offset: number): [number, number] | undefined {
  if (offset >= buffer.length) return undefined;
  const first = buffer.readUInt8(offset);
  if ((first & 0x80) === 0) return [first, 1];
  if (offset + 1 >= buffer.length) return undefined;
  return [((first & 0x7f) << 8) | buffer.readUInt8(offset + 1), 2];
}

function readLength16(buffer: Buffer, offset: number): [number, number] | undefined {
  if (offset + 2 > buffer.length) return undefined;
  const first = buffer.readUInt16LE(offset);
  if ((first & 0x8000) === 0) return [first, 2];
  if (offset + 4 > buffer.length) return undefined;
  return [((first & 0x7fff) << 16) | buffer.readUInt16LE(offset + 2), 4];
}

function readUtf8String(buffer: Buffer, offset: number): string | undefined {
  const utf16Length = readLength8(buffer, offset);
  if (!utf16Length) return undefined;
  const byteLength = readLength8(buffer, offset + utf16Length[1]);
  if (!byteLength) return undefined;
  const start = offset + utf16Length[1] + byteLength[1];
  const end = start + byteLength[0];
  return end <= buffer.length ? buffer.subarray(start, end).toString("utf8") : undefined;
}

function readUtf16String(buffer: Buffer, offset: number): string | undefined {
  const length = readLength16(buffer, offset);
  if (!length) return undefined;
  const start = offset + length[1];
  const end = start + length[0] * 2;
  return end <= buffer.length ? utf16Decoder.decode(buffer.subarray(start, end)) : undefined;
}

function parseStringPool(chunk: Buffer): string[] | undefined {
  if (chunk.length < 28) return undefined;
  const headerSize = chunk.readUInt16LE(2);
  const stringCount = chunk.readUInt32LE(8);
  const flags = chunk.readUInt32LE(16);
  const stringsStart = chunk.readUInt32LE(20);
  if (
    headerSize < 28 ||
    headerSize + stringCount * 4 > chunk.length ||
    stringsStart >= chunk.length ||
    stringCount > 1_000_000
  ) {
    return undefined;
  }

  const strings: string[] = [];
  const utf8 = (flags & UTF8_FLAG) !== 0;
  for (let index = 0; index < stringCount; index += 1) {
    const stringOffset = chunk.readUInt32LE(headerSize + index * 4);
    const absoluteOffset = stringsStart + stringOffset;
    const value = utf8
      ? readUtf8String(chunk, absoluteOffset)
      : readUtf16String(chunk, absoluteOffset);
    if (value === undefined) return undefined;
    strings.push(value);
  }
  return strings;
}

function parseStartElementPackageName(
  buffer: Buffer,
  chunkOffset: number,
  chunkSize: number,
  strings: string[]
): string | undefined {
  if (chunkSize < 36 || chunkOffset + chunkSize > buffer.length) return undefined;
  const nameIndex = buffer.readUInt32LE(chunkOffset + 20);
  if (strings[nameIndex] !== "manifest") return undefined;

  const attributeStart = buffer.readUInt16LE(chunkOffset + 24);
  const attributeSize = buffer.readUInt16LE(chunkOffset + 26);
  const attributeCount = buffer.readUInt16LE(chunkOffset + 28);
  if (attributeSize < 20) return undefined;
  // `attributeStart` is relative to ResXMLTree_attrExt, which begins after
  // the 16-byte ResXMLTree_node header.
  const firstAttributeOffset = chunkOffset + 16 + attributeStart;
  if (firstAttributeOffset + attributeSize * attributeCount > chunkOffset + chunkSize) {
    return undefined;
  }

  for (let index = 0; index < attributeCount; index += 1) {
    const attributeOffset = firstAttributeOffset + index * attributeSize;
    if (strings[buffer.readUInt32LE(attributeOffset + 4)] !== "package") continue;

    const rawValueIndex = buffer.readUInt32LE(attributeOffset + 8);
    if (rawValueIndex !== NO_INDEX) {
      const rawValue = strings[rawValueIndex];
      return validPackageName(rawValue) ? rawValue : undefined;
    }
    if (buffer.readUInt8(attributeOffset + 15) !== TYPE_STRING) return undefined;
    const typedValue = strings[buffer.readUInt32LE(attributeOffset + 16)];
    return validPackageName(typedValue) ? typedValue : undefined;
  }
  return undefined;
}

function parseBinaryManifestPackageName(buffer: Buffer): string | undefined {
  if (buffer.length < 8 || buffer.readUInt16LE(0) !== RES_XML_TYPE) return undefined;
  const documentSize = buffer.readUInt32LE(4);
  if (documentSize > buffer.length) return undefined;

  let strings: string[] | undefined;
  for (let offset = buffer.readUInt16LE(2); offset + 8 <= documentSize; ) {
    const type = buffer.readUInt16LE(offset);
    const headerSize = buffer.readUInt16LE(offset + 2);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (headerSize < 8 || chunkSize < headerSize || offset + chunkSize > documentSize) {
      return undefined;
    }
    if (type === RES_STRING_POOL_TYPE) {
      strings = parseStringPool(buffer.subarray(offset, offset + chunkSize));
      if (!strings) return undefined;
    } else if (type === RES_XML_START_ELEMENT_TYPE && strings) {
      const packageName = parseStartElementPackageName(buffer, offset, chunkSize, strings);
      if (packageName) return packageName;
    }
    offset += chunkSize;
  }
  return undefined;
}

function parseManifestPackageName(manifest: Buffer): string | undefined {
  try {
    const textPrefix = manifest.subarray(0, Math.min(manifest.length, 128)).toString("utf8");
    return textPrefix.trimStart().startsWith("<")
      ? parseTextManifestPackageName(manifest.toString("utf8"))
      : parseBinaryManifestPackageName(manifest);
  } catch {
    return undefined;
  }
}

export async function resolveAndroidPackageName(apkPath: string): Promise<string> {
  let manifest: Buffer | undefined;
  try {
    manifest = await readZipEntry(apkPath, "AndroidManifest.xml");
  } catch (error) {
    if (error instanceof ArchiveError) {
      throw artifactFailure(`Could not read the APK archive: ${error.message}`);
    }
    throw error;
  }
  if (!manifest) {
    throw artifactFailure("Android app artifact is not an APK (AndroidManifest.xml is missing).");
  }
  const packageName = parseManifestPackageName(manifest);
  if (!packageName) {
    throw artifactFailure("Could not resolve the package name from the APK manifest.");
  }
  return packageName;
}
