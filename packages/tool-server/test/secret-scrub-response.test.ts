import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { CLIENT_FILE_MARKER, Registry } from "@argent/registry";
import { z } from "zod";
import { createHttpApp } from "../src/http";
import { exposedSecrets, scrubSecretsDeep } from "../src/utils/secrets";

const SECRETS = [{ name: "PASS", value: "hunter2xyz" }];

describe("scrubSecretsDeep", () => {
  it("replaces values in nested strings and keys, leaving other values as they are", () => {
    const scrubbed = scrubSecretsDeep(
      {
        note: 'element matched but its text was "hunter2xyz"',
        tree: [{ label: "hunter2xyz", frame: { x: 0.1 }, checked: true }],
        hunter2xyz: null,
      },
      SECRETS
    );
    expect(scrubbed).toEqual({
      "note": 'element matched but its text was "{{secret:PASS}}"',
      "tree": [{ label: "{{secret:PASS}}", frame: { x: 0.1 }, checked: true }],
      "{{secret:PASS}}": null,
    });
  });

  it("passes client-file directives and non-plain objects through untouched", () => {
    const directive = { [CLIENT_FILE_MARKER]: true, path: "a.png", content: "xhunter2xyzx" };
    const date = new Date(0);
    const scrubbed = scrubSecretsDeep({ files: [directive], at: date }, SECRETS);
    expect(scrubbed.files[0]).toBe(directive);
    expect(scrubbed.at).toBe(date);
  });
});

describe("exposedSecrets", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("collects every source's values and skips ones too short to scrub safely", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "exposed-secrets-"));
    fs.mkdirSync(path.join(dir, ".argent"));
    fs.writeFileSync(path.join(dir, ".argent", "secrets.env"), "FILE_TOKEN=tok-from-file\n");
    const secrets = exposedSecrets({
      env: { ARGENT_SECRET_PASS: "hunter2xyz", ARGENT_SECRET_PIN: "123", OTHER: "nope" },
      homeDir: dir,
    });
    expect(secrets).toEqual(
      expect.arrayContaining([
        { name: "PASS", value: "hunter2xyz" },
        { name: "FILE_TOKEN", value: "tok-from-file" },
      ])
    );
    expect(secrets.map((s) => s.name)).not.toContain("PIN");
  });
});

describe("tool route scrubs exposed secrets from responses", () => {
  afterEach(() => vi.unstubAllEnvs());

  function appWith(execute: () => Promise<unknown>) {
    const registry = new Registry();
    registry.registerTool({ id: "echo", zodSchema: z.object({}), services: () => ({}), execute });
    return createHttpApp(registry).app;
  }

  it("scrubs a result", async () => {
    vi.stubEnv("ARGENT_SECRET_ROUTE_PASS", "route-secret-value");
    const app = appWith(async () => ({ note: 'its text was "route-secret-value"' }));
    const res = await request(app).post("/tools/echo").send({});
    expect(res.status).toBe(200);
    expect(res.body.data.note).toBe('its text was "{{secret:ROUTE_PASS}}"');
  });

  it("scrubs an error", async () => {
    vi.stubEnv("ARGENT_SECRET_ROUTE_PASS", "route-secret-value");
    const app = appWith(async () => {
      throw new Error("field holds route-secret-value");
    });
    const res = await request(app).post("/tools/echo").send({});
    expect(JSON.stringify(res.body)).not.toContain("route-secret-value");
    expect(res.body.error).toContain("{{secret:ROUTE_PASS}}");
  });

  it("scrubs a streamed result line", async () => {
    vi.stubEnv("ARGENT_SECRET_ROUTE_PASS", "route-secret-value");
    const app = appWith(async () => ({ text: "route-secret-value" }));
    const res = await request(app)
      .post("/tools/echo")
      .set("Accept", "application/x-ndjson")
      .send({});
    expect(res.text).not.toContain("route-secret-value");
    expect(res.text).toContain("{{secret:ROUTE_PASS}}");
  });
});
