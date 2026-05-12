import { describe, expect, it } from "vitest";
import { parseLinkFlags, parseUnlinkFlags } from "../src/link.js";
import { StartFlagError } from "../src/server.js";

describe("parseLinkFlags — defaults", () => {
  it("returns documented defaults for an empty argv", () => {
    expect(parseLinkFlags([])).toEqual({
      host: null,
      port: null,
      yes: false,
      noVerify: false,
      help: false,
    });
  });
});

describe("parseLinkFlags — flag forms", () => {
  it("parses --host in space and equals form", () => {
    expect(parseLinkFlags(["--host", "10.0.0.42"]).host).toBe("10.0.0.42");
    expect(parseLinkFlags(["--host=10.0.0.42"]).host).toBe("10.0.0.42");
  });

  it("parses --port/-p in space and equals form", () => {
    expect(parseLinkFlags(["--port", "4000"]).port).toBe(4000);
    expect(parseLinkFlags(["-p", "4000"]).port).toBe(4000);
    expect(parseLinkFlags(["--port=4000"]).port).toBe(4000);
  });

  it("parses boolean flags --yes/-y, --no-verify, --help/-h", () => {
    expect(parseLinkFlags(["--yes"]).yes).toBe(true);
    expect(parseLinkFlags(["-y"]).yes).toBe(true);
    expect(parseLinkFlags(["--no-verify"]).noVerify).toBe(true);
    expect(parseLinkFlags(["--help"]).help).toBe(true);
    expect(parseLinkFlags(["-h"]).help).toBe(true);
  });

  it("combines multiple flags in a single invocation", () => {
    const flags = parseLinkFlags(["--host", "10.0.0.42", "--port=4567", "--yes", "--no-verify"]);
    expect(flags).toEqual({
      host: "10.0.0.42",
      port: 4567,
      yes: true,
      noVerify: true,
      help: false,
    });
  });
});

describe("parseLinkFlags — error paths", () => {
  it("throws StartFlagError on unknown flags", () => {
    expect(() => parseLinkFlags(["--bogus"])).toThrow(StartFlagError);
    expect(() => parseLinkFlags(["--bogus"])).toThrow(/Unknown flag: --bogus/);
  });

  it("throws when a value-taking flag is missing its value", () => {
    expect(() => parseLinkFlags(["--host"])).toThrow(/--host requires a value/);
    expect(() => parseLinkFlags(["--port"])).toThrow(/--port requires a value/);
    expect(() => parseLinkFlags(["-p"])).toThrow(/--port requires a value/);
  });

  it("does not consume the next token as a value for boolean flags", () => {
    // `--yes` must NOT swallow the next token; here `--no-verify` is a separate flag.
    expect(parseLinkFlags(["--yes", "--no-verify"])).toMatchObject({
      yes: true,
      noVerify: true,
    });
  });
});

describe("parseLinkFlags — host validation (wildcard rejection)", () => {
  // The four documented wildcards: empty, 0.0.0.0, ::, ::0.
  // These are bind addresses, not connect targets — link() refuses them so
  // users don't persist a target they can't reach.
  it.each([["0.0.0.0"], ["::"], ["::0"], [""]])("rejects wildcard host %p", (wildcard) => {
    expect(() => parseLinkFlags(["--host", wildcard])).toThrow(StartFlagError);
    expect(() => parseLinkFlags(["--host", wildcard])).toThrow(
      /bind address, not a connect address/
    );
  });

  it("rejects wildcards in --host=value form too", () => {
    expect(() => parseLinkFlags(["--host=0.0.0.0"])).toThrow(StartFlagError);
    expect(() => parseLinkFlags(["--host=::"])).toThrow(StartFlagError);
  });

  it("trims whitespace before validating (so '  0.0.0.0  ' is still rejected)", () => {
    expect(() => parseLinkFlags(["--host", "  0.0.0.0  "])).toThrow(
      /bind address, not a connect address/
    );
  });

  it("trims whitespace from valid hosts and stores the trimmed value", () => {
    expect(parseLinkFlags(["--host", "  10.0.0.42  "]).host).toBe("10.0.0.42");
  });

  it("accepts normal loopback and routable hosts", () => {
    expect(parseLinkFlags(["--host", "127.0.0.1"]).host).toBe("127.0.0.1");
    expect(parseLinkFlags(["--host", "localhost"]).host).toBe("localhost");
    expect(parseLinkFlags(["--host", "::1"]).host).toBe("::1");
    expect(parseLinkFlags(["--host", "tools.example.com"]).host).toBe("tools.example.com");
    expect(parseLinkFlags(["--host", "10.0.0.42"]).host).toBe("10.0.0.42");
  });
});

describe("parseLinkFlags — port validation (connect-target rules)", () => {
  // validateConnectPort intentionally diverges from parseStartFlags' parsePort:
  // `server start --port 0` means "pick a free port", but you can never
  // *connect* to port 0, so `link --port 0` must be rejected.
  it("rejects port 0 (the bind-time 'pick a free port' sentinel)", () => {
    expect(() => parseLinkFlags(["--port", "0"])).toThrow(StartFlagError);
    expect(() => parseLinkFlags(["--port", "0"])).toThrow(/1\.\.65535/);
    expect(() => parseLinkFlags(["--port=0"])).toThrow(StartFlagError);
  });

  it("accepts 1..65535", () => {
    expect(parseLinkFlags(["--port", "1"]).port).toBe(1);
    expect(parseLinkFlags(["--port", "3001"]).port).toBe(3001);
    expect(parseLinkFlags(["--port", "65535"]).port).toBe(65535);
  });

  it("rejects out-of-range values (inherited from parsePort)", () => {
    expect(() => parseLinkFlags(["--port", "65536"])).toThrow(/0\.\.65535/);
    expect(() => parseLinkFlags(["--port", "-1"])).toThrow(StartFlagError);
  });

  it("rejects garbage values that parseInt would silently truncate", () => {
    expect(() => parseLinkFlags(["--port", "123abc"])).toThrow(/got "123abc"/);
    expect(() => parseLinkFlags(["--port", "3.14"])).toThrow(StartFlagError);
  });
});

describe("parseUnlinkFlags", () => {
  it("returns documented defaults for an empty argv", () => {
    expect(parseUnlinkFlags([])).toEqual({ yes: false, help: false });
  });

  it("parses --yes/-y and --help/-h", () => {
    expect(parseUnlinkFlags(["--yes"]).yes).toBe(true);
    expect(parseUnlinkFlags(["-y"]).yes).toBe(true);
    expect(parseUnlinkFlags(["--help"]).help).toBe(true);
    expect(parseUnlinkFlags(["-h"]).help).toBe(true);
  });

  it("throws StartFlagError on unknown flags (no positional args allowed)", () => {
    expect(() => parseUnlinkFlags(["--bogus"])).toThrow(StartFlagError);
    expect(() => parseUnlinkFlags(["--bogus"])).toThrow(/Unknown flag: --bogus/);
    // Unlink takes no positional args either — anything not --yes/--help fails.
    expect(() => parseUnlinkFlags(["foo"])).toThrow(/Unknown flag: foo/);
  });
});
