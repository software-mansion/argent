import { describe, it, expect } from "vitest";
import { stripHangTimestamp, isKeyframe } from "../src/tools/screen-recording/moq-video-stream";

// A minimal Annex-B access unit: 4-byte start code + one NAL of the given type.
function annexb(nalType: number, startCode3 = false): Buffer {
  const sc = startCode3 ? [0x00, 0x00, 0x01] : [0x00, 0x00, 0x00, 0x01];
  // nal_ref_idc=3 (0x60) | type; e.g. type 7 → 0x67, type 5 → 0x65, type 1 → 0x61.
  return Buffer.from([...sc, 0x60 | nalType, 0xde, 0xad]);
}

describe("stripHangTimestamp", () => {
  it("strips a 1-byte VarInt (top bits 00 → length 1)", () => {
    const body = annexb(7);
    const frame = Buffer.concat([Buffer.from([0x05]), body]); // 0x05: prefix 00
    expect(stripHangTimestamp(frame)).toEqual(body);
  });

  it("strips a 2-byte VarInt (top bits 01 → length 2)", () => {
    const body = annexb(1);
    const frame = Buffer.concat([Buffer.from([0x40, 0x05]), body]); // 0x40: prefix 01
    expect(stripHangTimestamp(frame)).toEqual(body);
  });

  it("strips a 4-byte VarInt (top bits 10 → length 4)", () => {
    const body = annexb(5);
    // 0x8b… mirrors the real server frames observed on the wire.
    const frame = Buffer.concat([Buffer.from([0x8b, 0xf9, 0x41, 0x39]), body]);
    expect(stripHangTimestamp(frame)).toEqual(body);
  });

  it("strips an 8-byte VarInt (top bits 11 → length 8)", () => {
    const body = annexb(1);
    const frame = Buffer.concat([Buffer.from([0xc0, 1, 2, 3, 4, 5, 6, 7]), body]);
    expect(stripHangTimestamp(frame)).toEqual(body);
  });

  it("returns empty for an empty frame", () => {
    expect(stripHangTimestamp(Buffer.alloc(0))).toEqual(Buffer.alloc(0));
  });

  it("clamps when the VarInt length exceeds the frame", () => {
    // 0xc0 claims an 8-byte VarInt but only 3 bytes follow.
    expect(stripHangTimestamp(Buffer.from([0xc0, 1, 2]))).toEqual(Buffer.alloc(0));
  });
});

describe("isKeyframe", () => {
  it("detects an SPS NAL (type 7) as a keyframe", () => {
    expect(isKeyframe(annexb(7))).toBe(true);
    expect(isKeyframe(annexb(7, /* startCode3 */ true))).toBe(true);
  });

  it("detects an IDR slice (type 5) as a keyframe", () => {
    expect(isKeyframe(annexb(5))).toBe(true);
  });

  it("does not flag a non-IDR slice (type 1)", () => {
    expect(isKeyframe(annexb(1))).toBe(false);
  });

  it("does not flag a bare byte string with no start code", () => {
    expect(isKeyframe(Buffer.from([0x27, 0x00, 0x00]))).toBe(false);
    expect(isKeyframe(Buffer.alloc(0))).toBe(false);
  });

  it("finds the SPS even when a leading PPS-like NAL precedes it", () => {
    // PPS (type 8) then SPS (type 7): a real keyframe AU leads with SPS/PPS.
    const pps = annexb(8);
    const sps = annexb(7);
    expect(isKeyframe(Buffer.concat([pps, sps]))).toBe(true);
  });
});
