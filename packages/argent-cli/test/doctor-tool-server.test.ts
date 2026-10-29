import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolsServerPaths } from "@argent/tools-client";
import type { DoctorContext } from "../src/doctor-shared.js";

const fake = vi.hoisted(() => ({
  home: "",
  state: null as Record<string, unknown> | null,
  stateBundle: "" as string | undefined,
  alive: false,
  healthy: vi.fn(async (..._args: unknown[]) => false),
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => fake.home || actual.homedir() };
});

vi.mock("@argent/tools-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@argent/tools-client")>()),
  readToolsServerState: async (bundlePath?: string) => {
    fake.stateBundle = bundlePath;
    return fake.state;
  },
  readAllToolsServerStates: async () => [],
  isToolsServerProcessAlive: () => fake.alive,
  isToolsServerHealthy: (...args: unknown[]) => fake.healthy(...args),
}));

import {
  entryRemoteChecks,
  redactUrl,
  remoteCheck,
  stopCommand,
  toolServerSection,
} from "../src/doctor-tool-server.js";

describe("remoteCheck", () => {
  it("tells a rejected token apart from a dead server", () => {
    expect(remoteCheck(200, "http://h:1", "link").status).toBe("ok");
    expect(remoteCheck(401, "http://h:1", "link").label).toMatch(/rejects the token/);
    expect(remoteCheck(null, "http://h:1", "link").label).toMatch(/unreachable/);
  });

  it("blames the host name, not the token, for a 403", () => {
    const result = remoteCheck(403, "http://h:1", "link");
    expect(result.status).toBe("error");
    expect(result.label).toMatch(/refuses this host name/);
    expect(result.fix).toMatch(/argent server start --host/);
    expect(result.fix).not.toMatch(/ARGENT_HOST/);
  });

  it("fails on a rejected token", () => {
    expect(remoteCheck(401, "http://h:1", "env").status).toBe("error");
    expect(remoteCheck(401, "http://h:1", "link").status).toBe("error");
  });

  it("spells fix commands the way this install runs argent", () => {
    expect(remoteCheck(null, "http://h:1", "link", "npx argent").fix).toMatch(/npx argent unlink/);
    expect(remoteCheck(401, "http://h:1", "link", "npx argent").fix).toMatch(/npx argent link/);
  });

  it("doesn't suggest argent unlink when the URL comes from ARGENT_TOOLS_URL", () => {
    expect(remoteCheck(null, "http://h:1", "env").fix).toMatch(/unset ARGENT_TOOLS_URL/);
    expect(remoteCheck(null, "http://h:1", "link").fix).toMatch(/argent unlink/);
  });
});

describe("remote tool-server", () => {
  it("does not call a non-2xx answer reachable", () => {
    const result = remoteCheck(404, "http://h:1/", "env");
    expect(result.status).toBe("error");
    expect(result.label).toMatch(/HTTP 404/);
  });

  it("never prints a token from the URL", () => {
    expect(redactUrl("argent://secret-token@127.0.0.1:47611")).not.toContain("secret-token");
    expect(remoteCheck(null, "http://user:pw@h:1", "env").label).not.toMatch(/user|pw/);
    expect(redactUrl("http://h:1/")).toBe("http://h:1/");
  });
});

describe("stopCommand", () => {
  const pkg = path.join(path.sep, "opt", "npx-cache", "node_modules", "@swmansion", "argent");
  const paths = (installKind?: "local" | "global") => ({
    bundlePath: path.join(pkg, "dist", "tool-server.cjs"),
    simulatorServerDir: path.join(pkg, "bin"),
    nativeDevtoolsDir: path.join(pkg, "dylibs"),
    installKind,
  });
  const ctx = (global: DoctorContext["global"]): DoctorContext => ({
    projectRoot: path.sep,
    cwd: path.sep,
    mode: "global",
    global,
    argentCmd: "argent",
    installCmd: "npm install",
    offPathGlobalBin: null,
  });

  it("uses the global argent only when it is the copy that owns the server", () => {
    const owner = { bin: "/usr/local/bin/argent", root: pkg, version: "1.0.0" };
    expect(stopCommand(ctx(owner), paths("global"))).toBe("argent");
  });

  it("runs the exact copy otherwise (an npx cache, an off-PATH global)", () => {
    const other = { bin: "/usr/local/bin/argent", root: "/usr/local/lib/argent", version: "1" };
    const cli = path.join(pkg, "dist", "cli.js");
    expect(stopCommand(ctx(other), paths("global"))).toBe(`node ${cli}`);
    expect(stopCommand(ctx(null), paths())).toBe(`node ${cli}`);
  });
});

describe("redactUrl on strings that don't parse", () => {
  it("hides what comes before an @", () => {
    expect(redactUrl("deadbeefcafe0123@127.0.0.1:47611")).toBe("***@127.0.0.1:47611");
    expect(redactUrl("http://user:SECRETPW@127.0.0.1:99999")).toBe("http://***@127.0.0.1:99999");
  });

  it("hides a token query parameter", () => {
    expect(redactUrl("http://h:1/?token=SECRET")).not.toContain("SECRET");
    expect(redactUrl("http://h:99999/?token=SECRET")).not.toContain("SECRET");
  });
});

describe("remote status probe", () => {
  const servers: Array<http.Server | net.Server> = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  async function listen<T extends http.Server | net.Server>(server: T): Promise<string> {
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  }

  it("reports the status the server answers", async () => {
    const url = await listen(http.createServer((_req, res) => res.writeHead(401).end()));
    const [result] = await entryRemoteChecks([{ editor: "Cursor", url }], "argent");
    expect(result?.label).toMatch(/rejects the token \(HTTP 401\)/);
  });

  it("names an entry whose remote uses a variable this shell can't fill in", async () => {
    const [result] = await entryRemoteChecks(
      [{ editor: "Claude Code", url: "${ARGENT_TOOLS_URL}", unresolved: "ARGENT_TOOLS_URL" }],
      "argent"
    );
    expect(result).toMatchObject({
      status: "info",
      label:
        "Claude Code entry: its env ARGENT_TOOLS_URL uses a variable this shell does not set, not verified",
      detail: "${ARGENT_TOOLS_URL}",
    });
  });

  it("gives up on a server that accepts and never answers", async () => {
    const url = await listen(net.createServer(() => {}));
    const started = Date.now();
    const [result] = await entryRemoteChecks([{ editor: "Cursor", url }], "argent");
    expect(result?.label).toMatch(/unreachable/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("drops the connection instead of leaving an unread body open", async () => {
    let socketClosed!: Promise<void>;
    const url = await listen(
      http.createServer((req, res) => {
        socketClosed = new Promise((resolve) => req.socket.on("close", () => resolve()));
        res.writeHead(200);
        res.write("partial body that never ends");
      })
    );
    await entryRemoteChecks([{ editor: "Cursor", url }], "argent");
    await expect(
      Promise.race([
        socketClosed.then(() => "closed"),
        new Promise((resolve) => setTimeout(() => resolve("open"), 1_000)),
      ])
    ).resolves.toBe("closed");
  });
});

describe("toolServerSection", () => {
  const paths = {
    bundlePath: "/pkg/dist/tool-server.cjs",
    installKind: "global",
  } as ToolsServerPaths;
  const ctx = { projectRoot: "/proj", argentCmd: "argent" } as DoctorContext;
  const notLinked = { url: null, token: null, source: null } as unknown as Parameters<
    typeof toolServerSection
  >[3];

  beforeEach(() => {
    fake.home = fs.mkdtempSync(path.join(os.tmpdir(), "argent-doctor-home-"));
    fake.state = null;
    fake.alive = false;
    fake.healthy.mockReset();
    fake.healthy.mockResolvedValue(false);
  });

  afterEach(() => {
    fs.chmodSync(fake.home, 0o755);
    fs.rmSync(fake.home, { recursive: true, force: true });
    fake.home = "";
    vi.unstubAllEnvs();
  });

  const labels = async () =>
    (await toolServerSection(ctx, "0.30.0", paths, notLinked)).checks.map((c) => c.label);

  it("passes the state file's token to the health check", async () => {
    fake.state = { pid: 4242, port: 47391, host: "127.0.0.1", token: "tok", version: "0.30.0" };
    fake.alive = true;
    fake.healthy.mockResolvedValue(true);
    expect(await labels()).toEqual(["Running http://127.0.0.1:47391 (pid 4242)"]);
    expect(fake.healthy).toHaveBeenCalledWith(47391, "127.0.0.1", 2_000, "tok");
  });

  it("reports a state file with fields of the wrong type instead of crashing", async () => {
    fake.state = { pid: 99999, port: 1, host: 5 };
    expect(await labels()).toEqual([
      "Unreadable state file (pid, port or host has the wrong type)",
    ]);
  });

  it("does not warn about a wildcard ARGENT_HOST, which is dialed on loopback", async () => {
    fake.state = { pid: 999999, port: 47391, host: "127.0.0.1" };
    vi.stubEnv("ARGENT_HOST", "0.0.0.0");
    expect(await labels()).toEqual(["Stale state file (pid 999999 gone)"]);
    vi.stubEnv("ARGENT_HOST", "192.168.1.5");
    expect((await labels())[0]).toMatch(/while ARGENT_HOST=192.168.1.5 is set/);
  });

  it("trims ARGENT_HOST the way the spawned server does", async () => {
    fake.state = { pid: 999999, port: 47391, host: "127.0.0.1" };
    for (const value of ["127.0.0.1 ", " "]) {
      vi.stubEnv("ARGENT_HOST", value);
      expect(await labels()).toEqual(["Stale state file (pid 999999 gone)"]);
    }
  });

  it("checks a local-mode project's own server when a global argent runs doctor", async () => {
    const projectRoot = path.join(fake.home, "proj");
    const pkg = path.join(projectRoot, "node_modules", "@swmansion", "argent");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "package.json"), "{}");
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "@swmansion/argent", version: "0.27.0" })
    );
    fake.alive = true;
    fake.healthy.mockResolvedValue(true);
    fake.state = { pid: 4242, port: 47391, host: "127.0.0.1", version: "0.26.0" };
    const localCtx = { ...ctx, projectRoot, mode: "local" } as DoctorContext;
    const [running] = (await toolServerSection(localCtx, "0.30.0", paths, notLinked)).checks;
    expect(fake.stateBundle).toBe(path.join(fs.realpathSync(pkg), "dist", "tool-server.cjs"));
    expect(running).toMatchObject({
      status: "warn",
      label: expect.stringMatching(/from v0\.26\.0$/),
      fix: expect.stringMatching(/^npx argent server stop/),
    });
    fake.state = { ...fake.state, version: "0.27.0" };
    expect((await toolServerSection(localCtx, "0.30.0", paths, notLinked)).checks[0]?.status).toBe(
      "ok"
    );
  });

  it("points at server stop for a wedged server that tool calls won't replace", async () => {
    fake.alive = true;
    fake.state = { pid: 4242, port: 47391, host: "127.0.0.1", managed: "cli" };
    const [wedged] = (await toolServerSection(ctx, "0.30.0", paths, notLinked)).checks;
    expect(wedged).toMatchObject({ status: "warn", fix: "node /pkg/dist/cli.js server stop" });
    fake.state = { ...fake.state, managed: "autospawn" };
    expect(await labels()).toEqual(["Stale state file (pid 4242 unhealthy)"]);
  });

  it("notes that a link from this shell's env may not reach every editor", async () => {
    const server = http.createServer((_req, res) => res.writeHead(200).end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
      const linked = { url, token: "t", source: "env" } as Parameters<typeof toolServerSection>[3];
      const [result] = (await toolServerSection(ctx, "0.30.0", paths, linked)).checks;
      expect(result).toMatchObject({ status: "ok", detail: expect.stringMatching(/Codex/) });
    } finally {
      server.close();
    }
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "does not promise an automatic start when ~/.argent is not writable",
    async () => {
      const argentDir = path.join(fake.home, ".argent");
      fs.mkdirSync(argentDir, { mode: 0o555 });
      try {
        const section = await toolServerSection(ctx, "0.30.0", paths, notLinked);
        expect(section.checks.map((c) => c.label)).toEqual([
          "~/.argent is not writable, so no tool-server can start",
          "Not running",
        ]);
        fake.state = { pid: 999999, port: 47391 };
        const stale = await toolServerSection(ctx, "0.30.0", paths, notLinked);
        expect(stale.checks[1]?.detail).toBe("fix ~/.argent above first");
      } finally {
        fs.chmodSync(argentDir, 0o755);
      }
    }
  );
});
