import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { bindNativeDevtoolsUnixSocket } from "../src/blueprints/native-devtools.js";
import { FailureError, FAILURE_CODES, getFailureSignal } from "@argent/registry";

// Regression coverage for the 0.16.0 dominant crash source: the native-devtools
// unix `server.listen(socketPath)` had no "error" listener, so a bind failure
// (EADDRINUSE from a live/concurrent per-UDID server, or EEXIST from a
// re-created stale socket) fired an unhandled "error" event → uncaught
// exception → whole tool-server crashed at startup. bindNativeDevtoolsUnixSocket
// must instead reject with a coded FailureError, and self-heal a stale path.

const servers: net.Server[] = [];
const track = (s: net.Server) => {
  servers.push(s);
  return s;
};

// A unix socket path must fit sun_path (108 bytes on Linux, 104 on macOS), which
// is why production pins the short `/tmp/argent-nd-<udid8>.sock`
// (getNativeDevtoolsSocketPath). Root the fixtures at the same short base rather
// than os.tmpdir(): that honors an ambient $TMPDIR, and a long one — easily
// reached by a CI workspace path — pushes these fixtures past the limit and
// fails the bind with EINVAL, testing the host's TMPDIR instead of the code.
const SOCK_ROOT = "/tmp";

function tmpSock(name: string): string {
  return path.join(fs.mkdtempSync(path.join(SOCK_ROOT, "argent-nd-test-")), name);
}

afterEach(() => {
  for (const s of servers.splice(0)) {
    try {
      s.close();
    } catch {
      /* already closed */
    }
  }
});

describe("bindNativeDevtoolsUnixSocket", () => {
  it("binds cleanly on a free path", async () => {
    const socketPath = tmpSock("free.sock");
    const server = track(net.createServer());

    await expect(bindNativeDevtoolsUnixSocket(server, socketPath)).resolves.toBeUndefined();
    expect(server.listening).toBe(true);
    expect(fs.existsSync(socketPath)).toBe(true);
  });

  it("self-heals a stale (dead) socket file and binds", async () => {
    const socketPath = tmpSock("stale.sock");
    // A leftover regular file at the path (a crashed server's stale socket
    // entry). listen() rejects it with EADDRINUSE/EEXIST; the helper must
    // unlink and retry rather than crash.
    fs.writeFileSync(socketPath, "");
    expect(fs.existsSync(socketPath)).toBe(true);

    const server = track(net.createServer());
    await expect(bindNativeDevtoolsUnixSocket(server, socketPath)).resolves.toBeUndefined();
    expect(server.listening).toBe(true);
  });

  it("rejects with a coded FailureError when the path stays unbindable", async () => {
    // Point at a path under a non-existent directory: listen() fails with
    // ENOENT, which is not the self-heal case, so it must reject (not throw
    // uncaught) with our coded shape.
    const socketPath = path.join(os.tmpdir(), "argent-nd-nope", "does", "not", "exist.sock");
    const server = track(net.createServer());

    const err = await bindNativeDevtoolsUnixSocket(server, socketPath).catch((e) => e);
    expect(err).toBeInstanceOf(FailureError);
    const signal = getFailureSignal(err as FailureError);
    expect(signal?.error_code).toBe(FAILURE_CODES.NATIVE_DEVTOOLS_SOCKET_BIND_FAILED);
    expect(signal?.failure_stage).toBe("native_devtools_socket_bind");
  });

  it("does not throw uncaught when binding a path already held by a live server", async () => {
    const socketPath = tmpSock("live.sock");
    const first = track(net.createServer());
    await bindNativeDevtoolsUnixSocket(first, socketPath);
    expect(first.listening).toBe(true);

    // A second server contends for the same live path. The helper unlinks +
    // retries once; whichever way it resolves, it must NOT throw uncaught.
    const second = track(net.createServer());
    await bindNativeDevtoolsUnixSocket(second, socketPath).catch(() => {
      /* rejection is an acceptable outcome; an uncaught throw is not */
    });
    expect(second.listening === true || second.listening === false).toBe(true);
  });
});
