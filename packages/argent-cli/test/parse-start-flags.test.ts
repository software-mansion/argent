import { describe, expect, it } from "vitest";
import { parseStartFlags, parsePort, parseIdle, StartFlagError } from "../src/server.js";

describe("parseStartFlags", () => {
  it("returns the documented defaults for an empty argv", () => {
    expect(parseStartFlags([])).toEqual({
      port: null,
      host: "127.0.0.1",
      idleTimeoutMinutes: 0,
      detach: false,
      force: false,
      help: false,
    });
  });

  it("parses --port in space and equals form, plus -p alias", () => {
    expect(parseStartFlags(["--port", "4000"]).port).toBe(4000);
    expect(parseStartFlags(["--port=4000"]).port).toBe(4000);
    expect(parseStartFlags(["-p", "4000"]).port).toBe(4000);
  });

  it("accepts port 0 as the 'pick a free port' sentinel", () => {
    expect(parseStartFlags(["--port", "0"]).port).toBe(0);
  });

  it("parses --host in space and equals form", () => {
    expect(parseStartFlags(["--host", "0.0.0.0"]).host).toBe("0.0.0.0");
    expect(parseStartFlags(["--host=::1"]).host).toBe("::1");
  });

  it("parses --idle-timeout in space and equals form", () => {
    expect(parseStartFlags(["--idle-timeout", "5"]).idleTimeoutMinutes).toBe(5);
    expect(parseStartFlags(["--idle-timeout=10"]).idleTimeoutMinutes).toBe(10);
    expect(parseStartFlags(["--idle-timeout=0"]).idleTimeoutMinutes).toBe(0);
  });

  it("parses boolean flags --detach/-d, --force, --help/-h", () => {
    expect(parseStartFlags(["--detach"]).detach).toBe(true);
    expect(parseStartFlags(["-d"]).detach).toBe(true);
    expect(parseStartFlags(["--force"]).force).toBe(true);
    expect(parseStartFlags(["--help"]).help).toBe(true);
    expect(parseStartFlags(["-h"]).help).toBe(true);
  });

  it("combines multiple flags in a single invocation", () => {
    const flags = parseStartFlags([
      "--detach",
      "--force",
      "--host",
      "0.0.0.0",
      "--port=4567",
      "--idle-timeout",
      "15",
    ]);
    expect(flags).toEqual({
      port: 4567,
      host: "0.0.0.0",
      idleTimeoutMinutes: 15,
      detach: true,
      force: true,
      help: false,
    });
  });

  it("throws StartFlagError on unknown flags", () => {
    expect(() => parseStartFlags(["--bogus"])).toThrow(StartFlagError);
    expect(() => parseStartFlags(["--bogus"])).toThrow(/Unknown flag: --bogus/);
  });

  it("throws when a value-taking flag is missing its value", () => {
    expect(() => parseStartFlags(["--port"])).toThrow(/--port requires a value/);
    expect(() => parseStartFlags(["--host"])).toThrow(/--host requires a value/);
    expect(() => parseStartFlags(["--idle-timeout"])).toThrow(/--idle-timeout requires a value/);
  });

  it("does not consume the next token as a value for boolean flags", () => {
    // `--detach` must NOT swallow the next token; here `--force` is a separate flag.
    expect(parseStartFlags(["--detach", "--force"])).toMatchObject({
      detach: true,
      force: true,
    });
  });
});

describe("parsePort", () => {
  it("accepts integers in 0..65535", () => {
    expect(parsePort("0")).toBe(0);
    expect(parsePort("3001")).toBe(3001);
    expect(parsePort("65535")).toBe(65535);
  });

  it("rejects values out of range", () => {
    expect(() => parsePort("65536")).toThrow(StartFlagError);
    expect(() => parsePort("99999")).toThrow(/0\.\.65535/);
  });

  it("rejects values that parseInt would silently truncate", () => {
    // Without the strict-digits regex these would silently parse to 123.
    expect(() => parsePort("123abc")).toThrow(/got "123abc"/);
    expect(() => parsePort("0x10")).toThrow(StartFlagError);
    expect(() => parsePort("3.14")).toThrow(StartFlagError);
    expect(() => parsePort("1e3")).toThrow(StartFlagError);
  });

  it("rejects negative numbers and signs", () => {
    expect(() => parsePort("-1")).toThrow(StartFlagError);
    expect(() => parsePort("+3001")).toThrow(StartFlagError);
  });

  it("rejects empty strings and whitespace", () => {
    expect(() => parsePort("")).toThrow(StartFlagError);
    expect(() => parsePort(" ")).toThrow(StartFlagError);
    expect(() => parsePort(" 3001 ")).toThrow(StartFlagError);
  });
});

describe("parseIdle", () => {
  it("accepts non-negative integers including 0", () => {
    expect(parseIdle("0")).toBe(0);
    expect(parseIdle("5")).toBe(5);
    expect(parseIdle("1440")).toBe(1440);
  });

  it("rejects negative, decimal, and garbage values", () => {
    expect(() => parseIdle("-1")).toThrow(StartFlagError);
    expect(() => parseIdle("3.5")).toThrow(StartFlagError);
    expect(() => parseIdle("abc")).toThrow(/got "abc"/);
    expect(() => parseIdle("")).toThrow(StartFlagError);
  });
});
