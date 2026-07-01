import { describe, expect, it } from "vitest";
import { uuidv5 } from "../src/uuidv5.js";

// RFC 4122 reference namespaces.
const NAMESPACE_DNS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

describe("uuidv5", () => {
  it("matches the canonical DNS namespace vector (python uuid5)", () => {
    // uuid.uuid5(uuid.NAMESPACE_DNS, "python.org")
    expect(uuidv5("python.org", NAMESPACE_DNS)).toBe("886313e1-3b8a-5372-9b90-0c9aee199e5d");
  });

  it("is deterministic for the same (name, namespace)", () => {
    const a = uuidv5("a1b2c3d4e5f6a7b8", NAMESPACE_DNS);
    const b = uuidv5("a1b2c3d4e5f6a7b8", NAMESPACE_DNS);
    expect(a).toBe(b);
  });

  it("differs for different names", () => {
    expect(uuidv5("name-one", NAMESPACE_DNS)).not.toBe(uuidv5("name-two", NAMESPACE_DNS));
  });

  it("stamps version 5 and the RFC 4122 variant", () => {
    const id = uuidv5("anything", NAMESPACE_DNS);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // Version nibble (first char of the 3rd group) is 5.
    expect(id[14]).toBe("5");
    // Variant nibble (first char of the 4th group) is one of 8,9,a,b.
    expect(["8", "9", "a", "b"]).toContain(id[19]);
  });

  it("rejects a malformed namespace", () => {
    expect(() => uuidv5("name", "not-a-uuid")).toThrow();
  });
});
