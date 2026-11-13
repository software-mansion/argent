import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const TEMPLATE = path.resolve(__dirname, "../../src/utils/ios-profiler/Argent.tracetemplate");

type PlistValue =
  null | boolean | number | string | { uid: number } | PlistValue[] | { [key: string]: PlistValue };

/** The objects of a binary plist (bplist00) that a template uses, enough to read an NSKeyedArchiver. */
function readBinaryPlist(bytes: Buffer): PlistValue {
  const trailer = bytes.subarray(bytes.length - 32);
  const offsetSize = trailer[6]!;
  const refSize = trailer[7]!;
  const top = Number(trailer.readBigUInt64BE(16));
  const table = Number(trailer.readBigUInt64BE(24));
  const offsetOf = (ref: number) => bytes.readUIntBE(table + ref * offsetSize, offsetSize);
  const lengthAt = (at: number): [number, number] => {
    const low = bytes[at]! & 0xf;
    if (low !== 0xf) return [low, at + 1];
    const size = 1 << (bytes[at + 1]! & 0xf);
    return [bytes.readUIntBE(at + 2, size), at + 2 + size];
  };
  const refsAt = (at: number, count: number) =>
    Array.from({ length: count }, (_, i) => bytes.readUIntBE(at + i * refSize, refSize));
  const read = (ref: number): PlistValue => {
    const at = offsetOf(ref);
    const marker = bytes[at]!;
    switch (marker >> 4) {
      case 0x0:
        return marker === 0x09 ? true : marker === 0x08 ? false : null;
      case 0x1:
        return bytes.readUIntBE(at + 1, Math.min(1 << (marker & 0xf), 6));
      case 0x5: {
        const [n, from] = lengthAt(at);
        return bytes.toString("latin1", from, from + n);
      }
      case 0x6: {
        const [n, from] = lengthAt(at);
        return Buffer.from(bytes.subarray(from, from + 2 * n))
          .swap16()
          .toString("utf16le");
      }
      case 0x8:
        return { uid: bytes.readUIntBE(at + 1, (marker & 0xf) + 1) };
      case 0xa: {
        const [n, from] = lengthAt(at);
        return refsAt(from, n).map(read);
      }
      case 0xd: {
        const [n, from] = lengthAt(at);
        const keys = refsAt(from, n);
        const values = refsAt(from + n * refSize, n);
        return Object.fromEntries(keys.map((k, i) => [read(k) as string, read(values[i]!)]));
      }
      default:
        return null; // reals, dates and data: no setting below is one
    }
  };
  return read(top);
}

describe("the bundled Argent template", () => {
  it("does not name C++ objects during the recording", () => {
    // Allocations names each C++ object it records by symbolicating its vtable. On a
    // react-native-macos app, xctrace fell behind doing that, and the app blocked in
    // Instruments' recorder for 2.3 to 6 s: a false hang after the first taps in 5 of
    // 5 runs, none in 3 runs with this off. Leaks still names leaked C++ objects.
    const archive = readBinaryPlist(fs.readFileSync(TEMPLATE)) as { $objects: PlistValue[] };
    const objects = archive.$objects;
    const key = objects.indexOf("XRObjectAllocInstrumentIdentifyCppObjectsDefaultEnabledKey");
    expect(key).toBeGreaterThan(0);

    const settings = objects.filter(
      (o): o is { "NS.keys": { uid: number }[]; "NS.objects": { uid: number }[] } =>
        typeof o === "object" &&
        o !== null &&
        Array.isArray((o as Record<string, unknown>)["NS.keys"]) &&
        ((o as Record<string, PlistValue[]>)["NS.keys"] as { uid: number }[]).some(
          (k) => k.uid === key
        )
    );
    expect(settings).toHaveLength(1);
    const at = settings[0]!["NS.keys"].findIndex((k) => k.uid === key);
    expect(objects[settings[0]!["NS.objects"][at]!.uid]).toBe(false);
  });
});
