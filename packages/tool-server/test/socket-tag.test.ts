import { describe, it, expect } from "vitest";
import { axServiceSocketPath, nativeDevtoolsSocketPath, socketTag } from "../src/utils/socket-tag";

describe("socketTag", () => {
  it("keeps the first 8 characters of a plain UDID, the existing socket name", () => {
    expect(socketTag("0A1B2C3D-1111-2222-3333-444444444444")).toBe("0A1B2C3D");
  });

  it("gives two devices of one external provider distinct tags", () => {
    const a = socketTag("ext:acme-1a2b3c:0A1B2C3D-1111-2222-3333-444444444444");
    const b = socketTag("ext:acme-1a2b3c:9F8E7D6C-1111-2222-3333-444444444444");
    expect(a).not.toBe(b);
    expect(a).not.toBe("ext:acme");
  });

  it("is stable, short, and filename-safe for a non-UDID id", () => {
    const id = "ext:acme-1a2b3c:0A1B2C3D-1111-2222-3333-444444444444";
    expect(socketTag(id)).toBe(socketTag(id));
    expect(socketTag(id)).toMatch(/^[0-9a-f]{12}$/);
  });

  it("cannot collide with a UDID tag, which is 8 characters long", () => {
    expect(socketTag("ext:x:0A1B2C3D")).toHaveLength(12);
  });
});

describe.each([
  ["ax-service", axServiceSocketPath, "/tmp/ax-"],
  ["native-devtools", nativeDevtoolsSocketPath, "/tmp/argent-nd-"],
])("%s socket path", (_name, socketPath, prefix) => {
  it("keeps the 8-character name for a plain UDID", () => {
    expect(socketPath("0A1B2C3D-1111-2222-3333-444444444444")).toBe(`${prefix}0A1B2C3D.sock`);
  });

  it("gives two devices of one external provider different sockets", () => {
    const a = socketPath("ext:acme-1a2b3c:0A1B2C3D-1111-2222-3333-444444444444");
    const b = socketPath("ext:acme-1a2b3c:9F8E7D6C-1111-2222-3333-444444444444");
    expect(a).not.toBe(b);
    expect(a).toMatch(new RegExp(`^${prefix}[0-9a-f]{12}\\.sock$`));
  });
});
