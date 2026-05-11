import { describe, expect, it } from "vitest";
import * as net from "node:net";
import {
  buildToolsServerEnv,
  findFreePort,
  formatToolsServerUrl,
  isToolsServerHealthy,
  isToolsServerProcessAlive,
} from "../src/launcher.js";

const paths = {
  bundlePath: "/pkg/dist/tool-server.cjs",
  simulatorServerDir: "/pkg/bin",
  nativeDevtoolsDir: "/pkg/dylibs",
};

describe("buildToolsServerEnv — host and idle options", () => {
  it("does not set ARGENT_HOST or ARGENT_IDLE_TIMEOUT_MINUTES when options are omitted", () => {
    const env = buildToolsServerEnv(paths, 3001, {});
    expect(env.ARGENT_HOST).toBeUndefined();
    expect(env.ARGENT_IDLE_TIMEOUT_MINUTES).toBeUndefined();
  });

  it("propagates host into ARGENT_HOST", () => {
    const env = buildToolsServerEnv(paths, 3001, {}, { host: "0.0.0.0" });
    expect(env.ARGENT_HOST).toBe("0.0.0.0");
  });

  it("propagates idleTimeoutMinutes (including 0) into ARGENT_IDLE_TIMEOUT_MINUTES", () => {
    const enabled = buildToolsServerEnv(paths, 3001, {}, { idleTimeoutMinutes: 5 });
    expect(enabled.ARGENT_IDLE_TIMEOUT_MINUTES).toBe("5");

    // 0 is a real value (disable), not "omitted" — must still be passed through.
    const disabled = buildToolsServerEnv(paths, 3001, {}, { idleTimeoutMinutes: 0 });
    expect(disabled.ARGENT_IDLE_TIMEOUT_MINUTES).toBe("0");
  });

  it("preserves base env variables unchanged", () => {
    const env = buildToolsServerEnv(paths, 3001, { FOO: "bar", PATH: "/usr/bin" });
    expect(env.FOO).toBe("bar");
    expect(env.PATH).toBe("/usr/bin");
  });
});

describe("formatToolsServerUrl", () => {
  it("formats hostnames and IPv4 without brackets", () => {
    expect(formatToolsServerUrl("127.0.0.1", 3001)).toBe("http://127.0.0.1:3001");
    expect(formatToolsServerUrl("localhost", 8080)).toBe("http://localhost:8080");
  });

  it("brackets IPv6 literals per RFC 3986", () => {
    expect(formatToolsServerUrl("::1", 3001)).toBe("http://[::1]:3001");
    expect(formatToolsServerUrl("2001:db8::1", 80)).toBe("http://[2001:db8::1]:80");
  });

  it("does not double-bracket already-bracketed IPv6", () => {
    expect(formatToolsServerUrl("[::1]", 3001)).toBe("http://[::1]:3001");
  });
});

describe("findFreePort", () => {
  it("returns a port in the ephemeral range", async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });

  it("returns ports that are actually bindable", async () => {
    const port = await findFreePort();
    await new Promise<void>((resolve, reject) => {
      const srv = net.createServer();
      srv.once("error", reject);
      srv.listen(port, "127.0.0.1", () => {
        srv.close((err) => (err ? reject(err) : resolve()));
      });
    });
  });
});

describe("isToolsServerProcessAlive", () => {
  it("reports the current process as alive", () => {
    expect(isToolsServerProcessAlive(process.pid)).toBe(true);
  });

  it("reports an obviously-dead pid as not alive", () => {
    // PID 0 maps to the process group on POSIX; `process.kill(0, 0)` typically
    // returns true (we own the group). Use a very large unlikely-to-exist PID
    // instead. This pid-space hole is the same trick `pgrep` uses in tests.
    const veryHighPid = 2_147_483_646;
    expect(isToolsServerProcessAlive(veryHighPid)).toBe(false);
  });
});

describe("isToolsServerHealthy", () => {
  it("returns false quickly when nothing is listening on the port", async () => {
    const port = await findFreePort();
    const start = Date.now();
    const healthy = await isToolsServerHealthy(port, "127.0.0.1", 1000);
    const elapsed = Date.now() - start;
    expect(healthy).toBe(false);
    // Should fail fast on connection refused — well under the timeout.
    expect(elapsed).toBeLessThan(1500);
  });

  it("respects the wildcard → loopback substitution (does not hang on 0.0.0.0)", async () => {
    const port = await findFreePort();
    const healthy = await isToolsServerHealthy(port, "0.0.0.0", 1500);
    // The healthCheckHost shim must rewrite 0.0.0.0 → 127.0.0.1 so the fetch
    // returns a connection-refused error rather than hanging until the timeout.
    expect(healthy).toBe(false);
  });
});
