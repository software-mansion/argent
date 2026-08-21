const BPLIST_HEADER = Buffer.from("bplist00", "ascii");
const MAX_PLIST_OBJECTS = 1_000_000;

interface SizedPayload {
  length: number;
  offset: number;
}

function readUnsigned(buffer: Buffer, offset: number, byteLength: number): number | undefined {
  if (byteLength < 1 || byteLength > 8 || offset < 0 || offset + byteLength > buffer.length) {
    return undefined;
  }
  let value = 0n;
  for (let index = 0; index < byteLength; index += 1) {
    value = (value << 8n) | BigInt(buffer[offset + index]!);
  }
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
}

function readSizedPayload(
  buffer: Buffer,
  objectOffset: number,
  info: number
): SizedPayload | undefined {
  if (info < 0x0f) return { length: info, offset: objectOffset + 1 };
  const lengthMarker = buffer[objectOffset + 1];
  if (lengthMarker === undefined || lengthMarker >> 4 !== 0x01) return undefined;
  const integerBytes = 2 ** (lengthMarker & 0x0f);
  const length = readUnsigned(buffer, objectOffset + 2, integerBytes);
  return length === undefined ? undefined : { length, offset: objectOffset + 2 + integerBytes };
}

function readUtf16Be(buffer: Buffer, offset: number, codeUnitCount: number): string | undefined {
  const byteLength = codeUnitCount * 2;
  if (!Number.isSafeInteger(byteLength) || offset + byteLength > buffer.length) return undefined;
  let result = "";
  for (let index = 0; index < codeUnitCount; index += 1) {
    result += String.fromCharCode(buffer.readUInt16BE(offset + index * 2));
  }
  return result;
}

class BinaryPlistReader {
  private constructor(
    private readonly buffer: Buffer,
    private readonly objectRefSize: number,
    private readonly offsets: number[],
    private readonly topObject: number
  ) {}

  static create(buffer: Buffer): BinaryPlistReader | undefined {
    if (buffer.length < 40 || !buffer.subarray(0, 8).equals(BPLIST_HEADER)) return undefined;
    const trailerOffset = buffer.length - 32;
    const offsetIntSize = buffer[trailerOffset + 6];
    const objectRefSize = buffer[trailerOffset + 7];
    if (!offsetIntSize || !objectRefSize || offsetIntSize > 8 || objectRefSize > 8)
      return undefined;

    const objectCount = readUnsigned(buffer, trailerOffset + 8, 8);
    const topObject = readUnsigned(buffer, trailerOffset + 16, 8);
    const offsetTableOffset = readUnsigned(buffer, trailerOffset + 24, 8);
    if (
      objectCount === undefined ||
      objectCount < 1 ||
      objectCount > MAX_PLIST_OBJECTS ||
      topObject === undefined ||
      topObject >= objectCount ||
      offsetTableOffset === undefined ||
      offsetTableOffset < 8 ||
      offsetTableOffset + objectCount * offsetIntSize > trailerOffset
    ) {
      return undefined;
    }

    const offsets: number[] = [];
    for (let index = 0; index < objectCount; index += 1) {
      const offset = readUnsigned(buffer, offsetTableOffset + index * offsetIntSize, offsetIntSize);
      if (offset === undefined || offset < 8 || offset >= offsetTableOffset) return undefined;
      offsets.push(offset);
    }
    return new BinaryPlistReader(buffer, objectRefSize, offsets, topObject);
  }

  private readReference(offset: number): number | undefined {
    const reference = readUnsigned(this.buffer, offset, this.objectRefSize);
    return reference !== undefined && reference < this.offsets.length ? reference : undefined;
  }

  private readString(objectIndex: number): string | undefined {
    const objectOffset = this.offsets[objectIndex];
    if (objectOffset === undefined) return undefined;
    const marker = this.buffer[objectOffset];
    if (marker === undefined) return undefined;
    const type = marker >> 4;
    if (type !== 0x05 && type !== 0x06 && type !== 0x07) return undefined;
    const payload = readSizedPayload(this.buffer, objectOffset, marker & 0x0f);
    if (!payload) return undefined;

    if (type === 0x06) return readUtf16Be(this.buffer, payload.offset, payload.length);
    if (payload.offset + payload.length > this.buffer.length) return undefined;
    return this.buffer
      .subarray(payload.offset, payload.offset + payload.length)
      .toString(type === 0x05 ? "ascii" : "utf8");
  }

  readDictionaryString(key: string): string | undefined {
    const objectOffset = this.offsets[this.topObject];
    if (objectOffset === undefined) return undefined;
    const marker = this.buffer[objectOffset];
    if (marker === undefined || marker >> 4 !== 0x0d) return undefined;
    const payload = readSizedPayload(this.buffer, objectOffset, marker & 0x0f);
    if (!payload) return undefined;
    const referencesBytes = payload.length * this.objectRefSize * 2;
    if (
      !Number.isSafeInteger(referencesBytes) ||
      payload.offset + referencesBytes > this.buffer.length
    ) {
      return undefined;
    }

    const valuesOffset = payload.offset + payload.length * this.objectRefSize;
    for (let index = 0; index < payload.length; index += 1) {
      const keyReference = this.readReference(payload.offset + index * this.objectRefSize);
      if (keyReference === undefined || this.readString(keyReference) !== key) continue;
      const valueReference = this.readReference(valuesOffset + index * this.objectRefSize);
      return valueReference === undefined ? undefined : this.readString(valueReference);
    }
    return undefined;
  }
}

export function readBinaryPlistString(plist: Buffer, key: string): string | undefined {
  try {
    return BinaryPlistReader.create(plist)?.readDictionaryString(key);
  } catch {
    return undefined;
  }
}
