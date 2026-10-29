import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { redirectHomeTo } from "./helpers/home-redirect.js";

let createToolsClient: typeof import("../src/tools-client.js").createToolsClient;
let TEST_HOME: string;
let restoreHome: () => void;

beforeAll(async () => {
  TEST_HOME = mkdtempSync(join(tmpdir(), "argent-forward-secrets-test-"));
  restoreHome = redirectHomeTo(TEST_HOME);
  vi.resetModules();
  ({ createToolsClient } = await import("../src/tools-client.js"));
});

afterAll(() => {
  restoreHome();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

let server: Server;
let url: string;
let sent: Array<{ url: string; secrets: string | undefined; pad?: string }>;
let project: string;

function readBody(req: IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    req.on("data", () => {});
    req.on("end", () => resolve());
  });
}

beforeEach(async () => {
  sent = [];
  project = mkdtempSync(join(TEST_HOME, "project-"));
  mkdirSync(join(project, ".argent"), { recursive: true });
  writeFileSync(join(project, ".argent", "flags.json"), '{"flags":{"forward-secrets":true}}');
  writeFileSync(
    join(project, ".argent", "secrets.env"),
    "APP_PASSWORD=hunter2\nUNUSED=never-sent\n"
  );
  vi.spyOn(process, "cwd").mockReturnValue(project);

  server = createServer(async (req, res) => {
    await readBody(req);
    const json = (payload: unknown) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.method === "GET" && req.url === "/tools") {
      return json({
        tools: [
          { name: "keyboard", description: "", inputSchema: {} },
          {
            name: "run-flow",
            description: "",
            inputSchema: {},
            fileInputs: [
              { target: "flow_path", path: "${flow_path}", kind: "file", collect: "flow" },
            ],
          },
        ],
      });
    }
    if (req.method === "POST" && req.url === "/upload") return json({ uploadId: "u-1" });
    if (req.method === "POST" && req.url?.startsWith("/tools/")) {
      const header = req.headers["x-argent-client-secrets"];
      sent.push({
        url: req.url,
        secrets: Array.isArray(header) ? header[0] : header,
        pad: req.headers["x-pad"] as string | undefined,
      });
      if (req.headers.accept?.includes("application/x-ndjson")) {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.end(`${JSON.stringify({ event: "result", data: { ok: true } })}\n`);
        return;
      }
      return json({ data: { ok: true } });
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function client(remote = true) {
  return createToolsClient({ baseUrl: async () => ({ url, token: "t", remote }) });
}

/** The secrets the last call sent, decoded; undefined when it sent none. */
function lastSecrets(): Record<string, string> | undefined {
  const header = sent.at(-1)?.secrets;
  return header === undefined
    ? undefined
    : (JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Record<string, string>);
}

describe("forward-secrets", () => {
  it("sends the value of each secret a call names, and only those", async () => {
    await client().callTool("keyboard", { text: "{{secret:APP_PASSWORD}}" });
    expect(lastSecrets()).toEqual({ APP_PASSWORD: "hunter2" });
  });

  it("sends a name spelled with the redundant prefix under the name it resolved to", async () => {
    await client().callTool("keyboard", { text: "{{secret:ARGENT_SECRET_APP_PASSWORD}}" });
    expect(lastSecrets()).toEqual({ APP_PASSWORD: "hunter2" });
  });

  it("sends nothing when the flag is off, the call is local, or names no secret", async () => {
    await client(false).callTool("keyboard", { text: "{{secret:APP_PASSWORD}}" });
    expect(lastSecrets()).toBeUndefined();

    await client().callTool("keyboard", { text: "plain" });
    expect(lastSecrets()).toBeUndefined();

    writeFileSync(join(project, ".argent", "flags.json"), '{"flags":{}}');
    await client().callTool("keyboard", { text: "{{secret:APP_PASSWORD}}" });
    expect(lastSecrets()).toBeUndefined();
    expect(sent).toHaveLength(3);
  });

  it("sends an empty header for a call naming only secrets this machine lacks", async () => {
    await client().callTool("keyboard", { text: "{{secret:NOT_HERE}}" });
    expect(sent.at(-1)?.secrets).toBe("e30=");
  });

  it.each([
    ["http://192.0.2.10:3001", false],
    ["http://[2001:db8::1]:3001", false],
    ["https://192.0.2.10:3001", true],
    ["http://localhost:3001", true],
    ["http://[::1]:3001", true],
  ])("over %s, sends the call naming a secret: %s", async (target, allowed) => {
    const posted: Array<Record<string, string>> = [];
    const fetchImpl = async (to: string, init?: RequestInit): Promise<Response> => {
      if (to.endsWith("/tools/keyboard")) posted.push(init?.headers as Record<string, string>);
      const body = to.endsWith("/tools")
        ? { tools: [{ name: "keyboard", description: "", inputSchema: {} }] }
        : { data: { ok: true } };
      return new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json" },
      });
    };
    const linked = createToolsClient({
      fetchImpl,
      baseUrl: async () => ({ url: target, token: "t", remote: true }),
    });

    const call = linked.callTool("keyboard", { text: "{{secret:APP_PASSWORD}}" });
    if (allowed) {
      await call;
      expect(posted[0]?.["x-argent-client-secrets"]).toBeDefined();
    } else {
      await expect(call).rejects.toThrow(
        "forward-secrets sends secret values only over https:// with the certificate checked, or " +
          `to a loopback address, and ${target} is reached neither over https:// nor at a loopback ` +
          "address, so the call was not sent (it names APP_PASSWORD)."
      );
      expect(posted).toHaveLength(0);
      // A call naming no secret this machine holds still goes.
      await linked.callTool("keyboard", { text: "{{secret:NOT_HERE}}" });
      expect(posted).toHaveLength(1);
      expect(posted[0]?.["x-argent-client-secrets"]).toBe("e30=");
    }
  });

  /** Answers every call with `status`, `headers` and `body`; the listing as usual. */
  function answerCalls(status: number, headers: Record<string, string>, body = ""): void {
    server.removeAllListeners("request");
    server.on("request", (req: IncomingMessage, res) => {
      if (req.url === "/tools") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ tools: [{ name: "keyboard", description: "", inputSchema: {} }] })
        );
        return;
      }
      sent.push({ url: req.url ?? "", secrets: req.headers["x-argent-client-secrets"] as string });
      res.writeHead(status, headers);
      res.end(body);
    });
  }

  it.each([
    [431, {}, ""],
    [400, { "Content-Type": "text/html" }, "<html>400 Request Header Or Cookie Too Large</html>"],
  ])(
    "says a %i that carries no error body refused the forwarded header",
    async (status, headers, body) => {
      answerCalls(status, headers, body);
      await expect(
        client().callTool("keyboard", { text: "{{secret:APP_PASSWORD}}" })
      ).rejects.toThrow(
        `refused the request headers (${status}), as it does when they are too large. ` +
          "The x-argent-client-secrets header carried APP_PASSWORD;"
      );
    }
  );

  it("does not send a header over Node's header limit", async () => {
    writeFileSync(join(project, ".argent", "secrets.env"), `BIG=${"s".repeat(20_000)}\n`);
    await expect(client().callTool("keyboard", { text: "{{secret:BIG}}" })).rejects.toThrow(
      "forward-secrets would send BIG in an x-argent-client-secrets header of 26680 bytes, which takes " +
        "the request headers past the 16384 bytes a tool-server accepts, so the call was not sent."
    );
    expect(sent).toEqual([]);
  });

  it("counts the other request headers against Node's header limit", async () => {
    // Under 16384 bytes on its own, over it with the rest of the head.
    writeFileSync(join(project, ".argent", "secrets.env"), `BIG=${"s".repeat(12_200)}\n`);
    await expect(client().callTool("keyboard", { text: "{{secret:BIG}}" })).rejects.toThrow(
      "header of 16280 bytes, which takes the request headers past the 16384 bytes"
    );
    expect(sent).toEqual([]);
  });

  it("sends the largest secret Node's header limit takes, and none it refuses", async () => {
    const outcomes = new Map<number, string>();
    for (let size = 11_900; size <= 12_050; size += 1) {
      writeFileSync(join(project, ".argent", "secrets.env"), `BIG=${"s".repeat(size)}\n`);
      outcomes.set(
        size,
        await client()
          .callTool("keyboard", { text: "{{secret:BIG}}" })
          .then(
            () => "sent",
            (err: Error) =>
              err.message.includes("so the call was not sent") ? "held" : err.message
          )
      );
    }
    // This server keeps Node's default limit, so a refused head would come back as a 431.
    expect(new Set(outcomes.values())).toEqual(new Set(["sent", "held"]));
    expect(Math.max(...[...outcomes].filter(([, o]) => o === "sent").map(([size]) => size))).toBe(
      11_963
    );
  });

  it.each([
    [431, ""],
    [400, "<html>400 Bad Request</html>"],
  ])("keeps a plain %i for a call that forwards no secret", async (status, body) => {
    answerCalls(status, { "Content-Type": "text/html" }, body);
    await expect(client().callTool("keyboard", { text: "plain" })).rejects.toThrow(
      new RegExp(`^${status} `)
    );
  });

  it("follows a redirect for a call that forwards no secret", async () => {
    const sink = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: { followed: true } }));
    });
    await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
    answerCalls(307, { Location: `http://127.0.0.1:${(sink.address() as AddressInfo).port}/x` });
    try {
      const result = await client().callTool("keyboard", { text: "plain" });
      expect(result.data).toEqual({ followed: true });
    } finally {
      sink.close();
    }
  });

  it("keeps the tool-server's own 400 error", async () => {
    answerCalls(400, { "Content-Type": "application/json" }, JSON.stringify({ error: "bad udid" }));
    await expect(
      client().callTool("keyboard", { text: "{{secret:APP_PASSWORD}}" })
    ).rejects.toThrow(/^bad udid$/);
  });

  it("does not follow a redirect with the secrets", async () => {
    const elsewhere: string[] = [];
    const sink = createServer((req, res) => {
      elsewhere.push(String(req.headers["x-argent-client-secrets"]));
      res.end("{}");
    });
    await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
    answerCalls(307, { Location: `http://127.0.0.1:${(sink.address() as AddressInfo).port}/x` });
    try {
      await expect(
        client().callTool("keyboard", { text: "{{secret:APP_PASSWORD}}" })
      ).rejects.toThrow(
        "The tool-server answered 307 Temporary Redirect to keyboard. forward-secrets"
      );
      expect(elsewhere).toEqual([]);
    } finally {
      sink.close();
    }
  });

  it("does not forward to a URL that does not parse", async () => {
    const { secretsTransportRefusal } = await import("../src/tools-client.js");
    expect(secretsTransportRefusal("127.0.0.1:3001")).toBe("127.0.0.1:3001 is not a URL");
  });

  it.each([
    ["0", "https://192.0.2.10:3001", false],
    ["false", "https://192.0.2.10:3001", true],
    ["1", "https://192.0.2.10:3001", true],
    ["0", "http://127.0.0.1:3001", true],
  ])(
    "with NODE_TLS_REJECT_UNAUTHORIZED=%s, forwards to %s: %s",
    async (setting, target, allowed) => {
      vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", setting);
      const { secretsTransportRefusal } = await import("../src/tools-client.js");
      expect(secretsTransportRefusal(target)).toBe(
        allowed
          ? undefined
          : `NODE_TLS_REJECT_UNAUTHORIZED=0 turns off the certificate check of ${target}`
      );
    }
  );

  it("refuses a call over https whose certificate is not checked", async () => {
    vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    const fetchImpl = vi.fn(async (to: string) =>
      Response.json(
        to.endsWith("/tools")
          ? { tools: [{ name: "keyboard", description: "", inputSchema: {} }] }
          : { data: {} }
      )
    );
    const linked = createToolsClient({
      fetchImpl,
      baseUrl: async () => ({ url: "https://192.0.2.10:3001", token: "t", remote: true }),
    });
    await expect(linked.callTool("keyboard", { text: "{{secret:APP_PASSWORD}}" })).rejects.toThrow(
      "and NODE_TLS_REJECT_UNAUTHORIZED=0 turns off the certificate check of " +
        "https://192.0.2.10:3001, so the call was not sent (it names APP_PASSWORD)."
    );
    expect(fetchImpl.mock.calls.map(([to]) => to)).toEqual(["https://192.0.2.10:3001/tools"]);
  });

  it("sends the caller's headers and counts them against Node's header limit", async () => {
    const pad = { "X-Pad": "p".repeat(200) };
    const padded = () =>
      createToolsClient({
        baseUrl: async () => ({ url, token: "t", remote: true }),
        headers: () => pad,
      });

    await padded().callTool("keyboard", { text: "plain" });
    expect(sent.map((call) => call.pad)).toEqual([pad["X-Pad"]]);

    // The largest secret that fits without the caller's headers.
    writeFileSync(join(project, ".argent", "secrets.env"), `BIG=${"s".repeat(11_963)}\n`);
    await client().callTool("keyboard", { text: "{{secret:BIG}}" });
    expect(sent).toHaveLength(2);

    await expect(padded().callTool("keyboard", { text: "{{secret:BIG}}" })).rejects.toThrow(
      "takes the request headers past the 16384 bytes a tool-server accepts, so the call was not sent."
    );
    expect(sent).toHaveLength(2);
  });

  it("reads the names in a flow file and in a fragment sent through POST /upload", async () => {
    const e2e = join(project, ".argent", "e2e");
    mkdirSync(e2e, { recursive: true });
    writeFileSync(join(project, ".argent", "secrets.env"), "APP_PASSWORD=hunter2\nPIN=4321\n");
    // Over the 256 KiB the call carries inline, so the fragment is uploaded.
    const padding = `${"# padding\n".repeat(30_000)}`;
    writeFileSync(
      join(e2e, "big.yaml"),
      `${padding}steps:\n  - tool: keyboard\n    args: { text: "{{secret:PIN}}" }\n`
    );
    const flowPath = join(e2e, "login.yaml");
    writeFileSync(
      flowPath,
      'steps:\n  - type: { into: { id: pw }, text: "{{secret:APP_PASSWORD}}" }\n  - run: big\n'
    );

    await client().callTool("run-flow", { flow_path: flowPath, project_root: project });

    expect(lastSecrets()).toEqual({ APP_PASSWORD: "hunter2", PIN: "4321" });
  });

  /** A file input as the client sends it over a link. */
  const wire = (fields: Record<string, unknown>) => ({ __argentFileInput: true, ...fields });
  const base64 = (text: string) => Buffer.from(text).toString("base64");

  it("reads names from the YAML file inputs a call runs and their flow members only", async () => {
    writeFileSync(join(project, ".argent", "secrets.env"), "A=1\nB=2\nC=3\nD=4\nE=5\nF=6\nG=7\n");
    await client().callTool("keyboard", {
      yml: wire({ path: "/p/login.yml", content: base64('text: "{{secret:A}}"'), members: [] }),
      upper: wire({
        path: "/p/LOGIN.YAML",
        content: base64('text: "{{secret:B}}"'),
        members: [
          { role: "flow", key: "k1", path: "/p/frag", content: base64('text: "{{secret:C}}"') },
          { role: "tool", key: "k2", path: "/p/arg.yaml", content: base64('text: "{{secret:D}}"') },
          {
            role: "baseline",
            key: "k3",
            path: "/p/b.png",
            content: base64('text: "{{secret:E}}"'),
          },
        ],
      }),
      text: wire({ path: "/p/notes.txt", content: base64('text: "{{secret:F}}"'), members: [] }),
      // A tool that only reads a test, such as e2e-read-prerequisite, sends no members.
      read: wire({ path: "/p/read.yaml", content: base64('text: "{{secret:G}}"') }),
    });
    expect(lastSecrets()).toEqual({ A: "1", B: "2", C: "3" });
  });

  it("reads from disk only an uploaded member, and skips one deleted since", async () => {
    writeFileSync(join(project, ".argent", "secrets.env"), "A=1\nB=2\n");
    const refused = join(project, "refused.yaml");
    writeFileSync(refused, 'steps:\n  - type: { text: "{{secret:B}}" }\n');
    await client().callTool("keyboard", {
      text: "{{secret:A}}",
      flow: wire({
        path: "/p/main.yaml",
        content: base64("steps: []\n"),
        members: [
          { role: "flow", key: "k1", path: refused, canonical: refused, state: "refused" },
          {
            role: "flow",
            key: "k2",
            path: "/p/gone.yaml",
            canonical: join(project, "gone.yaml"),
            uploadId: "u-2",
          },
        ],
      }),
    });
    expect(lastSecrets()).toEqual({ A: "1" });
  });

  it("reads a placeholder that a long YAML string folds, and not one in a comment", async () => {
    writeFileSync(join(project, ".argent", "secrets.env"), "API_KEY=s3cr3t\nOLD=x\n");
    // As serializeFlow writes it: the fold escapes a line break inside the placeholder.
    const text =
      "Login: https://staging.example.com/auth/callback?redirect=/home&s={{secret:API_KEY}}";
    const yaml = `# was {{secret:OLD}}\n${yamlStringify({ steps: [{ type: { text } }] }, { blockQuote: false })}`;
    expect(yaml).not.toContain("{{secret:API_KEY}}");
    await client().callTool("keyboard", {
      flow: wire({ path: "/p/login.yaml", content: base64(yaml), members: [] }),
    });
    expect(lastSecrets()).toEqual({ API_KEY: "s3cr3t" });
  });

  it("reads a test whose YAML aliases loop back on themselves", async () => {
    writeFileSync(join(project, ".argent", "secrets.env"), "API_KEY=s3cr3t\n");
    const yaml =
      'steps: &s\n  - type: { into: { id: pw }, text: "{{secret:API_KEY}}" }\n' +
      "  - when: { visible: { text: Retry } }\n    steps: *s\n";
    await client().callTool("keyboard", {
      flow: wire({ path: "/p/retry.yaml", content: base64(yaml), members: [] }),
    });
    expect(lastSecrets()).toEqual({ API_KEY: "s3cr3t" });
  }, 10_000);

  it("parses each file as the runner does: trimmed, quietly, skipping one that does not parse", async () => {
    writeFileSync(join(project, ".argent", "secrets.env"), "A=1\nB=2\nC=3\n");
    const warn = vi.spyOn(process, "emitWarning");
    await client().callTool("keyboard", {
      flow: wire({
        path: "/p/main.yaml",
        content: base64('steps:\n  - echo: !custom hi\n  - type: { text: "{{secret:A}}" }\n'),
        members: [
          {
            role: "flow",
            key: "k1",
            content: base64('\tsteps:\n  - type: { text: "{{secret:B}}" }\n'),
          },
          { role: "flow", key: "k2", content: base64('steps: [ { text: "{{secret:C}}" }\n') },
        ],
      }),
    });
    expect(lastSecrets()).toEqual({ A: "1", B: "2" });
    expect(warn).not.toHaveBeenCalled();
  });
});
