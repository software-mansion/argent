import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseDebugStack,
  normalizeBundleUrl,
} from "../../src/metro/source-resolver";

describe("parseDebugStack", () => {
  it("parses stack frames correctly", () => {
    const stack = `Error: react-stack-top-frame
    at anonymous  (http://localhost:8081/index.bundle?platform=ios&dev=true:100:20)
    at App (http://localhost:8081/index.bundle?platform=ios&dev=true:200:10)
    at react_stack_bottom_frame (native)`;

    const frames = parseDebugStack(stack);
    expect(frames).toHaveLength(3);
    expect(frames[0].fn).toBe("anonymous");
    expect(frames[0].line).toBe(100);
    expect(frames[0].col).toBe(20);

    expect(frames[1].fn).toBe("App");
    expect(frames[1].line).toBe(200);
    expect(frames[1].col).toBe(10);
  });

  it("returns frame[1] as the JSX call-site", () => {
    const stack = `Error: react-stack-top-frame
    at anonymous (http://localhost:8081/index.bundle:50:5)
    at ParentComponent (http://localhost:8081/index.bundle:120:8)`;

    const frames = parseDebugStack(stack);
    expect(frames[1].fn).toBe("ParentComponent");
    expect(frames[1].line).toBe(120);
  });
});

describe("normalizeBundleUrl", () => {
  it("normalizes iOS //& to ?", () => {
    const url = "http://localhost:8081/index.bundle//&platform=ios&dev=true";
    const result = normalizeBundleUrl(url, 8081);
    expect(result).toContain("?platform=ios");
    expect(result).not.toContain("//&");
  });

  it("rewrites Android host to localhost", () => {
    const url = "http://10.0.2.2:8081/index.bundle?platform=android&dev=true";
    const result = normalizeBundleUrl(url, 8081);
    expect(result).toContain("localhost");
    expect(result).not.toContain("10.0.2.2");
  });

  it("rewrites port to the Metro port", () => {
    const url = "http://localhost:9999/index.bundle?platform=ios";
    const result = normalizeBundleUrl(url, 8081);
    expect(result).toContain(":8081");
    expect(result).not.toContain("9999");
  });
});
