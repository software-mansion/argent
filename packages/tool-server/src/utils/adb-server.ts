import * as net from "node:net";

/**
 * Run a shell command on a device by talking to the adb *server* directly,
 * without spawning the `adb` binary.
 *
 * Why this exists: measured on a Pixel_9 emulator, `adb -s <serial> shell true`
 * costs ~14 ms of which ~11 ms is spawning the client process — the device
 * round-trip over the server's socket is ~3 ms. The screenshot tool asks the
 * device for its rotation on every Android capture, and on the common (portrait)
 * path that probe was the whole cost of the tool: ~19 ms of probe on a ~7 ms
 * capture. Going straight to the server socket takes the probe to ~8 ms.
 *
 * The wire protocol is adb's own, documented in `SERVICES.TXT` / `OVERVIEW.TXT`
 * of the platform tools and unchanged for well over a decade: every message is
 * a 4-hex-digit length followed by the payload; the server answers `OKAY` or
 * `FAIL` + message. `host:transport:<serial>` selects the device, `shell:<cmd>`
 * runs the command and streams its output until the socket closes.
 *
 * This is NOT a general replacement for `adbShell`. It throws on anything
 * unexpected — server not listening, unknown serial, a `FAIL`, a timeout — and
 * every caller must fall back to the spawned client, which also starts the
 * server when it is down. It also honours the same environment the client does
 * (`ADB_SERVER_SOCKET`, `ANDROID_ADB_SERVER_ADDRESS`, `ANDROID_ADB_SERVER_PORT`)
 * so a relocated server is reached rather than silently bypassed.
 */
export async function adbServerShell(
  serial: string,
  shellCommand: string,
  options: { timeoutMs?: number } = {}
): Promise<string> {
  const { host, port } = adbServerAddress(process.env);
  const timeoutMs = options.timeoutMs ?? 5_000;

  return new Promise<string>((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.setNoDelay(true);

    const chunks: Buffer[] = [];
    let stage: "transport" | "shell" | "output" = "transport";
    let pending = Buffer.alloc(0);
    let settled = false;

    const finish = (err?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value ?? "");
    };
    const timer = setTimeout(
      () => finish(new Error(`adb server shell timed out after ${timeoutMs}ms: ${shellCommand}`)),
      timeoutMs
    );

    const send = (message: string) => {
      const payload = Buffer.from(message, "utf8");
      socket.write(payload.length.toString(16).padStart(4, "0") + message);
    };

    /** Consume one OKAY/FAIL status from `pending`; returns false if incomplete. */
    const takeStatus = (): boolean => {
      if (pending.length < 4) return false;
      const status = pending.subarray(0, 4).toString("latin1");
      if (status === "OKAY") {
        pending = pending.subarray(4);
        return true;
      }
      if (status === "FAIL") {
        if (pending.length < 8) return false;
        const len = parseInt(pending.subarray(4, 8).toString("latin1"), 16);
        if (pending.length < 8 + len) return false;
        finish(new Error(`adb server: ${pending.subarray(8, 8 + len).toString("utf8")}`));
        return false;
      }
      finish(new Error(`adb server: unexpected status ${JSON.stringify(status)}`));
      return false;
    };

    socket.once("connect", () => send(`host:transport:${serial}`));
    socket.on("data", (data: Buffer) => {
      if (stage === "output") {
        chunks.push(data);
        return;
      }
      pending = Buffer.concat([pending, data]);
      if (stage === "transport" && takeStatus()) {
        stage = "shell";
        send(`shell:${shellCommand}`);
      }
      if (stage === "shell" && takeStatus()) {
        stage = "output";
        if (pending.length) chunks.push(pending);
        pending = Buffer.alloc(0);
      }
    });
    socket.once("error", (err) => finish(err));
    socket.once("close", () => {
      if (stage === "output") finish(undefined, Buffer.concat(chunks).toString("utf8"));
      else finish(new Error("adb server closed the connection before answering"));
    });
  });
}

/** Where the adb client would look for its server, from the same env it reads. */
export function adbServerAddress(env: NodeJS.ProcessEnv): { host: string; port: number } {
  // `ADB_SERVER_SOCKET=tcp:host:port` wins, exactly as it does for the client.
  const socketSpec = env.ADB_SERVER_SOCKET;
  if (socketSpec) {
    const m = /^tcp:(?:(.*):)?(\d+)$/.exec(socketSpec.trim());
    if (m) return { host: m[1] || "127.0.0.1", port: Number(m[2]) };
  }
  const port = Number(env.ANDROID_ADB_SERVER_PORT);
  return {
    host: env.ANDROID_ADB_SERVER_ADDRESS?.trim() || "127.0.0.1",
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 5037,
  };
}
