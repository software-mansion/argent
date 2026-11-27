import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "@argent/registry";
import { networkSecretRedactor } from "../../src/tools/network/network-secrets";
import { networkLogsTool } from "../../src/tools/network/network-logs";
import { networkRequestTool } from "../../src/tools/network/network-request";
import {
  forgetJsCapturesOf,
  jsCapturePayload,
  setJsCapture,
} from "../../src/blueprints/network-inspector";
import { makeNetworkDetailReadScript } from "../../src/utils/debugger/scripts/network-interceptor";
import { __resetTypedSecretsForTesting, noteTypedSecrets } from "../../src/utils/typed-secrets";

/**
 * The secret sources are read from the real filesystem, so each case gets an
 * empty project and home of its own: the developer's `~/.argent/secrets.env`
 * must not decide the result.
 */
let project: string;
let home: string;

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const ctx = (clientSecrets?: Map<string, string>) =>
  ({ artifacts: {}, ...(clientSecrets ? { clientSecrets } : {}) }) as unknown as ToolContext;

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "argent-network-secrets-"));
  project = path.join(root, "project");
  home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  write(path.join(project, "package.json"), "{}");
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.spyOn(process, "cwd").mockReturnValue(project);
  __resetTypedSecretsForTesting();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  __resetTypedSecretsForTesting();
  forgetJsCapturesOf();
});

describe("networkSecretRedactor: which values", () => {
  it("takes every source, a shadowed copy, typed values and the client's, first name first", () => {
    vi.stubEnv("ARGENT_SECRET_FROM_ENV", "env-value-123");
    write(
      path.join(project, ".argent", "secrets.env"),
      "TOKEN=project-token-1\nSHARED=same-value-9\n"
    );
    // The home file's TOKEN is shadowed by the project's, and is still a value the user exposed.
    write(path.join(home, ".argent", "secrets.env"), "TOKEN=home-token-2\n");
    noteTypedSecrets("SIM-1", [{ name: "TYPED", value: "typed-value-3" }]);

    const redact = networkSecretRedactor(ctx(new Map([["CLIENT", "same-value-9"]])));

    expect(redact("env-value-123 project-token-1 home-token-2 typed-value-3 same-value-9")).toBe(
      "{{secret:FROM_ENV}} {{secret:TOKEN}} {{secret:TOKEN}} {{secret:TYPED}} {{secret:CLIENT}}"
    );
  });

  it("applies an edit of a secrets file at the next call", () => {
    const file = path.join(project, ".argent", "secrets.env");
    write(file, "A=first-value-1\n");
    expect(networkSecretRedactor()("first-value-1 second-value-2")).toBe(
      "{{secret:A}} second-value-2"
    );
    write(file, "A=second-value-2\n");
    expect(networkSecretRedactor()("first-value-1 second-value-2")).toBe(
      "first-value-1 {{secret:A}}"
    );
  });
});

describe("the JS layer", () => {
  const MAC = "macos-app-com.example.app";
  const TOKEN = "stored-token-0123456789";

  function jsServices(entry: Record<string, unknown>) {
    setJsCapture(jsCapturePayload(8081, MAC), {
      bundleId: "com.example.app",
      intent: "started",
      mark: { install: null },
      installed: true,
      physicalDeviceId: MAC,
    });
    const detailScript = makeNetworkDetailReadScript("rn-net-1000");
    const evaluate = vi.fn(async (script: string) =>
      JSON.stringify(
        script === detailScript
          ? entry
          : { entries: [{ id: 1, ...entry }], total: 1, interceptorInstalled: true }
      )
    );
    return { debugger: { cdp: { evaluate }, runtimeApp: { appId: "com.example.app" } } };
  }

  it("redacts the log line, both cut bodies and the redirect, and keeps argent's numbers", async () => {
    write(path.join(project, ".argent", "secrets.env"), `TOKEN=${TOKEN}\nPIN=1000\n`);
    const body = `${"x".repeat(990)}${TOKEN}${"y".repeat(3000)}`;
    const services = jsServices({
      requestId: "rn-net-1000",
      state: "complete",
      request: {
        url: `https://api.test/u/${TOKEN}`,
        method: "POST",
        headers: {},
        postData: body,
      },
      response: {
        url: `https://api.test/next?t=${TOKEN}`,
        status: 200,
        headers: {},
        mimeType: `text/x-${TOKEN}`,
      },
      responseBody: body,
    });

    const log = await networkLogsTool.execute!(
      services,
      { device_id: MAC, pageIndex: "latest" } as never,
      ctx()
    );
    expect(log).toContain('{id: rn-net-1000} "POST /u/{{secret:TOKEN}}" 200 OK');
    expect(log).toContain("→ /next");

    const details = (await networkRequestTool.execute!(
      services,
      { device_id: MAC, requestId: "rn-net-1000", includeBody: true } as never,
      ctx()
    )) as {
      requestId: string;
      request: { url: string; postData: string };
      response: { redirectedTo?: string; body: string };
    };
    expect(details.requestId).toBe("rn-net-1000");
    expect(details.request.url).toBe("https://api.test/u/{{secret:TOKEN}}");
    expect(details.response.redirectedTo).toBe("https://api.test/next?t={{secret:TOKEN}}");
    // The app's MIME type in the preview's header is app text too.
    expect(details.response.body).toContain("MIME: text/x-{{secret:TOKEN}}]");
    for (const text of [details.request.postData, details.response.body]) {
      // The preview's own header keeps its numbers, though PIN is 1000.
      expect(text).toMatch(/^\[TRUNCATED: first 1000 chars shown, full size: 4013 chars/);
      expect(text.endsWith(`${"x".repeat(990)}{{secret:TOKEN}}...`)).toBe(true);
      expect(text).not.toContain("stored-");
    }
  });
});
