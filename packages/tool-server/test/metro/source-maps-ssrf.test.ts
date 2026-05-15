import { describe, it, expect } from "vitest";
import { isAllowedSourceMapURL } from "../../src/utils/debugger/source-maps";

describe("isAllowedSourceMapURL", () => {
  it("accepts a Metro localhost URL", () => {
    expect(isAllowedSourceMapURL("http://localhost:8081/index.map")).toBe(true);
  });

  it("accepts http://127.0.0.1", () => {
    expect(isAllowedSourceMapURL("http://127.0.0.1:8082/foo.map")).toBe(true);
  });

  it("accepts http://[::1]", () => {
    expect(isAllowedSourceMapURL("http://[::1]:8081/foo.map")).toBe(true);
  });

  it("accepts https on loopback", () => {
    expect(isAllowedSourceMapURL("https://localhost:8443/foo.map")).toBe(true);
  });

  it("rejects an attacker-controlled public host", () => {
    expect(isAllowedSourceMapURL("http://attacker.example/leak")).toBe(false);
  });

  it("rejects the AWS metadata endpoint", () => {
    expect(isAllowedSourceMapURL("http://169.254.169.254/latest/meta-data/")).toBe(false);
  });

  it("rejects a private-network host that is not loopback", () => {
    expect(isAllowedSourceMapURL("http://10.0.0.1/secret.map")).toBe(false);
    expect(isAllowedSourceMapURL("http://192.168.1.1/secret.map")).toBe(false);
  });

  it("rejects file:// URLs", () => {
    expect(isAllowedSourceMapURL("file:///etc/passwd")).toBe(false);
  });

  it("rejects malformed URLs", () => {
    expect(isAllowedSourceMapURL("not a url")).toBe(false);
    expect(isAllowedSourceMapURL("")).toBe(false);
  });

  it("rejects an unbracketed IPv6 typo", () => {
    expect(isAllowedSourceMapURL("http://::1:8081/")).toBe(false);
  });
});
